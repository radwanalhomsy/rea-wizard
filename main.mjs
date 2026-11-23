import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import * as cloneStore from './cloneStore.mjs'
import * as cloneSpec from './cloneSpec.mjs'
import * as cloneFacts from './cloneFacts.mjs'
import * as cloneFidelity from './cloneFidelity.mjs'
import * as cloneCapture from './cloneCapture.mjs'
import * as cloneExplore from './cloneExplore.mjs'
import * as cloneFormats from './cloneFormats.mjs'
import * as cloneProtocol from './cloneProtocol.mjs'
import * as cloneIR from './cloneIR.mjs'
import * as cloneOracle from './cloneOracle.mjs'
import * as cloneRepair from './cloneRepair.mjs'
import * as cloneGaps from './cloneGaps.mjs'
import * as cloneRecipes from './cloneRecipes.mjs'
import * as cloneFingerprint from './cloneFingerprint.mjs'
import * as cloneAuto from './cloneAuto.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || ''
const APPDATA = process.env.APPDATA || ''
const OPENCODE_EXE = path.join(APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
const OPENCODE_PKG = path.join(APPDATA, 'npm', 'node_modules', 'opencode-ai', 'package.json')
const OPENCODE_CONFIG = path.join(HOME, '.config', 'opencode', 'opencode.jsonc')
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')
const DEFAULT_PORT = 4096

let win = null
let client = null
let settings = { workspace: 'D:\\REA', model: null, agent: null, recent: [], port: DEFAULT_PORT }
let server = { phase: 'idle', url: null, reused: false, error: null, version: null, pid: null, port: null }
let serverProc = null
let eventAbort = null

/* ---------------------------------------------------------------- settings */

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    settings = { ...settings, ...raw }
  } catch { /* first run */ }
  if (!settings.workspace || !fs.existsSync(settings.workspace)) {
    const candidates = ['D:\\REA', HOME, process.cwd()]
    settings.workspace = candidates.find((p) => p && fs.existsSync(p)) || HOME || process.cwd()
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) { console.error('settings save failed', e) }
}

/* --------------------------------------------------------------- jsonc util */

function parseJsonc(text) {
  let out = ''
  let i = 0
  let inStr = false
  let quote = ''
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote) inStr = false
      i++
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue }
    out += c
    i++
  }
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(out)
}

function readOpencodeConfig() {
  try { return parseJsonc(fs.readFileSync(OPENCODE_CONFIG, 'utf8')) } catch { return null }
}

function reaEnvironment() {
  const cfg = readOpencodeConfig()
  const env = cfg?.mcp?.rea?.environment
  const out = env && typeof env === 'object' ? { ...env } : {}
  // The app-level registration wins for CLI calls so a valid IDA Home/Pro
  // bridge can be tested here before the agent's MCP process is restarted.
  if (settings.idaMcpConfig && fs.existsSync(settings.idaMcpConfig)) {
    out.REA_IDA_MCP_CONFIG = settings.idaMcpConfig
  }
  return out
}

/* ---------------------------------------------------------------- ida free */

const IDA_EXE_NAMES = ['ida.exe', 'ida64.exe', 'idat.exe', 'idat64.exe']
const IDA_SEARCH_ROOTS = [
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'D:\\Program Files',
  'D:\\Program Files (x86)',
  'D:\\',
  'C:\\',
]

/** Find an installed IDA by scanning the usual install roots one level deep. */
function detectIda() {
  for (const root of IDA_SEARCH_ROOTS) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^IDA\b/i.test(entry.name)) continue
      const dir = path.join(root, entry.name)
      for (const name of IDA_EXE_NAMES) {
        const exe = path.join(dir, name)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  return null
}

function idaEdition(exe) {
  if (/IDA[\s_-]*Free/i.test(exe)) return 'free'
  if (/IDA[\s_-]*Home/i.test(exe)) return 'home'
  if (/IDA[\s_-]*Pro/i.test(exe)) return 'pro'
  if (/IDA[\s_-]*Classroom/i.test(exe)) return 'classroom'
  return 'unknown'
}

/** What this edition can actually automate. Free/Home lack -S, Python and idalib. */
function idaAutomation(exe, edition) {
  const dir = path.dirname(exe)
  const has = (rel) => fs.existsSync(path.join(dir, rel))
  const pluginDirs = [path.join(dir, 'plugins'), path.join(APPDATA, 'Hex-Rays', 'IDA Pro', 'plugins')]
  return {
    script: edition === 'pro' || edition === 'unknown',
    python: has('python3.dll') || has('python311.dll') || has('python312.dll') || has('idapyswitch.exe') || has('python'),
    idalib: has('idalib') || has('python\\idalib'),
    mcpPlugin: pluginDirs.some((d) => fs.existsSync(path.join(d, 'ida-mcp')) || fs.existsSync(path.join(d, 'ida_mcp_plugin.py'))),
  }
}

function idaMcpConfigPath() {
  return settings.idaMcpConfig || process.env.REA_IDA_MCP_CONFIG || reaEnvironment().REA_IDA_MCP_CONFIG || null
}

/** Mirror REA's registration rules: stdio command/args or local http url. */
function inspectIdaRegistration(file) {
  if (!file) return { path: null, configured: false, valid: false, transport: null, mode: null, error: null }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const reg = raw?.mcpServers?.['ida-pro-mcp'] ?? raw
    const transport = typeof reg?.command === 'string' && reg.command ? 'stdio' : typeof reg?.url === 'string' && reg.url ? 'http' : null
    if (!transport) {
      return { path: file, configured: true, valid: false, transport: null, mode: null, error: 'Registration needs a command/args pair or a local url.' }
    }
    if (transport === 'http' && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|host\.containers\.internal)(:|\/)/i.test(reg.url)) {
      return { path: file, configured: true, valid: false, transport, mode: null, error: 'HTTP registration must point at a local loopback endpoint.' }
    }
    const mode = reg.mode === 'headless' ? 'headless' : 'attached'
    return { path: file, configured: true, valid: true, transport, mode, error: null }
  } catch (e) {
    return { path: file, configured: true, valid: false, transport: null, mode: null, error: e.message }
  }
}

