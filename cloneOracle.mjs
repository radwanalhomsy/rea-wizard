/**
 * Oracle / Shadow runtime.
 *
 * The oracle runs the REAL target executable with a fully described input
 * (argv, stdin, seeded files, working directory) and captures observable
 * behaviour: exit code, stdout/stderr, filesystem side effects and output
 * shape. The shadow replays the identical input against a candidate clone —
 * or against the original again as a determinism self-check — and the two
 * observations are diffed into a parity record that the fidelity scorecard
 * already understands.
 *
 * Nothing here decrypts, emulates or guesses semantics. When the clone is a
 * TODO scaffold, the diff honestly reports `changed`/`error` and names the
 * dimensions that differ. That measured gap is what the repair loop works on.
 *
 * Captures live in cases/<id>.oracle.json and cases/<id>.shadow-<stamp>.json.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  getProject, projectPaths, recordCase, readCase, addEvidence, captureEvidence, setCaseParity,
} from './cloneStore.mjs'
import { takeSnapshot, diffSnapshots } from './cloneCapture.mjs'

const CAPTURE_CAP = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20000
const MAX_STEPS = 60

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch { /* already gone */ }
}

/** Spawn a process and collect bounded stdout/stderr plus its exit code. */
function runProcess(exe, { argv = [], stdin = '', cwd, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, argv, {
        cwd: cwd || undefined,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        detached: process.platform !== 'win32',
      })
    } catch (e) {
      resolve({ ok: false, error: e.message, timedOut: false, exit_code: null, stdout: '', stderr: '' })
      return
    }
    const out = []
    const err = []
    let bytes = 0
    const take = (chunk, sink) => {
      bytes += chunk.length
      if (bytes <= CAPTURE_CAP) sink.push(chunk)
    }
    child.stdout?.on('data', (d) => take(d, out))
    child.stderr?.on('data', (d) => take(d, err))
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, Math.max(100, Math.min(600000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)))
    const finish = (ok, error) => {
      clearTimeout(timer)
      resolve({
        ok, error, timedOut,
        exit_code: ok ? (typeof child.exitCode === 'number' ? child.exitCode : null) : null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    }
    child.on('error', (e) => finish(false, e.message))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: true, error: null, timedOut,
        exit_code: typeof code === 'number' ? code : child.exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
    try {
      if (stdin) child.stdin.write(stdin)
      child.stdin.end()
    } catch { /* process may have exited already */ }
  })
}

