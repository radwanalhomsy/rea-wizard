/**
 * Behavior Fingerprint + Drift Detector.
 *
 * A fingerprint is a deterministic digest of behaviour that was actually
 * measured: exit codes, output, step sequences and file side effects from
 * Oracle captures, plus step sequences from recorded journeys. It is not a
 * guess about what the target "should" do.
 *
 * Drift detection re-runs each replayable Oracle case with its original input
 * and compares the fresh observation against the stored signature. Changes
 * are reported per dimension with statuses match|changed|error|unavailable.
 * Nothing is silently repaired and no success is claimed: a changed case
 * becomes a non-blocking unknown that the Gap Planner can rank.
 *
 * Outputs (all deterministic): spec/fingerprint.json, reports/fingerprint.md,
 * spec/drift.json, reports/drift.md.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths, readCase, addEvidence, addUnknown } from './cloneStore.mjs'
import { readOracleRaw, recaptureOracle } from './cloneOracle.mjs'

const DIMENSIONS = ['exit code', 'stdout', 'stderr', 'steps', 'files']
const HONESTY = 'A deterministic digest of measured observations. Unmeasured behaviour is absent, never assumed.'

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

function digest(value, n = 12) {
  return hash(value).slice(0, n)
}

function preview(value, cap = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap)}…` : clean
}

function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, 60).map((s, i) => ({
    index: i + 1,
    action: s?.action ?? s?.type ?? s?.kind ?? null,
    target: s?.target ?? s?.selector ?? s?.url ?? null,
    status: s?.status ?? s?.result ?? null,
  }))
}

function normalizeFiles(files) {
  return (Array.isArray(files) ? files : []).map((f) => ({
    path: String(f?.path ?? ''),
    operation: String(f?.operation ?? 'write'),
    size: f?.size ?? null,
  })).sort((a, b) => `${a.path}|${a.operation}`.localeCompare(`${b.path}|${b.operation}`))
}

function signatureFromObservation(obs) {
  return {
    'exit code': obs?.exit_code ?? null,
    stdout: String(obs?.stdout ?? ''),
    stderr: String(obs?.stderr ?? ''),
    steps: normalizeSteps(obs?.steps),
    files: normalizeFiles(obs?.files),
  }
}

/** The same evidence ID that recordOracle derives from its capture. */
function oracleEvidenceId(raw) {
  return `ev_oracle_${crypto.createHash('sha256').update(JSON.stringify({
    target: raw?.input?.target,
    argv: raw?.input?.argv,
    observation: raw?.observation,
  })).digest('hex').slice(0, 12)}`
}

function targetInfo(project) {
  return { path: project.target?.path || null, sha256: project.target?.sha256 || null }
}

/* --------------------------------------------------------------- fingerprint */

