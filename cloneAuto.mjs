/**
 * Auto Clone — one-click, bounded orchestration of the measured clone steps.
 *
 * The order is dependency-driven, not cosmetic:
 *   create → explore → uimap → full GUI clone → artifacts → protocol → formats
 *   → oracle → self-check → repair → verify → fingerprint → drift → facts → IR
 *   → fidelity → stages → spec → scaffold → gaps
 *
 * Every step is recorded with its own status. A tool that cannot observe the
 * target reports `unavailable`; an unproven repair is never called a fix; a
 * stage is only completed when its evidence gate actually allows it. The GUI
 * tools launch the chosen executable with a hard time budget and close it
 * afterwards.
 */

import fs from 'node:fs'
import path from 'node:path'
import * as store from './cloneStore.mjs'
import { exploreTarget } from './cloneExplore.mjs'
import { captureUiMap, captureArtifacts } from './cloneCapture.mjs'
import { captureGuiTree, generateGuiClone } from './cloneGui.mjs'
import { captureNetstat } from './cloneProtocol.mjs'
import { inferFromArtifacts } from './cloneFormats.mjs'
import { recordOracle, runShadow } from './cloneOracle.mjs'
import { applyRepairs } from './cloneRepair.mjs'
import { extractFacts } from './cloneFacts.mjs'
import { compileIR } from './cloneIR.mjs'
import { compileSpec, scaffold } from './cloneSpec.mjs'
import { buildFingerprint, checkDrift } from './cloneFingerprint.mjs'
import { computeFidelity } from './cloneFidelity.mjs'
import { analyzeGaps } from './cloneGaps.mjs'

export const SCHEMA_VERSION = 1
export const HONESTY =
  'Auto Clone executes measured steps in dependency order. It never invents coverage: ' +
  'unavailable tools, unproven repairs and manual provenance work are reported, not hidden.'

const STEP_DEFS = [
  { id: 'create', title: 'Create project and hash target', tool: 'cloneStore', stage: 'inventory', critical: true },
  { id: 'explore', title: 'Inventory target', tool: 'explore', stage: 'inventory' },
  { id: 'uimap', title: 'Capture UI map', tool: 'uimap', stage: 'behavior' },
  { id: 'gui', title: 'Read full GUI and generate clone', tool: 'gui', stage: 'build' },
  { id: 'artifacts', title: 'Capture artifact diff', tool: 'artifacts', stage: 'behavior' },
  { id: 'protocol', title: 'Watch network endpoints', tool: 'protocol', stage: 'behavior' },
  { id: 'formats', title: 'Infer data formats', tool: 'formats', stage: null },
  { id: 'oracle', title: 'Record Oracle scenario', tool: 'oracle', stage: 'behavior' },
  { id: 'selfcheck', title: 'Prove target determinism', tool: 'oracle-selfcheck', stage: 'behavior' },
  { id: 'repair', title: 'Apply measured repair', tool: 'repair', stage: 'build' },
  { id: 'verify', title: 'Verify repair parity', tool: 'repair-verify', stage: 'parity' },
  { id: 'fingerprint', title: 'Build behavior fingerprint', tool: 'fingerprint', stage: 'behavior' },
  { id: 'drift', title: 'Check behavior drift', tool: 'drift', stage: 'behavior' },
  { id: 'facts', title: 'Extract fact ledger', tool: 'facts', stage: 'spec' },
  { id: 'ir', title: 'Compile clone IR', tool: 'ir', stage: 'spec' },
  { id: 'fidelity', title: 'Compute fidelity score', tool: 'fidelity', stage: null },
  { id: 'stages', title: 'Advance evidence-backed stage gates', tool: 'cloneStore', stage: null },
  { id: 'spec', title: 'Compile specification', tool: 'spec', stage: 'spec' },
  { id: 'scaffold', title: 'Generate clone scaffold', tool: 'scaffold', stage: 'build' },
  { id: 'gaps', title: 'Plan measured gaps', tool: 'gaps', stage: null },
]

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

const asList = (value) => {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v)
  return typeof value === 'string' && value ? [value] : []
}

const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Distinguish "this host/tool cannot observe it" from a real orchestration fault. */
function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase()
  if (
    /no matching window|windows only|unavailable|capability_unavailable|no artifact diff|no existing artifact files|no fingerprint|no replayable|not an oracle capture|no repair runner|no repair fixture|no shadow executable|no oracle case/.test(text)
  ) return 'unavailable'
  return 'error'
}