/** Remove volatile noise so two runs of the same behaviour compare equal. */
export function normalizeText(text, { baseDir = '' } = {}) {
  let s = String(text || '').replace(/\r\n?/g, '\n')
  if (baseDir) {
    for (const variant of [baseDir, baseDir.replace(/\\/g, '/'), baseDir.replace(/\//g, '\\')]) {
      s = s.split(variant).join('<ROOT>')
    }
  }
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<TIME>')
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<GUID>')
  s = s.replace(/\b0x[0-9a-f]{4,}\b/gi, '<HEX>')
  s = s.replace(/\[\d{2,}\]/g, '[PID]')
  s = s.replace(/[ \t]+$/gm, '')
  return s.trim()
}

function relativeFile(p, baseDir) {
  const abs = String(p || '')
  if (!baseDir) return abs
  const normalized = abs.replace(/\\/g, '/')
  const base = String(baseDir).replace(/\\/g, '/').replace(/\/$/, '')
  if (normalized.startsWith(base + '/')) return normalized.slice(base.length + 1)
  return normalized
}

function fileFacts(diff, baseDir) {
  return (diff?.artifacts || [])
    .filter((a) => a.kind === 'file')
    .map((a) => ({
      path: relativeFile(a.path, baseDir),
      operation: a.operation || 'write',
      size: a.size ?? null,
    }))
    .sort((a, b) => `${a.path}|${a.operation}`.localeCompare(`${b.path}|${b.operation}`))
}

function stepsFromStdout(stdout) {
  return String(stdout || '').split('\n').filter((l) => l.trim()).slice(0, MAX_STEPS)
    .map((line, i) => ({ index: i, action: 'output', target: line.trim().slice(0, 200), status: null }))
}

function makeObservation(run, fileDiff, baseDir) {
  const stdout = normalizeText(run.stdout, { baseDir })
  const stderr = normalizeText(run.stderr, { baseDir })
  return {
    schema: 1,
    exit_code: run.exit_code,
    stdout,
    stderr,
    steps: stepsFromStdout(stdout),
    unknowns: [],
    files: fileFacts(fileDiff, baseDir),
    run_ok: Boolean(run.ok),
    timed_out: Boolean(run.timedOut),
  }
}

function stable(value) {
  return JSON.stringify(value ?? null)
}

function clip(value, n = 300) {
  const s = stable(value)
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** Deterministic diff between two oracle observations. */
export function diffOracle(before, after) {
  const dims = []
  const compare = (name, a, b) => {
    const match = stable(a) === stable(b)
    dims.push({
      name,
      status: match ? 'match' : 'changed',
      before: clip(a),
      after: clip(b),
      detail: match ? 'equal' : `${name} differs`,
    })
  }
  compare('exit code', before?.exit_code, after?.exit_code)
  compare('stdout', before?.stdout, after?.stdout)
  compare('stderr', before?.stderr, after?.stderr)
  compare('files', before?.files, after?.files)
  compare('steps', before?.steps, after?.steps)
  const status = dims.every((d) => d.status === 'match') ? 'match' : 'changed'
  return {
    status,
    dims,
    note: status === 'match'
      ? 'Shadow matched the oracle on every comparable dimension.'
      : `${dims.filter((d) => d.status === 'changed').length} dimension(s) differ.`,
  }
}

function ensureSandbox(paths, key, files = []) {
  const sandbox = path.join(paths.dir, 'sandbox', key)
  fs.mkdirSync(sandbox, { recursive: true })
  for (const f of files || []) {
    if (!f || !f.name) continue
    const target = path.resolve(sandbox, path.basename(f.name))
    if (!target.startsWith(path.resolve(sandbox))) continue
    if (f.path) {
      if (fs.existsSync(f.path)) fs.copyFileSync(f.path, target)
    } else if (f.content != null) {
      fs.writeFileSync(target, String(f.content), 'utf8')
    }
  }
  return sandbox
}

function normalizeInputs(options, project) {
  const argv = Array.isArray(options.argv)
    ? options.argv.map(String)
    : String(options.argv || '').trim() ? String(options.argv).split(/\s+/) : []
  return {
    target: options.target || project.target?.path || null,
    argv,
    stdin: String(options.stdin ?? ''),
    env: options.env || {},
    files: Array.isArray(options.files) ? options.files : [],
    timeoutMs: Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
    label: options.label || null,
  }
}

/** Run the real target and persist its observable behaviour as a case. */
export async function recordOracle(workspace, slug, options = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const input = normalizeInputs(options, project)
  if (!input.target || !fs.existsSync(input.target)) throw new Error('Oracle target executable does not exist')

  const key = `oracle-${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 10)}`
  const sandbox = ensureSandbox(paths, key, input.files)
  const before = takeSnapshot(workspace, slug, { label: 'oracle-before', roots: [sandbox], registryKeys: [] })
  const run = await runProcess(input.target, {
    argv: input.argv, stdin: input.stdin, cwd: sandbox, env: input.env, timeoutMs: input.timeoutMs,
  })
  const after = takeSnapshot(workspace, slug, { label: 'oracle-after', roots: [sandbox], registryKeys: [] })
  const fileDiff = diffSnapshots(before.snapshot, after.snapshot)
  const observation = makeObservation(run, fileDiff, sandbox)

  const rec = recordCase(workspace, slug, {
    tool: 'oracle_native_scenario',
    title: input.label || `Oracle ${path.basename(input.target)}${input.argv.length ? ' ' + input.argv.join(' ') : ''}`,
    input: { ...input, sandbox },
    output: observation,
    status: run.ok ? (run.timedOut ? 'timeout' : 'recorded') : 'error',
  })

  const rawFile = path.join(paths.cases, `${rec.id}.oracle.json`)
  fs.writeFileSync(rawFile, JSON.stringify({ schema: 1, input: { ...input, sandbox }, run, fileDiff, observation }, null, 2) + '\n', 'utf8')

  const evId = `ev_oracle_${crypto.createHash('sha256').update(JSON.stringify({ target: input.target, argv: input.argv, observation })).digest('hex').slice(0, 12)}`
  addEvidence(workspace, slug, {
    id: evId,
    source: 'oracle',
    stage: 'behavior',
    note: `Oracle: ${path.basename(input.target)} exit ${observation.exit_code}, ${observation.steps.length} output steps`,
    file: `cases/${rec.id}.oracle.json`,
  })
  captureEvidence(workspace, slug, {
    ids: [evId], source: 'oracle', raw: JSON.stringify({ input, observation, run }),
  })

  return {
    case: rec,
    observation,
    evidence: [evId],
    files: [`cases/${rec.id}.oracle.json`],
    run: { ok: run.ok, error: run.error, timedOut: run.timedOut, exit_code: observation.exit_code },
  }
}

/**
 * Replay a recorded oracle against a candidate clone (or the original again,
 * when `selfCheck` is true) and write the resulting parity record.
 */
export async function runShadow(workspace, slug, caseId, options = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const loaded = readCase(workspace, slug, caseId)
  if (!loaded?.record) throw new Error(`No oracle case "${caseId}"`)
  const oracleFile = path.join(paths.cases, `${caseId}.oracle.json`)
  if (!fs.existsSync(oracleFile)) throw new Error('This case is not an oracle capture')
  const oracleRaw = JSON.parse(fs.readFileSync(oracleFile, 'utf8'))
  const input = oracleRaw.input || {}

  const selfCheck = Boolean(options.selfCheck)
  const shadowExe = selfCheck ? input.target : (options.shadowPath || project.clone?.entry || null)
  if (!shadowExe) throw new Error('No shadow executable. Provide shadowPath or use selfCheck.')
  if (!fs.existsSync(shadowExe)) throw new Error('Shadow executable does not exist')

  const key = `shadow-${String(caseId).replace(/[^a-z0-9_-]/gi, '')}-${crypto.createHash('sha256').update(String(shadowExe) + String(Date.now())).digest('hex').slice(0, 8)}`
  const sandbox = ensureSandbox(paths, key, input.files || [])
  const before = takeSnapshot(workspace, slug, { label: 'shadow-before', roots: [sandbox], registryKeys: [] })
  const run = await runProcess(shadowExe, {
    argv: input.argv || [], stdin: input.stdin || '', cwd: sandbox, env: input.env || {},
    timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS,
  })
  const after = takeSnapshot(workspace, slug, { label: 'shadow-after', roots: [sandbox], registryKeys: [] })
  const fileDiff = diffSnapshots(before.snapshot, after.snapshot)
  const observation = makeObservation(run, fileDiff, sandbox)
  const diff = diffOracle(oracleRaw.observation, observation)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const shadowFile = path.join(paths.cases, `${caseId}.shadow-${stamp}.json`)
  fs.writeFileSync(shadowFile, JSON.stringify({
    schema: 1,
    shadowPath: shadowExe,
    selfCheck,
    run,
    fileDiff,
    observation,
    diff,
  }, null, 2) + '\n', 'utf8')

  const parity = setCaseParity(workspace, slug, caseId, {
    status: !run.ok ? 'error' : diff.status,
    note: selfCheck ? `Oracle self-check: ${diff.note}` : `Shadow (${path.basename(shadowExe)}): ${diff.note}`,
    dims: diff.dims,
    shadowPath: shadowExe,
    selfCheck,
    shadowFile: path.relative(paths.dir, shadowFile).replace(/\\/g, '/'),
    stderr: run.stderr.slice(0, 1000),
  })

  const evId = `ev_shadow_${crypto.createHash('sha256').update(String(caseId) + shadowExe + stable(diff)).digest('hex').slice(0, 12)}`
  addEvidence(workspace, slug, {
    id: evId,
    source: selfCheck ? 'oracle-selfcheck' : 'shadow',
    stage: 'parity',
    note: `${selfCheck ? 'Self-check' : 'Shadow'} ${path.basename(shadowExe)}: ${diff.status}`,
    file: path.relative(paths.dir, shadowFile).replace(/\\/g, '/'),
  })

  return {
    parity,
    diff,
    observation,
    evidence: [evId],
    shadowFile: path.relative(paths.dir, shadowFile).replace(/\\/g, '/'),
  }
}

/** Summarise oracle cases and persist a markdown report. */
export function oracleReport(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const cases = (project.cases || [])
    .filter((c) => c.provider === 'oracle_native_scenario')
    .slice()
    .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))

  const lines = [
    '# Oracle / shadow runtime', '',
    `${cases.length} oracle case(s).`, '',
    '| Case | Target | argv | Exit | Parity | Changed dimensions |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const c of cases) {
    const rawFile = path.join(paths.cases, `${c.id}.oracle.json`)
    let target = ''
    let argv = ''
    try {
      const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'))
      target = path.basename(raw.input?.target || '')
      argv = (raw.input?.argv || []).join(' ')
    } catch { /* raw capture missing */ }
    const changed = (c.parity?.dims || []).filter((d) => d.status === 'changed').map((d) => d.name).join(', ') || '—'
    lines.push(`| ${c.id} | ${target} | ${argv || '—'} | ${c.expected?.exit_code ?? '—'} | ${c.parity?.status || 'unchecked'} | ${changed} |`)
  }
  lines.push('')
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'oracle.md'), lines.join('\n'), 'utf8')
  return { count: cases.length, cases: cases.map((c) => ({ id: c.id, title: c.title, parity: c.parity?.status || 'unchecked' })), file: 'reports/oracle.md' }
}

export function readOracleRaw(workspace, slug, caseId) {
  const file = path.join(projectPaths(workspace, slug).cases, `${caseId}.oracle.json`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
