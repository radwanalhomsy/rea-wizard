/**
 * Repair loop.
 *
 * Turns measured Oracle/Shadow gaps into a concrete, verifiable fix. The fix
 * is deliberately narrow and honest: it is a TRANSCRIPT REPLAY of an oracle
 * observation that has first been proven deterministic by a self-check. It
 * reproduces exit code, stdout, stderr and captured file side effects for
 * exactly that recorded input. It is not a semantic reimplementation of the
 * target, and the generated runner says so in its own header.
 *
 * Cases that have no determinism proof, or whose file side effects were too
 * large to capture, are not repaired. They become blocking unknowns instead.
 *
 * Outputs (all deterministic and byte-stable for the same project state):
 *   spec/repairs.json        repair plan with evidence citations
 *   reports/repairs.md       human-readable plan
 *   clone/fixtures/<case>.json   full payload for one replay
 *   clone/repair-runner.mjs      Node/Electron-safe replay runner
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  getProject, projectPaths, updateProject, addEvidence, addUnknown,
} from './cloneStore.mjs'
import { readOracleRaw } from './cloneOracle.mjs'

const PLAN_VALUE_CAP = 4000
const CASE_ID = /^case_[A-Za-z0-9_-]+$/

/* ----------------------------------------------------------------- helpers */

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
}

function rel(paths, file) {
  return path.relative(paths.dir, file).split(path.sep).join('/')
}

function stable(value) {
  return JSON.stringify(value ?? null)
}

function digest(value, n = 12) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex').slice(0, n)
}

function clip(value, cap = PLAN_VALUE_CAP) {
  const text = String(value ?? '')
  return text.length > cap ? { text: text.slice(0, cap), truncated: true, bytes: text.length } : { text, truncated: false, bytes: text.length }
}

function oracleCases(project) {
  return (project.cases || [])
    .filter((c) => c.provider === 'oracle_native_scenario')
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/** List durable shadow captures for one case, oldest first. */
function shadowCaptures(paths, caseId) {
  let names = []
  try { names = fs.readdirSync(paths.cases) } catch { return [] }
  return names
    .filter((n) => n.startsWith(`${caseId}.shadow-`) && n.endsWith('.json'))
    .sort()
    .map((n) => ({ file: `${caseId}/${n}`, data: readJson(path.join(paths.cases, n)) }))
    .filter((x) => x.data)
}

/* ---------------------------------------------------------------- analysis */

function buildPlan(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)

  const cases = []
  for (const meta of oracleCases(project)) {
    const caseId = meta.id
    const raw = readOracleRaw(workspace, slug, caseId)
    if (!raw?.observation) continue

    const obs = raw.observation
    const shadows = shadowCaptures(paths, caseId)
    const proof = shadows.find((s) => s.data.selfCheck && s.data.diff?.status === 'match') || null
    const lastShadow = shadows.slice().reverse().find((s) => !s.data.selfCheck) || null
    const verified = shadows.some((s) => s.data.repairCase && s.data.diff?.status === 'match')
    const fileContents = Array.isArray(raw.fileContents) ? raw.fileContents : []
    const capturedFiles = new Set(fileContents.map((f) => `${f.path}|${f.operation}`))

    // Every file the oracle reported but we could not capture is a blocker.
    const missingFiles = (obs.files || []).filter((f) =>
      !capturedFiles.has(`${f.path}|${f.operation}`) && !capturedFiles.has(`${f.path}|write`),
    )

    const repairs = [
      { dim: 'exit code', kind: 'exit-code', value: obs.exit_code ?? 0, source: `cases/${caseId}.oracle.json` },
      { dim: 'stdout', kind: 'stdout', value: clip(obs.stdout, PLAN_VALUE_CAP), source: `cases/${caseId}.oracle.json` },
      { dim: 'stderr', kind: 'stderr', value: clip(obs.stderr, PLAN_VALUE_CAP), source: `cases/${caseId}.oracle.json` },
      { dim: 'steps', kind: 'derived', value: `${(obs.steps || []).length} steps derive from stdout`, source: 'oracle:stepsFromStdout' },
    ]
    if (fileContents.length) {
      repairs.push({
        dim: 'files',
        kind: 'files',
        value: fileContents.map((f) => ({ path: f.path, operation: f.operation, size: f.size })),
        source: `cases/${caseId}.oracle.json`,
      })
    }

    const blockers = []
    if (!proof) blockers.push('No self-check match: replay determinism is unproven.')
    if (missingFiles.length) blockers.push(`${missingFiles.length} file side effect(s) were not captured.`)

    const status = blockers.length ? 'needs-selfcheck-or-capture'
      : verified ? 'verified'
        : 'planned'

    cases.push({
      case: caseId,
      title: meta.title || caseId,
      evidence: [`ev_oracle_${digest({ target: raw.input?.target, argv: raw.input?.argv, observation: obs })}`],
      deterministic: Boolean(proof),
      proof: proof ? { file: proof.file, note: 'Oracle re-run matched itself on every dimension.' } : null,
      baseline: lastShadow ? {
        file: lastShadow.file,
        status: lastShadow.data.diff?.status || 'unknown',
        changed: (lastShadow.data.diff?.dims || []).filter((d) => d.status === 'changed').map((d) => d.name),
      } : null,
      verified,
      repairs,
      files: fileContents.map((f) => ({ path: f.path, operation: f.operation, size: f.size })),
      status,
      blockers,
    })

    // Keep the full payload for applyRepairs; it is never written to the plan.
    cases[cases.length - 1]._fixture = {
      schema: 1,
      case: caseId,
      kind: 'transcript-replay',
      evidence: cases[cases.length - 1].evidence,
      exit_code: obs.exit_code ?? 0,
      stdout: obs.stdout || '',
      stderr: obs.stderr || '',
      files: fileContents,
    }
  }

  const count = (status) => cases.filter((c) => c.status === status).length
  const plan = {
    schema: 1,
    project: project.slug,
    kind: 'transcript-replay',
    honesty: 'A proven deterministic replay of recorded observations, not a semantic clone of the target.',
    cases: cases.map(({ _fixture, ...c }) => c),
    summary: {
      total: cases.length,
      planned: count('planned'),
      verified: count('verified'),
      blocked: count('needs-selfcheck-or-capture'),
    },
  }
  return { project, paths, plan, cases }
}