function shortHash(value) {
  return typeof value === 'string' && value ? value.slice(0, 12) : 'not hashed'
}

/**
 * Run the full measured pipeline for one executable.
 *
 * `emit` receives small progress events so the renderer can show each step as
 * it finishes. It is optional and never affects the recorded result.
 */
export async function runAutoClone(workspace, options = {}, emit = () => {}) {
  const targetPath = path.resolve(String(options.targetPath || ''))
  if (!targetPath || !fs.existsSync(targetPath)) throw new Error('Choose an existing executable file')
  const stat = fs.statSync(targetPath)
  if (!stat.isFile()) throw new Error('The auto-clone target must be a file')

  const name = String(options.name || '').trim() || path.basename(targetPath).replace(/\.[^.]+$/, '') || 'Auto clone'
  const notes = String(options.notes || '')
  const seconds = clamp(options.seconds, 1, 30, 5)
  const protocolSeconds = clamp(options.protocolSeconds, 1, 60, Math.max(8, seconds))
  const timeoutMs = clamp(options.timeoutMs, 1000, 120000, 20000)
  const maxTotalMs = clamp(options.maxTotalMs, 30000, 900000, 240000)
  const language = options.language === 'python' ? 'python' : 'typescript'

  const startedAt = Date.now()
  const deadline = startedAt + maxTotalMs
  const steps = []
  const progress = new Map()
  let slug = null
  let score = null
  let gaps = null
  let oracleCase = null
  let deterministic = false
  let parityMatched = false
  let stopped = false

  emit({ type: 'start', target: targetPath, total: STEP_DEFS.length })

  async function step(def, fn) {
    if (stopped) return null
    const index = steps.length + 1
    const began = Date.now()
    emit({ type: 'step', phase: 'start', id: def.id, title: def.title, index, total: STEP_DEFS.length })

    let result
    if (Date.now() >= deadline) {
      result = {
        status: 'skipped',
        detail: `Overall time budget reached (${Math.round(maxTotalMs / 1000)}s)`,
      }
    } else {
      try {
        const out = await fn()
        result = out && typeof out === 'object' ? out : { detail: String(out ?? '') }
        if (!result.status) result.status = 'ok'
      } catch (e) {
        result = { status: classifyError(e), detail: e?.message || String(e) }
      }
    }

    const record = {
      id: def.id,
      title: def.title,
      tool: def.tool,
      stage: def.stage,
      status: result.status,
      measurement: result.measurement ?? null,
      detail: String(result.detail || result.status),
      evidence: asList(result.evidence),
      files: asList(result.files),
      startedAt: new Date(began).toISOString(),
      finishedAt: new Date().toISOString(),
      ms: Date.now() - began,
    }
    steps.push(record)
    progress.set(def.id, { id: def.id, title: def.title, status: record.status, detail: record.detail })
    emit({
      type: 'step', phase: 'done', id: def.id, title: def.title, index,
      total: STEP_DEFS.length, status: record.status, detail: record.detail,
    })
    if (def.critical && record.status !== 'ok') stopped = true
    return record.status === 'ok' ? result : null
  }

  function applyStages() {
    const byId = new Map(steps.map((s) => [s.id, s]))
    const ok = (id) => byId.get(id)?.status === 'ok'
    const attempted = (id) => Boolean(byId.get(id))
    const project = store.getProject(workspace, slug)
    if (!project) return { status: 'unavailable', detail: 'Project is missing', updated: [] }

    const wanted = [
      {
        id: 'inventory', ready: ok('explore'), active: attempted('explore'),
        note: 'Auto Clone: target inventory captured',
      },
      {
        id: 'behavior', ready: ok('oracle') && ok('selfcheck'), active: attempted('oracle'),
        note: 'Auto Clone: Oracle scenario recorded and determinism self-check measured',
      },
      {
        id: 'spec', ready: ok('facts') && ok('ir'), active: attempted('facts') || attempted('ir'),
        note: 'Auto Clone: fact ledger and clone IR compiled',
      },
      {
        id: 'build', ready: false, active: ok('repair') || ok('verify'),
        note: 'Auto Clone: measured repair recorded; implementation stubs still need work',
      },
      {
        id: 'parity', ready: ok('verify') && parityMatched, active: attempted('verify') || attempted('selfcheck'),
        note: parityMatched
          ? 'Auto Clone: repair replay matched the Oracle observation'
          : 'Auto Clone: parity not proven for a clone replay',
      },
      {
        id: 'provenance', ready: false, active: true,
        note: 'Auto Clone: exposure checklist generated; license and redistribution review is manual',
      },
    ]

    const updated = []
    for (const item of wanted) {
      const gate = store.stageGate(project, item.id)
      const status = item.ready && gate.allowed
        ? 'complete'
        : item.ready && !gate.allowed
          ? 'blocked'
          : item.active ? 'active' : 'pending'
      const note = item.ready && !gate.allowed
        ? `Auto Clone blocked by ${gate.blockers.length} open blocking unknown(s)`
        : item.note
      store.setStage(workspace, slug, item.id, { status, note })
      updated.push({ id: item.id, status })
    }
    return {
      status: 'ok',
      detail: updated.map((u) => `${u.id}=${u.status}`).join(', '),
      updated,
    }
  }

  /* ---------------------------------------------------------------- pipeline */

  await step(STEP_DEFS[0], async () => {
    const created = store.createProject(workspace, { name, targetPath, notes })
    slug = created.slug
    const target = await store.setTarget(workspace, slug, targetPath)
    return {
      detail: `${created.name} (${slug}); SHA-256 ${shortHash(target.sha256)}`,
      files: ['project.json'],
    }
  })

  if (slug) {
    await step(STEP_DEFS[1], async () => {
      const r = await exploreTarget(workspace, slug, { targetPath })
      const current = store.getProject(workspace, slug)
      if (current?.target && current.target.kind !== r.file?.kind) {
        store.updateProject(workspace, slug, { target: { ...current.target, kind: r.file?.kind || null } })
      }
      const shape = r.pe
        ? `${r.pe.format} ${r.pe.arch} ${r.pe.bits}-bit`
        : r.parseError ? `format unknown (${r.parseError})` : r.file?.kind || 'unknown format'
      return {
        detail: `${shape}; ${r.strings} strings`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[2], async () => {
      const r = await captureUiMap(workspace, slug, {
        target: targetPath, seconds, closeAfter: true, label: 'auto-uimap',
      })
      return {
        detail: `${r.controls} controls from ${r.title || r.source}`,
        evidence: [r.evidence],
        files: [r.file],
      }
    })

    await step(STEP_DEFS[3], async () => {
      const r = await captureGuiTree(workspace, slug, {
        target: targetPath, seconds, closeAfter: true, max: 4000, depth: 12,
      })
      const g = generateGuiClone(workspace, slug)
      return {
        detail: `${r.summary.nodes} nodes, ${r.summary.menus} menu(s), ${r.summary.submenus} submenu nodes, ` +
          `${r.summary.tabs} tab(s); clone ${g.verification?.completeness ?? 0}`,
        evidence: [r.evidence],
        files: [...r.files, ...g.files],
      }
    })

    await step(STEP_DEFS[4], async () => {
      const r = await captureArtifacts(workspace, slug, {
        target: targetPath, seconds, closeAfter: true, label: 'auto-artifacts',
      })
      return {
        detail: `${r.artifacts} artifact(s)${r.launchedPid ? ` from PID ${r.launchedPid}` : ''}`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[5], async () => {
      const r = await captureNetstat(workspace, slug, {
        target: targetPath, seconds: protocolSeconds, intervalMs: 1000, closeAfter: true,
      })
      return {
        detail: `${r.endpoints} TCP endpoint(s)`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[6], async () => {
      const r = inferFromArtifacts(workspace, slug, { limit: 24 })
      return {
        detail: `${r.formats.length} format(s) inferred from observed artifacts`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[7], async () => {
      const r = await recordOracle(workspace, slug, {
        target: targetPath,
        timeoutMs,
        label: `Auto clone ${path.basename(targetPath)}`,
      })
      oracleCase = r.case?.id || null
      return {
        status: r.run?.ok === false ? 'error' : 'ok',
        measurement: r.run?.timedOut ? 'timeout' : r.run?.ok === false ? 'error' : 'recorded',
        detail: `${oracleCase || 'case'}: exit ${r.run?.exit_code ?? 'n/a'}, ${r.observation?.steps?.length || 0} step(s)`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[8], async () => {
      if (!oracleCase) return { status: 'unavailable', detail: 'No Oracle case was recorded' }
      const r = await runShadow(workspace, slug, oracleCase, { selfCheck: true })
      deterministic = r.diff?.status === 'match' && r.parity?.status === 'match'
      return {
        status: deterministic ? 'ok' : 'unavailable',
        measurement: r.diff?.status || r.parity?.status || 'unknown',
        detail: `self-check ${r.diff?.status || 'unknown'}: ${r.diff?.note || 'no detail'}`,
        evidence: r.evidence,
        files: [r.shadowFile],
      }
    })

    let repairResult = null
    await step(STEP_DEFS[9], async () => {
      repairResult = applyRepairs(workspace, slug, { caseIds: oracleCase ? [oracleCase] : null })
      if (!deterministic) {
        return {
          status: repairResult.applied.length ? 'ok' : 'unavailable',
          detail: `self-check not proven; ${repairResult.plan?.summary?.blocked || 0} case(s) blocked. No fake repair was written.`,
          files: repairResult.written,
          evidence: repairResult.evidence,
        }
      }
      return {
        status: repairResult.applied.length ? 'ok' : 'unavailable',
        detail: `${repairResult.applied.length} applied, ${repairResult.verified} verified, ${repairResult.blocked} blocked`,
        files: repairResult.written,
        evidence: repairResult.evidence,
      }
    })

    await step(STEP_DEFS[10], async () => {
      if (!oracleCase || !repairResult?.applied?.includes(oracleCase)) {
        return { status: 'unavailable', detail: 'No verified repair fixture exists for this case' }
      }
      const r = await runShadow(workspace, slug, oracleCase, { repairCase: true })
      parityMatched = r.diff?.status === 'match' && r.parity?.status === 'match'
      return {
        status: parityMatched ? 'ok' : 'unavailable',
        measurement: r.diff?.status || r.parity?.status || 'unknown',
        detail: `repair replay ${r.diff?.status || 'unknown'}: ${r.diff?.note || 'no detail'}`,
        evidence: r.evidence,
        files: [r.shadowFile],
      }
    })

    await step(STEP_DEFS[11], async () => {
      const r = buildFingerprint(workspace, slug)
      return {
        detail: `${r.fingerprint.summary.cases} case(s), ${r.fingerprint.summary.steps} step(s), digest ${shortHash(r.fingerprint.digest)}`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[12], async () => {
      const r = await checkDrift(workspace, slug)
      return {
        measurement: r.status,
        detail: `drift ${r.status}: ${r.report?.summary?.match || 0} match, ${r.report?.summary?.changed || 0} changed`,
        evidence: r.evidence,
        files: r.files,
      }
    })

    await step(STEP_DEFS[13], async () => {
      const r = extractFacts(workspace, slug)
      return {
        detail: `${r.count} fact(s), ${r.promoted} promoted, ${r.conflicts} conflict(s)`,
        files: r.files,
      }
    })

    await step(STEP_DEFS[14], async () => {
      const r = compileIR(workspace, slug)
      return {
        detail: `${r.summary.nodes} node(s), ${r.summary.cited} cited`,
        files: ['spec/clone-ir.json', 'reports/clone-ir.md'],
      }
    })

    await step(STEP_DEFS[15], async () => {
      score = computeFidelity(workspace, slug)
      return {
        detail: `${(score.score * 100).toFixed(1)}% ${score.tier?.id || 'L0'}, ${Math.round(score.measuredWeight * 100)}% of rubric measured`,
        files: ['reports/fidelity.json', 'reports/fidelity.md'],
      }
    })

    await step(STEP_DEFS[16], () => applyStages())

    await step(STEP_DEFS[17], async () => {
      const r = compileSpec(workspace, slug)
      return {
        detail: `${r.written.length} spec file(s)`,
        files: r.written,
      }
    })

    await step(STEP_DEFS[18], async () => {
      const r = scaffold(workspace, slug, { language })
      const current = store.getProject(workspace, slug)
      if (current && current.stages.build.status !== 'complete') {
        store.setStage(workspace, slug, 'build', {
          status: 'active',
          note: 'Auto Clone: scaffold generated; every module still has TODO stubs',
        })
      }
      return {
        detail: `${language} scaffold with ${r.written.length} file(s)`,
        files: r.written,
      }
    })

    await step(STEP_DEFS[19], async () => {
      gaps = analyzeGaps(workspace, slug, { limit: 8 })
      return {
        detail: `${gaps.summary.total} gap(s), ${gaps.summary.blocking} blocking`,
        files: ['spec/gaps.json', 'reports/gaps.md'],
      }
    })
  }

  /* ------------------------------------------------------------------ report */

  const finalProject = slug ? store.getProject(workspace, slug) : null
  const paths = slug ? store.projectPaths(workspace, slug) : null
  const counts = { ok: 0, unavailable: 0, error: 0, skipped: 0 }
  for (const s of steps) if (counts[s.status] !== undefined) counts[s.status] += 1
  const automation = counts.error ? 'failed' : counts.unavailable || counts.skipped ? 'partial' : 'complete'

  const report = {
    schema: SCHEMA_VERSION,
    honesty: HONESTY,
    at: new Date().toISOString(),
    project: finalProject
      ? {
          slug: finalProject.slug,
          name: finalProject.name,
          dir: paths.dir,
          target: finalProject.target,
        }
      : null,
    steps,
    summary: {
      status: automation,
      counts,
      elapsedMs: Date.now() - startedAt,
      fidelity: score
        ? {
            score: score.score,
            measuredScore: score.measuredScore,
            measuredWeight: score.measuredWeight,
            tier: score.tier?.id || null,
          }
        : null,
      gaps: gaps
        ? { total: gaps.summary.total, blocking: gaps.summary.blocking, byTool: gaps.summary.byTool }
        : null,
    },
    stages: finalProject?.stages || null,
  }

  if (paths) {
    fs.mkdirSync(paths.spec, { recursive: true })
    fs.mkdirSync(paths.reports, { recursive: true })
    fs.writeFileSync(path.join(paths.spec, 'auto-clone.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(paths.reports, 'auto-clone.md'), markdown(report), 'utf8')

    const root = store.rootFor(workspace)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'auto-clone-last.json'),
      JSON.stringify({
        schema: SCHEMA_VERSION,
        slug,
        project: paths.dir,
        status: automation,
        at: report.at,
      }, null, 2) + '\n',
      'utf8',
    )
  }

  emit({ type: 'done', status: automation, slug, counts })
  return report
}

function markdown(report) {
  const p = report.project || {}
  const s = report.summary || {}
  const f = s.fidelity || {}
  const g = s.gaps || {}
  const lines = [
    '# Auto clone', '',
    report.honesty, '',
    `**Automation status: ${s.status || 'unknown'}** · ` +
      `${s.counts?.ok || 0} ok · ${s.counts?.unavailable || 0} unavailable · ` +
      `${s.counts?.error || 0} error · ${s.counts?.skipped || 0} skipped`, '',
    p.slug ? `- Project: \`${p.slug}\` — ${p.name}` : '- Project: not created',
    p.target?.path ? `- Target: \`${p.target.path}\`` : '- Target: not recorded',
    p.target?.sha256 ? `- SHA-256: \`${p.target.sha256}\`` : '- SHA-256: not available',
    f.score !== undefined ? `- Fidelity: ${(f.score * 100).toFixed(1)}% (${f.tier}), ${Math.round((f.measuredWeight || 0) * 100)}% measured` : '- Fidelity: not computed',
    g.total !== undefined ? `- Gaps: ${g.total} total, ${g.blocking} blocking` : '- Gaps: not planned', '',
    '## Steps', '',
    '| # | Step | Status | Measurement | Detail |', '| --- | --- | --- | --- | --- |',
  ]
  report.steps.forEach((step, i) => {
    lines.push(`| ${i + 1} | ${esc(step.title)} | ${esc(step.status)} | ${esc(step.measurement || '—')} | ${esc(step.detail)} |`)
  })
  lines.push('', '## Stage gates', '', '| Stage | Status |', '| --- | --- |')
  for (const [id, value] of Object.entries(report.stages || {})) {
    lines.push(`| ${esc(id)} | ${esc(value.status)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Read the last Auto Clone report without executing anything. */
export function readAuto(workspace, { slug = null } = {}) {
  const root = store.rootFor(workspace)
  let useSlug = slug
  if (!useSlug) {
    try {
      useSlug = JSON.parse(fs.readFileSync(path.join(root, 'auto-clone-last.json'), 'utf8')).slug || null
    } catch { /* no run yet */ }
  }
  if (!useSlug) return { applied: false, report: null, slug: null }
  const file = path.join(store.projectPaths(workspace, useSlug).spec, 'auto-clone.json')
  try {
    return { applied: true, slug: useSlug, report: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { applied: false, slug: useSlug, report: null }
  }
}