function idaStatus() {
  const configured = typeof settings.idaPath === 'string' && settings.idaPath ? settings.idaPath : null
  const exe = configured && fs.existsSync(configured) ? configured : detectIda()
  if (!exe) {
    return { ok: true, path: null, dir: null, edition: null, source: null, automation: null, mcp: inspectIdaRegistration(idaMcpConfigPath()), stale: false }
  }
  const edition = idaEdition(exe)
  return {
    ok: true,
    path: exe,
    dir: path.dirname(exe),
    edition,
    source: configured && exe === configured ? 'settings' : 'detected',
    stale: Boolean(configured && exe !== configured),
    automation: idaAutomation(exe, edition),
    mcp: inspectIdaRegistration(idaMcpConfigPath()),
  }
}

/* -------------------------------------------------------------- server boot */

function broadcastStatus() {
  win?.webContents.send('oc:status', { ...server })
}

function setPhase(phase, patch = {}) {
  server = { ...server, ...patch, phase }
  broadcastStatus()
}

async function probe(url, ms = 1500) {
  try {
    const res = await fetch(url + '/session', { signal: AbortSignal.timeout(ms) })
    return res.ok
  } catch { return false }
}

// A port can be held by a listener that accepts connections but never answers
// (e.g. an orphaned socket left behind by a crashed process). Such a port is
// unusable even though bind() may still succeed, so we test both: probe the
// existing server first, then look for a port we can actually bind.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function pickPort(start, tries = 25) {
  for (let p = start; p < start + tries; p++) {
    if (await portFree(p)) return p
  }
  return null
}

function opencodeVersion() {
  try { return JSON.parse(fs.readFileSync(OPENCODE_PKG, 'utf8')).version || null } catch { return null }
}

function waitForServerUrl(proc, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { cleanup(); reject(new Error('OpenCode server did not report a URL within ' + Math.round(timeoutMs / 1000) + 's')) }, timeoutMs)
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/)
      if (m) { cleanup(); resolve(m[0]) }
    }
    const onExit = (code) => { cleanup(); reject(new Error('OpenCode server exited with code ' + code)) }
    function cleanup() {
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      proc.off('exit', onExit)
    }
    proc.stdout?.on('data', onData)
    proc.on('exit', onExit)
  })
}