export function buildFingerprint(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const cases = []

  for (const meta of (project.cases || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const raw = readOracleRaw(workspace, slug, meta.id)
    let kind = 'journey'
    let signature
    let replayable = false
    let evidence = []

    if (raw?.observation) {
      kind = 'oracle'
      signature = signatureFromObservation(raw.observation)
      replayable = true
      evidence = [oracleEvidenceId(raw)]
    } else {
      let steps = []
      try {
        const c = readCase(workspace, slug, meta.id)
        steps = normalizeSteps(c.record?.steps || c.index?.steps)
      } catch { /* case file missing; nothing measured */ }
      if (!steps.length) continue
      signature = { steps }
    }

    const caseDigest = digest(signature)
    cases.push({
      case: meta.id,
      title: meta.title || meta.id,
      kind,
      replayable,
      evidence,
      digest: caseDigest,
      signature,
    })
  }

  const target = targetInfo(project)
  const fingerprint = {
    schema: 1,
    project: project.slug,
    honesty: HONESTY,
    target,
    cases,
    digest: digest({ target, cases: cases.map((c) => ({ case: c.case, digest: c.digest })) }),
    summary: {
      cases: cases.length,
      replayable: cases.filter((c) => c.replayable).length,
      steps: cases.reduce((n, c) => n + (c.signature.steps?.length || 0), 0),
      files: cases.reduce((n, c) => n + (c.signature.files?.length || 0), 0),
      evidence: cases.reduce((n, c) => n + c.evidence.length, 0),
    },
  }

  write(path.join(paths.spec, 'fingerprint.json'), JSON.stringify(fingerprint, null, 2))
  write(path.join(paths.reports, 'fingerprint.md'), fingerprintMarkdown(fingerprint))

  const evId = `ev_fp_${fingerprint.digest}`
  addEvidence(workspace, slug, {
    id: evId,
    source: 'fingerprint',
    stage: 'behavior',
    note: `Behavior fingerprint: ${fingerprint.summary.cases} case(s), ${fingerprint.summary.steps} step(s), digest ${fingerprint.digest}`,
    file: 'spec/fingerprint.json',
  })

  return { ok: true, fingerprint, evidence: [evId], files: ['spec/fingerprint.json', 'reports/fingerprint.md'] }
}

function fingerprintMarkdown(fp) {
  const lines = [
    '# Behavior fingerprint', '',
    fp.honesty, '',
    `Digest: \`${fp.digest}\``, '',
    `${fp.summary.cases} case(s) · ${fp.summary.replayable} re-runnable · ${fp.summary.steps} step(s) · ${fp.summary.files} file effect(s)`, '',
    '| Case | Kind | Re-runnable | Dimensions | Digest | Evidence |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const c of fp.cases) {
    lines.push(`| ${c.case} | ${c.kind} | ${c.replayable ? 'yes' : 'no'} | ` +
      `${Object.keys(c.signature).length} | \`${c.digest}\` | ${c.evidence.join(', ') || '—'} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/* -------------------------------------------------------------------- drift */

function compareSignatures(before, after) {
  const names = DIMENSIONS.filter((n) => n in before || n in after)
  const dims = names.map((name) => {
    const a = before[name] ?? null
    const b = after[name] ?? null
    const same = JSON.stringify(a) === JSON.stringify(b)
    return {
      name,
      status: same ? 'match' : 'changed',
      detail: same ? preview(a) : `${preview(a) || '∅'} → ${preview(b) || '∅'}`,
    }
  })
  return {
    status: dims.some((d) => d.status === 'changed') ? 'changed' : 'match',
    dims,
  }
}

/**
 * Re-measure the target for every replayable case and diff against the stored
 * fingerprint. This executes the original target executable, never the clone.
 */
export async function checkDrift(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const fingerprint = readJson(path.join(paths.spec, 'fingerprint.json'))
  if (!fingerprint) {
    return {
      ok: true, applied: false, status: 'unavailable',
      error: 'No fingerprint yet. Build one from measured cases first.',
      cases: [], summary: { total: 0 },
    }
  }

  const results = []
  for (const entry of fingerprint.cases || []) {
    const base = {
      case: entry.case, title: entry.title, kind: entry.kind,
      expectedDigest: entry.digest, evidence: entry.evidence || [],
    }
    if (!entry.replayable) {
      results.push({
        ...base, status: 'unavailable',
        detail: 'No re-runnable Oracle capture for this case.',
        dims: [],
      })
      continue
    }

    const current = await recaptureOracle(workspace, slug, entry.case)
    if (current.status === 'unavailable' || !current.observation) {
      results.push({
        ...base, status: 'unavailable',
        detail: current.error || 'Target could not be re-run.',
        dims: [],
      })
      continue
    }

    const diff = compareSignatures(entry.signature, signatureFromObservation(current.observation))
    const status = current.status === 'error' ? 'error' : diff.status
    results.push({
      ...base,
      status,
      detail: current.error || diff.dims.filter((d) => d.status === 'changed').map((d) => d.name).join(', ') || 'No observable change.',
      dims: diff.dims,
      observedDigest: digest(signatureFromObservation(current.observation)),
      run: current.run,
    })
  }

  const target = targetInfo(project)
  const targetStatus = JSON.stringify(target) === JSON.stringify(fingerprint.target) ? 'match' : 'changed'
  const changed = results.filter((r) => r.status === 'changed')
  const errored = results.filter((r) => r.status === 'error')
  const unavailable = results.filter((r) => r.status === 'unavailable')
  const overall = errored.length ? 'error'
    : changed.length || targetStatus === 'changed' ? 'changed'
      : unavailable.length === results.length ? 'unavailable' : 'match'

  const report = {
    schema: 1,
    project: project.slug,
    honesty: 'A fresh measurement of the original target compared with the stored fingerprint. No repair is implied.',
    fingerprint: fingerprint.digest,
    target: { ...target, status: targetStatus },
    status: overall,
    cases: results,
    summary: {
      total: results.length,
      match: results.filter((r) => r.status === 'match').length,
      changed: changed.length,
      error: errored.length,
      unavailable: unavailable.length,
    },
  }
  write(path.join(paths.spec, 'drift.json'), JSON.stringify(report, null, 2))
  write(path.join(paths.reports, 'drift.md'), driftMarkdown(report))

  const evidence = []
  for (const r of results) {
    const evId = `ev_drift_${digest({ fingerprint: fingerprint.digest, case: r.case, status: r.status, observedDigest: r.observedDigest || null })}`
    addEvidence(workspace, slug, {
      id: evId,
      source: 'drift',
      stage: 'behavior',
      note: `Drift ${r.case}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`,
      file: 'spec/drift.json',
    })
    evidence.push(evId)
  }

  for (const r of changed) {
    const question = `Behavior drift detected in ${r.case}: ${r.dims.filter((d) => d.status === 'changed').map((d) => d.name).join(', ')}`
    const exists = (getProject(workspace, slug)?.unknowns || [])
      .some((u) => u.status === 'open' && u.question === question)
    if (!exists) addUnknown(workspace, slug, {
      question, stage: 'behavior', blocking: false, evidence: evidence[results.indexOf(r)] || '',
    })
  }

  return {
    ok: true, applied: true, status: overall, report,
    evidence, files: ['spec/drift.json', 'reports/drift.md'],
  }
}

function driftMarkdown(report) {
  const lines = [
    '# Behavior drift', '',
    report.honesty, '',
    `Fingerprint: \`${report.fingerprint}\` · status: **${report.status}** · target: **${report.target.status}**`, '',
    `${report.summary.total} case(s) · ${report.summary.match} match · ${report.summary.changed} changed · ` +
      `${report.summary.error} error · ${report.summary.unavailable} unavailable`, '',
    '| Case | Status | Changed dimensions | Detail |',
    '| --- | --- | --- | --- |',
  ]
  for (const c of report.cases) {
    const dims = c.dims.filter((d) => d.status === 'changed').map((d) => d.name).join(', ') || '—'
    lines.push(`| ${c.case} | ${c.status} | ${dims} | ${String(c.detail).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/* --------------------------------------------------------------------- status */

export function fingerprintStatus(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  const fp = readJson(path.join(paths.spec, 'fingerprint.json'))
  const drift = readJson(path.join(paths.spec, 'drift.json'))
  return {
    ok: true,
    fingerprint: fp ? { digest: fp.digest, cases: fp.summary?.cases || 0, steps: fp.summary?.steps || 0 } : null,
    drift: drift ? { status: drift.status, changed: drift.summary?.changed || 0, cases: drift.summary?.total || 0 } : null,
  }
}

export function fingerprintGet(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  return {
    ok: true,
    fingerprint: readJson(path.join(paths.spec, 'fingerprint.json')),
    drift: readJson(path.join(paths.spec, 'drift.json')),
    status: fingerprintStatus(workspace, slug),
  }
}
