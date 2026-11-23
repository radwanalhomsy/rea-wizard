/**
 * Capture tools that widen the evidence base without needing a PTY.
 *
 * - Artifact snapshots: bounded filesystem / registry / process state before
 *   and after an action, diffed into a persistence model with evidence IDs.
 * - UI map: Windows UI Automation accessibility tree of a target window,
 *   giving the fidelity scorecard a real denominator for UI coverage.
 *
 * All paths written here are relative to the clone project so the ledger stays
 * portable and diffable.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { getProject, projectPaths, addEvidence } from './cloneStore.mjs'

const DEFAULT_DEPTH = 3
const DEFAULT_MAX = 1200
const DEFAULT_REGISTRY = [
  'HKCU\\Environment',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
]

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function digest(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)
}

function relTo(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/')
}

function isWindows() {
  return process.platform === 'win32'
}

/* ------------------------------------------------------------- filesystem */

function walk(root, depth, max, out) {
  if (out.size >= max) return
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.size >= max) return
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) walk(file, depth - 1, max, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const st = fs.statSync(file)
      out.set(file, { size: st.size, mtime: st.mtimeMs, mode: st.mode })
    } catch { }
  }
}

function snapshotFiles(roots, depth, max) {
  const files = new Map()
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    walk(path.resolve(root), depth, max, files)
  }
  return Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

/* --------------------------------------------------------------- registry */

function snapshotRegistry(keys) {
  const result = {}
  if (!isWindows()) return result
  for (const key of keys) {
    const res = spawnSync('reg.exe', ['query', key], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })
    const text = `${res.stdout || ''}${res.stderr || ''}`.trim()
    result[key] = text ? text.split(/\r?\n/).filter(Boolean).slice(0, 400) : []
  }
  return result
}

/* --------------------------------------------------------------- processes */

function snapshotProcesses() {
  if (!isWindows()) return []
  const res = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  })
  const names = new Set()
  for (const line of String(res.stdout || '').split(/\r?\n/).slice(1)) {
    const name = line.split('","')[0]?.replace(/^"/, '').trim()
    if (name) names.add(name.toLowerCase())
  }
  return [...names].sort()
}