function planMarkdown(plan) {
  const lines = [
    '# Repair plan', '',
    plan.honesty, '',
    `${plan.summary.total} oracle case(s) · ${plan.summary.planned} planned · ` +
      `${plan.summary.verified} verified · ${plan.summary.blocked} blocked`, '',
    '| Case | Determinism | Baseline | Repairs | Status |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const c of plan.cases) {
    lines.push(
      `| ${c.case} | ${c.deterministic ? 'proven' : 'unproven'} | ` +
      `${c.baseline ? `${c.baseline.status} (${c.baseline.changed.join(', ') || 'no changes'})` : 'no shadow'} | ` +
      `${c.repairs.length} | ${c.status} |`,
    )
  }
  lines.push('')
  const blocked = plan.cases.filter((c) => c.blockers.length)
  if (blocked.length) {
    lines.push('## Blockers', '')
    for (const c of blocked) lines.push(`- ${c.case}: ${c.blockers.join(' ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Compute the repair plan and persist spec/repairs.json + reports/repairs.md. */
export function analyzeRepairs(workspace, slug) {
  const { paths, plan } = buildPlan(workspace, slug)
  write(path.join(paths.spec, 'repairs.json'), JSON.stringify(plan, null, 2))
  write(path.join(paths.reports, 'repairs.md'), planMarkdown(plan))
  return plan
}

/* ------------------------------------------------------------ apply / write */

const RUNNER = `// Generated by REA Studio. Transcript replay clone — NOT a semantic reimplementation.
// It reproduces one proven-deterministic oracle observation for one exact input.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const caseId = process.argv[2]
if (!/^case_[A-Za-z0-9_-]+$/.test(caseId || '')) {
  console.error('usage: repair-runner.mjs <case-id>')
  process.exit(2)
}

const fixtureFile = fileURLToPath(new URL('./fixtures/' + caseId + '.json', import.meta.url))
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
if (fixture.kind !== 'transcript-replay') {
  console.error('unsupported fixture kind: ' + fixture.kind)
  process.exit(2)
}

for (const f of fixture.files || []) {
  const target = path.resolve(process.cwd(), f.path)
  if (f.operation === 'deleted') {
    try { fs.unlinkSync(target) } catch { }
    continue
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const buf = f.encoding === 'base64' ? Buffer.from(f.content || '', 'base64') : Buffer.from(f.content || '', 'utf8')
  fs.writeFileSync(target, buf)
}

if (fixture.stdout) process.stdout.write(fixture.stdout)
if (fixture.stderr) process.stderr.write(fixture.stderr)
process.exit(fixture.exit_code ?? 0)
`

/**
 * Write fixtures + the replay runner for every unblocked case, then record
 * evidence. Blocked cases get a blocking unknown rather than a fake repair.
 */
export function applyRepairs(workspace, slug, { caseIds = null } = {}) {
  const built = buildPlan(workspace, slug)
  const { project, paths, plan, cases } = built
  const allow = Array.isArray(caseIds) && caseIds.length ? new Set(caseIds.map(String)) : null
  const writable = cases.filter((c) =>
    (!allow || allow.has(c.case)) && c.deterministic && !c.blockers.length,
  )

  const written = []
  for (const c of writable) {
    write(path.join(paths.clone, 'fixtures', `${c.case}.json`), JSON.stringify(c._fixture, null, 2))
    written.push(`clone/fixtures/${c.case}.json`)
  }
  if (writable.length) {
    write(path.join(paths.clone, 'repair-runner.mjs'), RUNNER)
    written.push('clone/repair-runner.mjs')
  }

  // Refresh the plan so it reflects the newly written fixtures/verification.
  const final = analyzeRepairs(workspace, slug)

  const evId = `ev_repair_${digest({ slug, cases: writable.map((c) => c.case), files: written })}`
  if (writable.length) {
    addEvidence(workspace, slug, {
      id: evId,
      source: 'repair',
      stage: 'build',
      note: `Transcript repair runner for ${writable.length} case(s): ${writable.map((c) => c.case).join(', ')}`,
      file: written.includes('clone/repair-runner.mjs') ? 'clone/repair-runner.mjs' : null,
    })
  }

  for (const c of cases) {
    if (!c.blockers.length) continue
    const question = `Repair blocked for ${c.case}: ${c.blockers.join(' ')}`
    const exists = (getProject(workspace, slug)?.unknowns || [])
      .some((u) => u.status === 'open' && u.question === question)
    if (!exists) addUnknown(workspace, slug, { question, stage: 'build', blocking: true, evidence: c.evidence[0] || '' })
  }

  if (writable.length) {
    const current = getProject(workspace, slug)
    updateProject(workspace, slug, {
      clone: {
        ...(current.clone || {}),
        repairRunner: 'clone/repair-runner.mjs',
        repairKind: 'transcript-replay',
      },
    })
  }

  return {
    ok: true,
    applied: writable.map((c) => c.case),
    blocked: final.summary.blocked,
    verified: final.summary.verified,
    written: Array.from(new Set(written)).sort(),
    evidence: writable.length ? [evId] : [],
    plan: final,
  }
}

/* ------------------------------------------------------------------ status */

export function repairStatus(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  const plan = readJson(path.join(paths.spec, 'repairs.json'))
  if (!plan) {
    return { ok: true, applied: false, summary: { total: 0, planned: 0, verified: 0, blocked: 0 }, cases: [] }
  }
  return {
    ok: true,
    applied: fs.existsSync(path.join(paths.clone, 'repair-runner.mjs')),
    summary: plan.summary,
    cases: (plan.cases || []).map((c) => ({
      case: c.case, status: c.status, verified: Boolean(c.verified),
      deterministic: Boolean(c.deterministic), repairs: (c.repairs || []).length,
      blockers: c.blockers || [],
    })),
  }
}

export function repairGet(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  const plan = readJson(path.join(paths.spec, 'repairs.json'))
  const fixtures = []
  try {
    const dir = path.join(paths.clone, 'fixtures')
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.json')) fixtures.push(`clone/fixtures/${name}`)
    }
  } catch { /* no fixtures yet */ }
  return {
    ok: true,
    plan,
    status: repairStatus(workspace, slug),
    runner: fs.existsSync(path.join(paths.clone, 'repair-runner.mjs')) ? 'clone/repair-runner.mjs' : null,
    fixtures: fixtures.sort(),
  }
}
