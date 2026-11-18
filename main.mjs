import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import * as cloneStore from './cloneStore.mjs'

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
  return env && typeof env === 'object' ? env : {}
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
    case: cloneStore.addCase(settings.workspace, slug, testCase || {}),
  })))
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