export function takeSnapshot(workspace, slug, { label = 'snapshot', roots = [], registryKeys = DEFAULT_REGISTRY } = {}) {
  const paths = projectPaths(workspace, slug)
  const data = {
    schema: 1,
    label: String(label),
    at: new Date().toISOString(),
    roots: roots.map((r) => path.resolve(r)),
    registryKeys,
    files: snapshotFiles(roots, DEFAULT_DEPTH, DEFAULT_MAX),
    registry: snapshotRegistry(registryKeys),
    processes: snapshotProcesses(),
  }
  fs.mkdirSync(paths.evidence, { recursive: true })
  const file = path.join(paths.evidence, `artifact-${digest(label)}-${stamp()}.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return { file: relTo(paths.dir, file), snapshot: data }
}

export function readSnapshot(workspace, slug, file) {
  const base = projectPaths(workspace, slug).dir
  const abs = path.resolve(base, String(file || ''))
  if (!abs.startsWith(path.resolve(base) + path.sep)) throw new Error('Snapshot path escapes the project folder')
  return JSON.parse(fs.readFileSync(abs, 'utf8'))
}

function diffMap(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out = []
  for (const key of keys) {
    const a = before[key]
    const b = after[key]
    if (!a && b) out.push({ path: key, operation: 'created', after: b })
    else if (a && !b) out.push({ path: key, operation: 'deleted', before: a })
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: key, operation: 'changed', before: a, after: b })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

/** Turn two snapshots into the persistence model consumed by the facts layer. */
export function diffSnapshots(before, after) {
  const fileChanges = diffMap(before.files, after.files)
  const registryChanges = []
  for (const key of Object.keys({ ...before.registry, ...after.registry })) {
    const a = (before.registry || {})[key] || []
    const b = (after.registry || {})[key] || []
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      registryChanges.push({ path: key, operation: 'changed', before: a.length, after: b.length })
    }
  }
  const bProc = new Set(before.processes || [])
  const aProc = new Set(after.processes || [])
  const processChanges = [
    ...[...aProc].filter((p) => !bProc.has(p)).map((p) => ({ path: `process:${p}`, operation: 'created' })),
    ...[...bProc].filter((p) => !aProc.has(p)).map((p) => ({ path: `process:${p}`, operation: 'deleted' })),
  ].sort((x, y) => x.path.localeCompare(y.path))

  const artifacts = [
    ...fileChanges.map((c) => ({ ...c, kind: 'file', sources: ['artifact-diff'] })),
    ...registryChanges.map((c) => ({ ...c, kind: 'registry', sources: ['artifact-diff'] })),
    ...processChanges.map((c) => ({ ...c, kind: 'process', sources: ['artifact-diff'] })),
  ]
  return {
    schema: 1,
    counts: { files: fileChanges.length, registry: registryChanges.length, processes: processChanges.length },
    artifacts,
  }
}

function markdown(diff) {
  const lines = [
    '# Artifact diff',
    '',
    `${diff.artifacts.length} changes · ${diff.counts.files} files · ` +
      `${diff.counts.registry} registry keys · ${diff.counts.processes} processes`,
    '',
    '| Kind | Operation | Path |',
    '| --- | --- | --- |',
  ]
  for (const a of diff.artifacts) {
    lines.push(`| ${a.kind} | ${a.operation} | ${String(a.path).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

export function applyArtifactDiff(workspace, slug, diff, { beforeFile, afterFile } = {}) {
  const paths = projectPaths(workspace, slug)
  fs.mkdirSync(paths.spec, { recursive: true })
  fs.writeFileSync(path.join(paths.spec, 'persistence.json'), JSON.stringify(diff, null, 2) + '\n', 'utf8')
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'artifacts.md'), markdown(diff), 'utf8')

  const added = []
  for (const a of diff.artifacts) {
    const id = `ev_art_${digest(a.kind + a.operation + a.path)}`
    addEvidence(workspace, slug, {
      id,
      source: 'artifact-diff',
      stage: 'behavior',
      note: `${a.kind} ${a.operation}: ${a.path}`,
      file: afterFile || beforeFile || null,
    })
    added.push(id)
  }
  return { artifacts: diff.artifacts.length, evidence: added, files: ['spec/persistence.json', 'reports/artifacts.md'] }
}

/** Snapshot → launch target → wait → snapshot → diff, in one call. */
export async function captureArtifacts(workspace, slug, options = {}) {
  const {
    target,
    seconds = 6,
    roots = [],
    registryKeys = DEFAULT_REGISTRY,
    closeAfter = true,
    label = 'artifact-capture',
  } = options
  if (typeof target !== 'string' || !fs.existsSync(target)) throw new Error('A target executable is required')
  const scanRoots = roots.length
    ? roots
    : [
        path.dirname(path.resolve(target)),
        process.env.APPDATA,
        process.env.LOCALAPPDATA,
        os.tmpdir(),
      ].filter(Boolean)
  const before = takeSnapshot(workspace, slug, { label: `${label}-before`, roots: scanRoots, registryKeys })
  let child = null
  try {
    child = spawn(target, [], {
      cwd: path.dirname(target),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(60, Number(seconds) || 6)) * 1000))
  } finally {
    if (child && closeAfter && child.pid) {
      try { process.kill(-child.pid) } catch {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
    }
  }
  const after = takeSnapshot(workspace, slug, { label: `${label}-after`, roots: scanRoots, registryKeys })
  const diff = diffSnapshots(before.snapshot, after.snapshot)
  const applied = applyArtifactDiff(workspace, slug, diff, {
    beforeFile: before.file,
    afterFile: after.file,
  })
  return {
    ...applied,
    counts: diff.counts,
    before: before.file,
    after: after.file,
    launchedPid: child?.pid ?? null,
    closed: Boolean(closeAfter && child?.pid),
  }
}

/* ----------------------------------------------------------------- UI map */

const UIA_SCRIPT = `
param([int]$ProcId = 0, [string]$Title = '', [string]$Output = '', [int]$Max = 1200)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($ProcId -gt 0) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if (-not $win -and $Title) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($c in $all) {
    if ($c.Current.Name -like "*$Title*") { $win = $c; break }
  }
}
if (-not $win) { throw 'No matching window was found' }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$nodes = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$controls = @()
foreach ($e in $nodes) {
  if ($controls.Count -ge $Max) { break }
  $r = $e.Current.BoundingRectangle
  $p = $walker.GetParent($e)
  $controls += [pscustomobject]@{
    name = $e.Current.Name
    automationId = $e.Current.AutomationId
    className = $e.Current.ClassName
    controlType = $e.Current.ControlType.ProgrammaticName
    enabled = [bool]$e.Current.IsEnabled
    offscreen = [bool]$e.Current.IsOffscreen
    x = [int]$r.X
    y = [int]$r.Y
    width = [int]$r.Width
    height = [int]$r.Height
    parent = if ($p) { $p.Current.Name } else { '' }
  }
}
$result = [pscustomobject]@{
  title = $win.Current.Name
  processId = $win.Current.ProcessId
  controls = $controls
}
$result | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path $Output -Encoding UTF8
`

export async function captureUiMap(workspace, slug, options = {}) {
  if (!isWindows()) throw new Error('UI Automation is available on Windows only')
  const { pid = null, windowTitle = '', target = null, seconds = 5, closeAfter = false, max = 1200 } = options
  let child = null
  let usePid = Number(pid) || 0
  let useTitle = String(windowTitle || '')
  if (!usePid && !useTitle && target) {
    if (typeof target !== 'string' || !fs.existsSync(target)) throw new Error('Target executable does not exist')
    child = spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore', windowsHide: false })
    usePid = child.pid || 0
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(30, Number(seconds) || 5)) * 1000))
  }

  const paths = projectPaths(workspace, slug)
  const script = path.join(os.tmpdir(), `rea-uimap-${process.pid}-${Date.now()}.ps1`)
  const output = path.join(os.tmpdir(), `rea-uimap-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(script, UIA_SCRIPT, 'utf8')
  try {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ProcId', String(usePid), '-Title', useTitle, '-Output', output, '-Max', String(max),
    ]
    // Async spawn is essential: spawnSync would block Electron's main thread,
    // which itself owns the UIA provider for the window being inspected.
    const res = await new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', args, { windowsHide: true })
      ps.stdout.setEncoding('utf8')
      ps.stderr.setEncoding('utf8')
      let stdout = ''
      let stderr = ''
      let bytes = 0
      const limit = 8 * 1024 * 1024
      ps.stdout.on('data', (d) => { bytes += d.length; if (bytes <= limit) stdout += d })
      ps.stderr.on('data', (d) => { bytes += d.length; if (bytes <= limit) stderr += d })
      const timer = setTimeout(() => { ps.kill(); reject(new Error('UI Automation timed out')) }, 90000)
      ps.on('error', (e) => { clearTimeout(timer); reject(e) })
      ps.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
    })
    if (res.status !== 0) throw new Error(String(res.stderr || res.stdout || 'UI Automation failed').trim().slice(0, 400))
    const raw = fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(raw)
    const controls = (Array.isArray(data.controls) ? data.controls : [data.controls]).filter(Boolean).map((c) => ({
      screen: c.parent || 'root',
      name: c.name || c.automationId || c.className || 'control',
      label: c.name || c.automationId || c.className || 'control',
      type: String(c.controlType || '').replace('ControlType.', '') || 'unknown',
      enabled: Boolean(c.enabled),
      offscreen: Boolean(c.offscreen),
      bounds: { x: c.x || 0, y: c.y || 0, width: c.width || 0, height: c.height || 0 },
      parent: c.parent || '',
    }))
    const map = {
      schema: 1,
      at: new Date().toISOString(),
      title: data.title || useTitle || '',
      processId: data.processId || usePid || null,
      source: child ? 'launched-target' : usePid ? 'pid' : 'window-title',
      controls,
    }
    fs.mkdirSync(paths.spec, { recursive: true })
    fs.writeFileSync(path.join(paths.spec, 'ui-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8')
    return { title: map.title, processId: map.processId, controls: controls.length, source: map.source, file: 'spec/ui-map.json' }
  } finally {
    try { fs.rmSync(script, { force: true }) } catch { }
    try { fs.rmSync(output, { force: true }) } catch { }
    if (child && closeAfter && child.pid) {
      try { process.kill(-child.pid) } catch {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
    }
  }
}