async function startServer() {
  setPhase('starting', { error: null })
  const preferred = Number(settings.port) || DEFAULT_PORT
  const base = `http://127.0.0.1:${preferred}`
  if (await probe(base)) {
    setPhase('ready', { url: base, reused: true, version: opencodeVersion(), port: preferred })
    return
  }
  if (!fs.existsSync(OPENCODE_EXE)) {
    setPhase('error', { error: 'OpenCode executable not found at ' + OPENCODE_EXE })
    return
  }
  // The preferred port may be held by a dead/unresponsive listener. Move to the
  // next bindable port instead of failing with "server not running".
  const port = await pickPort(preferred)
  if (!port) {
    setPhase('error', { error: `No free port available in ${preferred}-${preferred + 24}` })
    return
  }
  if (port !== preferred) console.warn(`[opencode] port ${preferred} unavailable, using ${port}`)
  const env = { ...process.env, ...reaEnvironment() }
  const proc = spawn(OPENCODE_EXE, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  serverProc = proc
  proc.stderr?.on('data', (d) => {
    const s = d.toString().trim()
    if (s && !/OPENCODE_SERVER_PASSWORD/.test(s)) console.error('[opencode]', s)
  })
  proc.on('exit', (code) => {
    if (serverProc === proc) {
      serverProc = null
      if (server.phase === 'ready') setPhase('error', { error: 'OpenCode server stopped (exit ' + code + ')' })
    }
  })
  try {
    const url = await waitForServerUrl(proc)
    for (let i = 0; i < 40; i++) {
      if (await probe(url, 1000)) {
        setPhase('ready', { url, reused: false, pid: proc.pid, version: opencodeVersion(), port })
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    setPhase('error', { error: 'OpenCode server reported ' + url + ' but did not answer' })
  } catch (e) {
    setPhase('error', { error: e.message })
  }
}

function makeClient() {
  client = createOpencodeClient({
    baseUrl: server.url,
    directory: settings.workspace,
    throwOnError: false,
  })
}

async function subscribeEvents() {
  if (!client) return
  try {
    eventAbort?.abort()
    eventAbort = new AbortController()
    const { stream } = await client.event.subscribe({ signal: eventAbort.signal })
    for await (const event of stream) {
      win?.webContents.send('oc:event', event)
    }
  } catch (e) {
    if (!eventAbort?.signal.aborted) {
      win?.webContents.send('oc:event', { type: 'app.stream-error', properties: { message: String(e?.message || e) } })
    }
  }
}

/* -------------------------------------------------------------------- doctor */

function resolveRea() {
  const cfg = readOpencodeConfig()
  const cmd = cfg?.mcp?.rea?.command
  if (Array.isArray(cmd) && cmd.length >= 2) {
    const [exe, script] = cmd
    if (/\.(mjs|js)$/i.test(script) && fs.existsSync(script)) return { exe, script }
  }
  return null
}

/* ------------------------------------------------------- clone replay args */

function buildReplayArgs(project, index, request, requestPath) {
  const fmt = ['--format', 'json']
  const input = request || {}
  switch (index.provider) {
    case 'capture_browser_scenario':
      return ['capture-browser-scenario', requestPath, ...fmt]
    case 'capture_electron_scenario':
      return ['capture-electron-scenario', requestPath, ...fmt]
    case 'capture_process_scenario':
      return ['capture-process', requestPath, ...fmt]
    case 'capture_native_ui_scenario': {
      const target = input.path || project.target?.path
      if (!target) throw new Error('Native UI replay needs a target executable path on the project')
      const args = ['capture-native-ui-scenario', target, '--steps', JSON.stringify(input.steps || [])]
      if (input.pid) args.push('--pid', String(input.pid))
      if (input.window_id) args.push('--window-id', String(input.window_id))
      if (input.max_nodes) args.push('--max-nodes', String(input.max_nodes))
      return [...args, ...fmt]
    }
    case 'observe_web_session': {
      if (!input.cdp_endpoint || !input.target_id) {
        throw new Error('Web session replay needs cdp_endpoint and target_id')
      }
      return ['observe-web-session', input.cdp_endpoint, String(input.target_id), ...fmt]
    }
    default:
      throw new Error(`No CLI replay path for ${index.provider}`)
  }
}

/* ------------------------------------------------------------- rea cli bridge */

function reaSpawn(args) {
  const env = { ...process.env, ...reaEnvironment() }
  const rea = resolveRea()
  if (rea) return spawn(rea.exe, [rea.script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  const quoted = args.map((a) => (/[\s"]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a))).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `npx -y rea-agents@6.9.0 ${quoted}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
}

let activeConsoleChild = null
const canceledChildren = new WeakSet()

function runRea(args, { timeoutMs = 180000, tag = null } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = reaSpawn(args) } catch (e) { resolve({ ok: false, code: null, stdout: '', stderr: e.message }); return }
    let out = ''
    let err = ''
    let done = false
    let canceled = false
    if (tag === 'console') activeConsoleChild = child
    const finish = (result) => {
      if (done) return
      done = true
      if (tag === 'console' && activeConsoleChild === child) activeConsoleChild = null
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      finish({ ok: false, code: null, stdout: out, stderr: err + '\n[timed out after ' + Math.round(timeoutMs / 1000) + 's]' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      const s = d.toString()
      out += s
      if (tag) win?.webContents.send('rea:log', { tag, stream: 'out', chunk: s })
    })
    child.stderr?.on('data', (d) => {
      const s = d.toString()
      err += s
      if (tag) win?.webContents.send('rea:log', { tag, stream: 'err', chunk: s })
    })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: null, stdout: out, stderr: err + e.message }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const wasCanceled = canceledChildren.has(child)
      canceledChildren.delete(child)
      finish({ ok: !wasCanceled && code === 0, code, canceled: wasCanceled, stdout: out, stderr: err + (wasCanceled ? '\n[canceled]' : '') })
    })
  })
}

function parseJsonLoose(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

const reaCache = { workflows: { at: 0, data: null }, capabilities: { at: 0, data: null }, commands: { at: 0, data: null } }

async function reaWorkflows(force = false) {
  const c = reaCache.workflows
  if (!force && c.data && Date.now() - c.at < 5 * 60 * 1000) return { ok: true, workflows: c.data }
  const r = await runRea(['guided-workflows', '--format', 'json'], { timeoutMs: 120000 })
  const json = parseJsonLoose(r.stdout)
  if (!json?.workflows) return { ok: false, error: (r.stderr || r.stdout || 'no workflow list').slice(0, 1200) }
  c.data = json.workflows
  c.at = Date.now()
  return { ok: true, workflows: c.data }
}

async function reaCapabilities(force = false) {
  const c = reaCache.capabilities
  if (!force && c.data && Date.now() - c.at < 60 * 1000) return { ok: true, report: c.data }
  const r = await runRea(['capabilities', '--format', 'json'], { timeoutMs: 180000 })
  const json = parseJsonLoose(r.stdout)
  if (!json?.capabilities) return { ok: false, error: (r.stderr || r.stdout || 'no capability report').slice(0, 1200) }
  c.data = json
  c.at = Date.now()
  return { ok: true, report: json }
}

async function reaCommands(force = false) {
  const c = reaCache.commands
  if (!force && c.data && Date.now() - c.at < 10 * 60 * 1000) return { ok: true, text: c.data }
  const r = await runRea(['--llms'], { timeoutMs: 120000 })
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'no command manifest').slice(0, 1200) }
  c.data = r.stdout
  c.at = Date.now()
  return { ok: true, text: c.data }
}

async function runDoctor() {
  const r = await runRea(['doctor', '--client', 'opencode', '--json'], { timeoutMs: 240000 })
  const report = parseJsonLoose(r.stdout)
  if (report) return { ok: true, code: r.code, report }
  return { ok: false, code: r.code, error: (r.stderr || r.stdout || 'doctor produced no JSON').slice(0, 2000) }
}

/* -------------------------------------------------------------- attachments */

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.c', '.h', '.cpp', '.hpp', '.rs', '.go', '.java', '.kt', '.swift', '.xml', '.yaml', '.yml', '.log', '.ini', '.cfg', '.conf', '.csv', '.tsv', '.html', '.htm', '.css', '.scss', '.sh', '.ps1', '.bat', '.cmd', '.toml', '.sql', '.gradle', '.pro', '.map', '.plist', '.strings', '.smali'])
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.har': 'application/json', '.pcap': 'application/vnd.tcpdump.pcap', '.pcapng': 'application/vnd.tcpdump.pcap',
}

function buildParts(text, files) {
  const parts = []
  if (text) parts.push({ type: 'text', text })
  for (const p of Array.isArray(files) ? files : []) {
    if (typeof p !== 'string' || !p) continue
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      const ext = path.extname(p).toLowerCase()
      if (TEXT_EXT.has(ext) && st.size <= 300000) {
        const content = fs.readFileSync(p, 'utf8')
        parts.push({ type: 'text', text: `Attached file ${p}:\n\`\`\`${ext.replace('.', '') || 'text'}\n${content}\n\`\`\`` })
      } else if (st.size <= 12000000) {
        const mime = MIME[ext] || 'application/octet-stream'
        parts.push({
          type: 'file',
          mime,
          filename: path.basename(p),
          url: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`,
        })
      } else {
        parts.push({ type: 'text', text: `(Attachment ${p} skipped: ${(st.size / 1e6).toFixed(1)} MB exceeds the 12 MB limit)` })
      }
    } catch (e) {
      parts.push({ type: 'text', text: `(Attachment ${p} could not be read: ${e.message})` })
    }
  }
  return parts
}

/* --------------------------------------------------------------------- ipc */

function registerIpc() {
  ipcMain.handle('app:state', () => ({
    server: { ...server },
    workspace: settings.workspace,
    model: settings.model,
    agent: settings.agent,
    configPath: OPENCODE_CONFIG,
    settingsPath: SETTINGS_PATH,
    idaPath: settings.idaPath || detectIda(),
    idaMcpConfig: settings.idaMcpConfig || null,
  }))

  ipcMain.handle('app:setWorkspace', (_e, dir) => {
    if (typeof dir !== 'string' || !fs.existsSync(dir)) return { ok: false, error: 'Directory does not exist' }
    settings.workspace = dir
    saveSettings()
    if (server.phase === 'ready') { makeClient(); subscribeEvents() }
    return { ok: true, workspace: dir }
  })

  ipcMain.handle('dialog:file', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || 'Select a target file',
      defaultPath: settings.workspace,
      properties: ['openFile'],
      filters: opts.filters?.length ? opts.filters : [{ name: 'All files', extensions: ['*'] }],
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:folder', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Select a folder', defaultPath: settings.workspace, properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('path:check', (_e, p) => {
    try {
      const st = fs.statSync(p)
      return { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size }
    } catch { return { exists: false } }
  })

  ipcMain.handle('rea:health', async () => {
    const env = reaEnvironment()
    const ghidra = env.GHIDRA_INSTALL_DIR || process.env.GHIDRA_INSTALL_DIR || null
    const java = env.JAVA_HOME || process.env.JAVA_HOME || null
    let mcp = null
    try { const r = await client.mcp.status(); mcp = r?.data ?? r } catch (e) { mcp = { error: String(e?.message || e) } }
    return {
      env,
      ghidra: ghidra ? { path: ghidra, exists: fs.existsSync(ghidra), decompiler: fs.existsSync(path.join(ghidra, 'Ghidra', 'Features', 'Decompiler', 'os', 'win_x86_64', 'decompile.exe')) } : null,
      java: java ? { path: java, exists: fs.existsSync(java) } : null,
      mcp,
      server: { ...server },
    }
  })

  ipcMain.handle('rea:doctor', () => runDoctor())

  ipcMain.handle('rea:run', async (_e, { args = [], timeoutMs, format, tokenLimit, tokenOffset, tokenCount, fullOutput, filterOutput, timings, tag } = {}) => {
    if (!Array.isArray(args) || args.length === 0) return { ok: false, error: 'No REA command supplied' }
    const argv = args.map(String)
    if (format) argv.push('--format', String(format))
    if (tokenLimit) argv.push('--token-limit', String(tokenLimit))
    if (tokenOffset) argv.push('--token-offset', String(tokenOffset))
    if (tokenCount) argv.push('--token-count')
    if (fullOutput) argv.push('--full-output')
    if (filterOutput) argv.push('--filter-output', String(filterOutput))
    if (timings) argv.push('--timings')
    const r = await runRea(argv, { timeoutMs: timeoutMs || 300000, tag: tag || null })
    return { ...r, json: parseJsonLoose(r.stdout), argv }
  })

  ipcMain.handle('rea:cancel', () => {
    if (!activeConsoleChild) return { ok: false, error: 'No REA command is running' }
    canceledChildren.add(activeConsoleChild)
    try { activeConsoleChild.kill() } catch (e) { return { ok: false, error: e.message } }
    return { ok: true }
  })

  ipcMain.handle('rea:workflows', (_e, force) => reaWorkflows(Boolean(force)))
  ipcMain.handle('rea:capabilities', (_e, force) => reaCapabilities(Boolean(force)))
  ipcMain.handle('rea:commands', (_e, force) => reaCommands(Boolean(force)))
  ipcMain.handle('rea:catalog', () => {
    const rea = resolveRea()
    if (!rea) return { ok: false, error: 'REA CLI is not configured in the OpenCode MCP settings' }
    const file = path.join(path.dirname(rea.script), '..', 'dist', 'mcp-catalog-full.json')
    try {
      const cat = JSON.parse(fs.readFileSync(file, 'utf8'))
      const tools = (cat.tools || []).map((t) => ({
        name: t.name,
        title: t.title || t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || null,
      }))
      return { ok: true, version: cat.info?.version || null, tools }
    } catch (e) {
      return { ok: false, error: 'Could not read the MCP tool catalog: ' + e.message }
    }
  })
  ipcMain.handle('rea:version', async () => {
    const r = await runRea(['--version'], { timeoutMs: 60000 })
    return { ok: r.ok, version: (r.stdout || '').trim().split(/\r?\n/)[0] || null, error: r.stderr || null }
  })

  ipcMain.handle('app:setModel', (_e, model) => {
    settings.model = model && model.providerID && model.modelID ? { providerID: model.providerID, modelID: model.modelID } : null
    saveSettings()
    return { ok: true, model: settings.model }
  })

  ipcMain.handle('app:setAgent', (_e, agent) => {
    settings.agent = typeof agent === 'string' && agent ? agent : null
    saveSettings()
    return { ok: true, agent: settings.agent }
  })

  ipcMain.handle('oc:bootstrap', async () => {
    if (!client) return { ok: false, error: 'OpenCode server is not ready' }
    try {
      const [providers, agents, mcp] = await Promise.all([
        client.config.providers(),
        client.app.agents(),
        client.mcp.status(),
      ])
      return { ok: true, providers: providers?.data ?? providers, agents: agents?.data ?? agents, mcp: mcp?.data ?? mcp }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('oc:create', async (_e, { title } = {}) => {
    if (!client) return { ok: false, error: 'OpenCode server is not ready' }
    const res = await client.session.create({
      body: { title: title || 'REA session' },
      query: { directory: settings.workspace },
    })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    const session = res?.data ?? res
    settings.recent = [{ id: session.id, title: session.title, time: Date.now() }, ...settings.recent.filter((s) => s.id !== session.id)].slice(0, 25)
    saveSettings()
    return { ok: true, session }
  })

  ipcMain.handle('oc:prompt', async (_e, { sessionID, text, model, agent, files } = {}) => {
    if (!client) return { ok: false, error: 'OpenCode server is not ready' }
    if (!sessionID) return { ok: false, error: 'No active session' }
    const parts = buildParts(text, files)
    if (!parts.length) return { ok: false, error: 'Nothing to send' }
    const body = { parts }
    const useModel = model?.providerID && model?.modelID ? model : settings.model
    if (useModel?.providerID && useModel?.modelID) body.model = useModel
    const useAgent = agent || settings.agent
    if (useAgent) body.agent = useAgent
    const res = await client.session.promptAsync({
      path: { id: sessionID },
      body,
      query: { directory: settings.workspace },
    })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    return { ok: true, parts: parts.length }
  })

  ipcMain.handle('oc:abort', async (_e, { sessionID } = {}) => {
    if (!client || !sessionID) return { ok: false }
    try { await client.session.abort({ path: { id: sessionID }, query: { directory: settings.workspace } }) } catch { }
    return { ok: true }
  })

  ipcMain.handle('oc:messages', async (_e, { sessionID } = {}) => {
    if (!client || !sessionID) return { ok: false, error: 'No session' }
    const res = await client.session.messages({ path: { id: sessionID }, query: { directory: settings.workspace } })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    return { ok: true, messages: res?.data ?? res }
  })

  ipcMain.handle('oc:sessions', async () => {
    if (!client) return { ok: false, error: 'OpenCode server is not ready' }
    const res = await client.session.list({ query: { directory: settings.workspace } })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    const list = (res?.data ?? res ?? [])
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0))
    return { ok: true, sessions: list }
  })

  ipcMain.handle('oc:deleteSession', async (_e, { sessionID } = {}) => {
    if (!client || !sessionID) return { ok: false, error: 'No session' }
    const res = await client.session.delete({ path: { id: sessionID }, query: { directory: settings.workspace } })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    settings.recent = settings.recent.filter((s) => s.id !== sessionID)
    saveSettings()
    return { ok: true }
  })

  ipcMain.handle('oc:renameSession', async (_e, { sessionID, title } = {}) => {
    if (!client || !sessionID || !title) return { ok: false, error: 'No session or title' }
    const res = await client.session.update({
      path: { id: sessionID },
      body: { title },
      query: { directory: settings.workspace },
    })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    settings.recent = settings.recent.map((s) => (s.id === sessionID ? { ...s, title } : s))
    saveSettings()
    return { ok: true, session: res?.data ?? res }
  })

  ipcMain.handle('dialog:files', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || 'Attach files',
      defaultPath: settings.workspace,
      properties: ['openFile', 'multiSelections'],
      filters: opts.filters?.length ? opts.filters : [{ name: 'All files', extensions: ['*'] }],
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:save', async (_e, opts = {}) => {
    const res = await dialog.showSaveDialog(win, {
      title: opts.title || 'Save file',
      defaultPath: opts.defaultPath ? path.join(settings.workspace, opts.defaultPath) : settings.workspace,
      filters: opts.filters?.length ? opts.filters : [{ name: 'All files', extensions: ['*'] }],
    })
    return res.canceled ? null : res.filePath
  })

  ipcMain.handle('file:saveText', async (_e, { text = '', defaultPath, filters } = {}) => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save output',
      defaultPath: defaultPath ? path.join(settings.workspace, defaultPath) : settings.workspace,
      filters: filters?.length ? filters : [{ name: 'All files', extensions: ['*'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(res.filePath, String(text ?? ''), 'utf8')
      return { ok: true, path: res.filePath }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('oc:permission', async (_e, { sessionID, permissionID, response } = {}) => {
    if (!client) return { ok: false, error: 'No client' }
    const res = await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response },
      query: { directory: settings.workspace },
    })
    if (res?.error) return { ok: false, error: JSON.stringify(res.error) }
    return { ok: true }
  })

  ipcMain.handle('transcript:save', async (_e, { text, name } = {}) => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save transcript',
      defaultPath: path.join(settings.workspace, name || 'rea-transcript.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (res.canceled) return { ok: false }
    fs.writeFileSync(res.filePath, text ?? '', 'utf8')
    return { ok: true, path: res.filePath }
  })

  ipcMain.handle('shell:reveal', async (_e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p)
    return { ok: true }
  })

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url)
    return { ok: true }
  })

  /* ---------------------------------------------------------------- ida free */

  ipcMain.handle('ida:status', () => idaStatus())

  ipcMain.handle('ida:setPath', (_e, { idaPath } = {}) => {
    if (idaPath === null || idaPath === '') {
      delete settings.idaPath
      saveSettings()
      return idaStatus()
    }
    if (typeof idaPath !== 'string' || !fs.existsSync(idaPath)) return { ok: false, error: 'That IDA executable does not exist' }
    if (!/\.exe$/i.test(idaPath)) return { ok: false, error: 'Choose an IDA executable such as ida.exe' }
    settings.idaPath = idaPath
    saveSettings()
    return idaStatus()
  })

  ipcMain.handle('ida:setMcpConfig', (_e, { file } = {}) => {
    if (file === null || file === '') {
      delete settings.idaMcpConfig
      saveSettings()
      return { ok: true, mcp: inspectIdaRegistration(idaMcpConfigPath()) }
    }
    if (typeof file !== 'string' || !fs.existsSync(file)) return { ok: false, error: 'That registration file does not exist' }
    const check = inspectIdaRegistration(file)
    if (!check.valid) return { ok: false, error: check.error || 'Not a valid IDA MCP registration' }
    settings.idaMcpConfig = file
    saveSettings()
    return { ok: true, mcp: check }
  })

  ipcMain.handle('ida:open', (_e, { target, idaPath } = {}) => {
    const exe = (typeof idaPath === 'string' && idaPath) || (settings.idaPath && fs.existsSync(settings.idaPath) ? settings.idaPath : detectIda())
    if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'No IDA executable found. Choose ida.exe in the Providers tab.' }
    if (typeof target !== 'string' || !target || !fs.existsSync(target)) return { ok: false, error: 'Target file does not exist' }
    try {
      const child = spawn(exe, [target], { detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(target) })
      child.unref()
      return { ok: true, idaPath: exe, target }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  /* ------------------------------------------------------- clone projects */

  const cloneGuard = (fn) => async (_e, payload = {}) => {
    try {
      return { ok: true, ...(await fn(payload)) }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  ipcMain.handle('clone:list', cloneGuard(async () => ({
    root: cloneStore.rootFor(settings.workspace),
    projects: cloneStore.listProjects(settings.workspace),
    stages: cloneStore.STAGES,
  })))

  ipcMain.handle('clone:create', cloneGuard(async ({ name, targetPath, notes } = {}) => ({
    project: cloneStore.createProject(settings.workspace, { name, targetPath, notes }),
  })))

  ipcMain.handle('clone:get', cloneGuard(async ({ slug } = {}) => ({
    project: cloneStore.projectDetail(settings.workspace, slug),
  })))

  ipcMain.handle('clone:delete', cloneGuard(async ({ slug } = {}) => ({
    removed: cloneStore.deleteProject(settings.workspace, slug),
  })))

  ipcMain.handle('clone:update', cloneGuard(async ({ slug, patch } = {}) => ({
    project: cloneStore.updateProject(settings.workspace, slug, patch || {}),
  })))

  ipcMain.handle('clone:setStage', cloneGuard(async ({ slug, stage, patch } = {}) => {
    const current = cloneStore.getProject(settings.workspace, slug)
    if (!current) throw new Error(`No clone project "${slug}"`)
    if (patch?.status === 'complete') {
      const gate = cloneStore.stageGate(current, stage)
      if (!gate.allowed) {
        throw new Error(
          `${gate.blockers.length} blocking unknown(s) must be resolved first: ` +
            gate.blockers.map((b) => b.question).join('; '),
        )
      }
    }
    return { project: cloneStore.setStage(settings.workspace, slug, stage, patch || {}) }
  }))

  ipcMain.handle('clone:setTarget', cloneGuard(async ({ slug, targetPath } = {}) => ({
    target: await cloneStore.setTarget(settings.workspace, slug, targetPath),
  })))

  ipcMain.handle('clone:addUnknown', cloneGuard(async ({ slug, unknown } = {}) => ({
    unknown: cloneStore.addUnknown(settings.workspace, slug, unknown || {}),
  })))

  ipcMain.handle('clone:updateUnknown', cloneGuard(async ({ slug, id, patch } = {}) => ({
    unknown: cloneStore.updateUnknown(settings.workspace, slug, id, patch || {}),
  })))

  ipcMain.handle('clone:removeUnknown', cloneGuard(async ({ slug, id } = {}) => ({
    removed: cloneStore.removeUnknown(settings.workspace, slug, id),
  })))

  ipcMain.handle('clone:addEvidence', cloneGuard(async ({ slug, evidence } = {}) => ({
    evidence: cloneStore.addEvidence(settings.workspace, slug, evidence || {}),
  })))

  ipcMain.handle('clone:captureEvidence', cloneGuard(async ({ slug, ids, source, raw } = {}) => ({
    capture: cloneStore.captureEvidence(settings.workspace, slug, { ids, source, raw }),
  })))

  ipcMain.handle('clone:addCase', cloneGuard(async ({ slug, testCase } = {}) => ({
    case: cloneStore.recordCase(settings.workspace, slug, testCase || {}),
  })))

  ipcMain.handle('clone:getCase', cloneGuard(async ({ slug, id } = {}) => ({
    case: cloneStore.readCase(settings.workspace, slug, id),
  })))

  ipcMain.handle('clone:deleteCase', cloneGuard(async ({ slug, id } = {}) => ({
    removed: cloneStore.deleteCase(settings.workspace, slug, id),
  })))

  ipcMain.handle('clone:replayCase', cloneGuard(async ({ slug, id } = {}) => {    const project = cloneStore.getProject(settings.workspace, slug)
    if (!project) throw new Error(`No clone project "${slug}"`)
    const { index, request, record } = cloneStore.readCase(settings.workspace, slug, id)
    const requestPath = cloneStore.caseFile(settings.workspace, slug, id, '.request.json')
    const args = buildReplayArgs(project, index, request, requestPath)

    const run = await runRea(args, { timeoutMs: 900000, tag: 'clone' })
    const parsed = parseJsonLoose(run.stdout) ?? { raw: String(run.stdout || '').slice(0, 20000) }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const replayPath = cloneStore.caseFile(settings.workspace, slug, id, `.replay-${stamp}.json`)
    fs.writeFileSync(replayPath, JSON.stringify(parsed, null, 2), 'utf8')

    const diff = cloneStore.diffObservations(record?.observation, parsed)

    let nativeCompare = null
    if (index.compare && record?.observation && run.ok) {
      const originalPath = cloneStore.caseFile(settings.workspace, slug, id, '.original.json')
      if (!fs.existsSync(originalPath)) {
        fs.writeFileSync(originalPath, JSON.stringify(record.observation, null, 2), 'utf8')
      }
      let compareArgs = null
      if (index.compare === 'compare-process-captures') {
        compareArgs = ['compare-process-captures', originalPath, replayPath, '--format', 'json']
      } else if (index.compare === 'compare-web-captures') {
        compareArgs = ['compare-web-captures', originalPath, replayPath, '--format', 'json']
      }
      if (compareArgs) {
        const cmp = await runRea(compareArgs, { timeoutMs: 300000, tag: 'clone' })
        nativeCompare = {
          ok: cmp.ok,
          exit: cmp.code,
          result: parseJsonLoose(cmp.stdout) ?? String(cmp.stdout || '').slice(0, 4000),
          stderr: String(cmp.stderr || '').slice(-2000) || null,
        }
      }
    }

    const failure =
      !run.ok && parsed && typeof parsed === 'object'
        ? [parsed.error, parsed.message].filter(Boolean).join(': ')
        : null

    const parity = cloneStore.setCaseParity(settings.workspace, slug, id, {
      status: run.ok ? diff.status : 'error',
      note: run.ok ? diff.note : failure || 'Replay command failed',
      dims: run.ok ? diff.dims : [],
      cliOk: run.ok,
      cliExit: run.code,
      cliArgs: args,
      replayFile: path.basename(replayPath),
      nativeCompare,
      stderr: String(run.stderr || '').slice(-4000) || null,
    })

    return {
      parity,
      cliOk: run.ok,
      error: failure,
      stderr: String(run.stderr || '').slice(-2000) || null,
    }
  }))

  ipcMain.handle('clone:compileSpec', cloneGuard(async ({ slug } = {}) => ({
    result: cloneSpec.compileSpec(settings.workspace, slug),
  })))

  ipcMain.handle('clone:scaffold', cloneGuard(async ({ slug, language } = {}) => ({
    result: cloneSpec.scaffold(settings.workspace, slug, { language }),
  })))

  ipcMain.handle('clone:artifacts', cloneGuard(async ({ slug } = {}) => ({
    artifacts: cloneSpec.listArtifacts(settings.workspace, slug),
  })))

  ipcMain.handle('clone:openArtifact', cloneGuard(async ({ slug, file } = {}) => {
    const base = cloneStore.projectPaths(settings.workspace, slug).dir
    const abs = path.resolve(base, String(file || ''))
    const root = path.resolve(base)
    if (!abs.startsWith(root + path.sep)) throw new Error('Artifact path escapes the project folder')
    if (!fs.existsSync(abs)) throw new Error('Artifact does not exist')
    shell.showItemInFolder(abs)
    return { path: abs }
  }))
  /* ---------------------------------------------------- facts + fidelity */

  ipcMain.handle('facts:extract', cloneGuard(async ({ slug } = {}) =>
    cloneFacts.extractFacts(settings.workspace, slug),
  ))

  ipcMain.handle('facts:list', cloneGuard(async ({ slug } = {}) => ({
    facts: cloneFacts.listFacts(settings.workspace, slug),
  })))

  ipcMain.handle('fidelity:compute', cloneGuard(async ({ slug } = {}) => ({
    score: cloneFidelity.computeFidelity(settings.workspace, slug),
  })))

  ipcMain.handle('fidelity:get', cloneGuard(async ({ slug } = {}) => ({
    score: cloneFidelity.readFidelity(settings.workspace, slug),
  })))

  /* ------------------------------------------------------- capture tools */

  ipcMain.handle('uimap:capture', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneCapture.captureUiMap(settings.workspace, slug, opts),
  ))

  ipcMain.handle('artifacts:snapshot', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneCapture.takeSnapshot(settings.workspace, slug, opts),
  ))

  ipcMain.handle('artifacts:diff', cloneGuard(async ({ slug, before, after } = {}) => {
    const a = cloneCapture.readSnapshot(settings.workspace, slug, before)
    const b = cloneCapture.readSnapshot(settings.workspace, slug, after)
    const diff = cloneCapture.diffSnapshots(a, b)
    return { diff, applied: cloneCapture.applyArtifactDiff(settings.workspace, slug, diff, { beforeFile: before, afterFile: after }) }
  }))

  ipcMain.handle('artifacts:capture', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneCapture.captureArtifacts(settings.workspace, slug, opts),
  ))

  ipcMain.handle('uimap:get', cloneGuard(async ({ slug } = {}) => {
    const dir = cloneStore.projectPaths(settings.workspace, slug).spec
    const file = path.join(dir, 'ui-map.json')
    return { map: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null }
  }))

  ipcMain.handle('artifacts:get', cloneGuard(async ({ slug } = {}) => {
    const dir = cloneStore.projectPaths(settings.workspace, slug).spec
    const file = path.join(dir, 'persistence.json')
    return { diff: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null }
  }))

  /* ---------------------------------------------------------- exploration */

  ipcMain.handle('explore:run', cloneGuard(async ({ slug, targetPath } = {}) =>
    cloneExplore.exploreTarget(settings.workspace, slug, { targetPath }),
  ))

  ipcMain.handle('explore:get', cloneGuard(async ({ slug } = {}) => ({
    inventory: cloneExplore.readInventory(settings.workspace, slug),
  })))

  /* ------------------------------------------------------------- formats */

  ipcMain.handle('formats:fromArtifacts', cloneGuard(async ({ slug, limit } = {}) =>
    cloneFormats.inferFromArtifacts(settings.workspace, slug, { limit }),
  ))

  ipcMain.handle('formats:infer', cloneGuard(async ({ slug, path: filePath, label } = {}) =>
    cloneFormats.inferFile(settings.workspace, slug, filePath, label),
  ))

  ipcMain.handle('formats:list', cloneGuard(async ({ slug } = {}) => ({
    formats: cloneFormats.listFormats(settings.workspace, slug),
  })))

  /* ------------------------------------------------------------ protocol */

  ipcMain.handle('protocol:netstat', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneProtocol.captureNetstat(settings.workspace, slug, opts),
  ))

  ipcMain.handle('protocol:proxy', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneProtocol.captureProxy(settings.workspace, slug, opts),
  ))

  ipcMain.handle('protocol:har', cloneGuard(async ({ slug, path: filePath } = {}) =>
    cloneProtocol.importHar(settings.workspace, slug, filePath),
  ))

  ipcMain.handle('protocol:get', cloneGuard(async ({ slug } = {}) => ({
    protocol: cloneProtocol.readProtocol(settings.workspace, slug),
  })))

  /* ------------------------------------------------------------- clone IR */

  ipcMain.handle('ir:compile', cloneGuard(async ({ slug } = {}) => ({
    ir: cloneIR.compileIR(settings.workspace, slug),
  })))

  ipcMain.handle('ir:get', cloneGuard(async ({ slug } = {}) => ({
    ir: cloneIR.readIR(settings.workspace, slug),
  })))

  ipcMain.handle('ir:validate', cloneGuard(async ({ slug } = {}) =>
    cloneIR.validateIR(settings.workspace, slug),
  ))

  /* ------------------------------------------------------- oracle / shadow */

  ipcMain.handle('oracle:record', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneOracle.recordOracle(settings.workspace, slug, opts),
  ))

  ipcMain.handle('oracle:shadow', cloneGuard(async ({ slug, caseId, ...opts } = {}) =>
    cloneOracle.runShadow(settings.workspace, slug, caseId, opts),
  ))

  ipcMain.handle('oracle:list', cloneGuard(async ({ slug } = {}) =>
    cloneOracle.oracleReport(settings.workspace, slug),
  ))

  ipcMain.handle('oracle:get', cloneGuard(async ({ slug, caseId } = {}) => ({
    raw: cloneOracle.readOracleRaw(settings.workspace, slug, caseId),
  })))

  /* --------------------------------------------------------------- repair */

  ipcMain.handle('repair:analyze', cloneGuard(async ({ slug } = {}) =>
    cloneRepair.analyzeRepairs(settings.workspace, slug),
  ))

  ipcMain.handle('repair:apply', cloneGuard(async ({ slug, caseIds } = {}) =>
    cloneRepair.applyRepairs(settings.workspace, slug, { caseIds }),
  ))

  ipcMain.handle('repair:status', cloneGuard(async ({ slug } = {}) =>
    cloneRepair.repairStatus(settings.workspace, slug),
  ))

  ipcMain.handle('repair:get', cloneGuard(async ({ slug } = {}) =>
    cloneRepair.repairGet(settings.workspace, slug),
  ))

  /* ----------------------------------------------------------- gap planner */

  ipcMain.handle('gaps:analyze', cloneGuard(async ({ slug, limit } = {}) =>
    cloneGaps.analyzeGaps(settings.workspace, slug, { limit }),
  ))

  ipcMain.handle('gaps:next', cloneGuard(async ({ slug, limit } = {}) =>
    cloneGaps.planNext(settings.workspace, slug, { limit }),
  ))

  ipcMain.handle('gaps:status', cloneGuard(async ({ slug } = {}) =>
    cloneGaps.gapStatus(settings.workspace, slug),
  ))

  ipcMain.handle('gaps:get', cloneGuard(async ({ slug } = {}) =>
    cloneGaps.gapGet(settings.workspace, slug),
  ))

  /* ---------------------------------------------------------- recipe store */

  ipcMain.handle('recipes:list', cloneGuard(async () =>
    cloneRecipes.listRecipes(settings.workspace),
  ))

  ipcMain.handle('recipes:save', cloneGuard(async ({ slug, ...opts } = {}) =>
    cloneRecipes.saveRecipe(settings.workspace, slug, opts),
  ))

  ipcMain.handle('recipes:get', cloneGuard(async ({ slug } = {}) =>
    cloneRecipes.recipeGet(settings.workspace, slug),
  ))

  ipcMain.handle('recipes:one', cloneGuard(async ({ id } = {}) =>
    cloneRecipes.getRecipe(settings.workspace, id),
  ))

  ipcMain.handle('recipes:apply', cloneGuard(async ({ slug, id } = {}) =>
    cloneRecipes.applyRecipe(settings.workspace, slug, id),
  ))

  ipcMain.handle('recipes:delete', cloneGuard(async ({ id } = {}) =>
    cloneRecipes.deleteRecipe(settings.workspace, id),
  ))

  ipcMain.handle('recipes:export', cloneGuard(async () =>
    cloneRecipes.exportRecipes(settings.workspace),
  ))

  ipcMain.handle('recipes:import', cloneGuard(async ({ text, mode } = {}) =>
    cloneRecipes.importRecipes(settings.workspace, { text, mode }),
  ))

  /* ------------------------------------------- behavior fingerprint / drift */

  ipcMain.handle('fingerprint:build', cloneGuard(async ({ slug } = {}) =>
    cloneFingerprint.buildFingerprint(settings.workspace, slug),
  ))

  ipcMain.handle('fingerprint:drift', cloneGuard(async ({ slug } = {}) =>
    cloneFingerprint.checkDrift(settings.workspace, slug),
  ))

  ipcMain.handle('fingerprint:status', cloneGuard(async ({ slug } = {}) =>
    cloneFingerprint.fingerprintStatus(settings.workspace, slug),
  ))

  ipcMain.handle('fingerprint:get', cloneGuard(async ({ slug } = {}) =>
    cloneFingerprint.fingerprintGet(settings.workspace, slug),
  ))

  /* ------------------------------------------------------------- auto clone */

  ipcMain.handle('auto:run', cloneGuard(async (options = {}) =>
    cloneAuto.runAutoClone(settings.workspace, options, (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('auto:progress', payload)
    }),
  ))

  ipcMain.handle('auto:get', cloneGuard(async ({ slug = null } = {}) =>
    cloneAuto.readAuto(settings.workspace, { slug }),
  ))
}

/* -------------------------------------------------------------------- boot */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0d1017',
    title: 'REA Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.on('closed', () => { win = null })
}

app.whenReady().then(async () => {
  loadSettings()
  registerIpc()
  createWindow()
  await startServer()
  if (server.phase === 'ready') {
    makeClient()
    subscribeEvents()
  }
})

app.on('window-all-closed', () => {
  eventAbort?.abort()
  if (serverProc) { try { serverProc.kill() } catch { } }
  app.quit()
})

app.on('before-quit', () => {
  eventAbort?.abort()
  if (serverProc) { try { serverProc.kill() } catch { } }
})
