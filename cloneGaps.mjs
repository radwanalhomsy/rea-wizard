/**
 * Gap Planner.
 *
 * Aggregates every measured shortfall into one ranked, actionable plan:
 * blocking unknowns, failed parity dimensions, unmeasured or partial fidelity
 * dimensions, uncited IR nodes, conflicting facts, blocked stage gates, repair
 * blockers and remaining TODO stubs in the generated clone.
 *
 * Honesty rules:
 *  - a gap is only emitted when a tool actually measured it
 *  - each gap names the tool that can close it and the evidence behind it
 *  - the plan never marks a gap resolved; only re-measuring can do that
 *
 * Outputs: spec/gaps.json, reports/gaps.md (both deterministic).
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths, projectDetail } from './cloneStore.mjs'
import { computeFidelity } from './cloneFidelity.mjs'
import { readIR } from './cloneIR.mjs'
import { listFacts } from './cloneFacts.mjs'
import { repairStatus } from './cloneRepair.mjs'

const STUB = /TODO\(|not implemented|NotImplementedError|not implemented/i
const STUB_SCAN_CAP = 200

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
}

function gapId(kind, key) {
  return `gap_${crypto.createHash('sha256').update(`${kind}|${key}`).digest('hex').slice(0, 10)}`
}

function stageTool(stage) {
  switch (stage) {
    case 'inventory': return 'explore'
    case 'behavior': return 'oracle'
    case 'spec': return 'spec'
    case 'build': return 'repair'
    case 'parity': return 'repair'
    case 'provenance': return 'score'
    default: return 'facts'
  }
}

function stageAction(stage) {
  switch (stage) {
    case 'inventory': return 'Re-run Explore on the target to close the inventory gap.'
    case 'behavior': return 'Record an Oracle case or a recorded journey for this behaviour.'
    case 'spec': return 'Regenerate the spec from the evidence that is now known.'
    case 'build': return 'Apply a Repair or implement the stub, then re-measure parity.'
    case 'parity': return 'Run a Shadow replay and Repair the changed dimensions.'
    case 'provenance': return 'Re-extract facts and recompute fidelity to restore provenance.'
    default: return 'Extract facts to identify which evidence would answer this unknown.'
  }
}

function pushGap(list, g) {
  list.push({
    id: gapId(g.kind, g.key || g.title),
    key: g.key || g.title,
    kind: g.kind,
    severity: g.severity,
    blocking: Boolean(g.blocking),
    stage: g.stage || null,
    tool: g.tool || 'facts',
    title: g.title,
    detail: g.detail,
    action: g.action,
    source: g.source,
    evidence: Array.from(new Set(g.evidence || [])).sort(),
    cases: Array.from(new Set(g.cases || [])).sort(),
  })
  delete list[list.length - 1].key
}

function scanStubs(dir) {
  const out = []
  const walk = (d, prefix, depth) => {
    if (depth > 6 || out.length >= 50) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(full, rel, depth + 1)
        continue
      }
      if (out.length >= 50) break
      try {
        const stat = fs.statSync(full)
        if (!stat.isFile() || stat.size > 256 * 1024) continue
        const text = fs.readFileSync(full, 'utf8').slice(0, 64 * 1024)
        if (STUB.test(text)) out.push(rel)
      } catch { /* unreadable file */ }
    }
  }
  walk(dir, '', 0)
  return out.slice(0, STUB_SCAN_CAP)
}

/* ---------------------------------------------------------------- analysis */

export function analyzeGaps(workspace, slug, { limit = 5 } = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const detail = projectDetail(workspace, slug)
  const gaps = []

  // 1. Conflicting facts and blocking unknowns are the hardest gaps.
  for (const f of listFacts(workspace, slug)) {
    if (!f.conflict) continue
    pushGap(gaps, {
      kind: 'conflict', severity: 96, blocking: true, stage: 'behavior', tool: 'facts',
      title: `Conflicting fact: ${f.claim}`,
      detail: `${(f.variants || []).length || 2} distinct values were observed for one claim.`,
      action: 'Resolve the conflict by recording another independent case, then re-extract facts.',
      source: 'facts', evidence: f.evidence || [], cases: f.cases || [],
    })
  }
  for (const u of project.unknowns || []) {
    if (u.status !== 'open') continue
    pushGap(gaps, {
      kind: u.blocking ? 'unknown' : 'question',
      severity: u.blocking ? 94 : 35,
      blocking: u.blocking,
      stage: u.stage || null,
      tool: u.owner === 'facts' ? 'facts' : stageTool(u.stage),
      title: u.question,
      detail: u.blocking ? 'This unknown blocks its stage gate.' : 'Non-blocking question recorded on the project.',
      action: u.blocking ? stageAction(u.stage) : 'Answer when additional evidence becomes available.',
      source: 'unknowns', evidence: u.evidence ? [u.evidence] : [],
    })
  }

  // 2. Measured parity failures from Oracle/Shadow cases.
  for (const c of project.cases || []) {
    const parity = c.parity
    if (!parity || ['match', 'pass', 'unavailable'].includes(parity.status)) continue
    const changed = (parity.dims || []).filter((d) => d.status === 'changed').map((d) => d.name)
    pushGap(gaps, {
      kind: 'parity', severity: 88, blocking: false, stage: 'parity', tool: 'repair',
      title: `${c.title || c.id}: ${parity.status}`,
      detail: changed.length ? `Changed dimensions: ${changed.join(', ')}.` : (parity.note || 'Shadow replay did not match.'),
      action: changed.includes('files')
        ? 'Re-run Repair to capture the missing file side effects, then verify.'
        : 'Apply a deterministic transcript Repair, then verify the case.',
      source: 'parity', cases: [c.id],
    })
  }

  // 3. Repair plan blockers.
  const repair = repairStatus(workspace, slug)
  for (const c of repair.cases || []) {
    if (!c.blockers?.length) continue
    pushGap(gaps, {
      kind: 'repair', severity: 82, blocking: false, stage: 'build', tool: 'repair',
      title: `Repair blocked for ${c.case}`,
      detail: c.blockers.join(' '),
      action: 'Run Oracle Self-check to prove determinism before applying a repair.',
      source: 'repair', cases: [c.case],
    })
  }

  // 4. Fidelity: unmeasured dimensions cost the most coverage.
  const score = computeFidelity(workspace, slug)
  const byLabel = new Map((score.improvements || []).map((x) => [x.label, x]))
  for (const d of score.dimensions || []) {
    if (!d.measured) {
      pushGap(gaps, {
        kind: 'coverage', severity: 76, blocking: false, stage: null,
        tool: ({ inventory: 'explore', interface: 'uimap', behavior: 'oracle', state: 'artifacts', data: 'formats', protocol: 'protocol' })[d.id] || 'facts',
        title: `Unmeasured: ${d.label}`,
        detail: d.detail,
        action: byLabel.get(d.label)?.action || d.detail,
        source: 'fidelity',
      })
    } else if (d.score < 1) {
      pushGap(gaps, {
        kind: 'fidelity', severity: 62, blocking: false, stage: null,
        tool: ({ inventory: 'explore', interface: 'uimap', behavior: 'repair', state: 'artifacts', data: 'formats', protocol: 'protocol' })[d.id] || 'facts',
        title: `Partial: ${d.label} (${Math.round(d.score * 100)}%)`,
        detail: d.detail,
        action: byLabel.get(d.label)?.action || d.detail,
        source: 'fidelity',
      })
    }
  }

  // 5. Blocked stage gates (distinct from the unknowns that caused them).
  for (const s of detail.stageBoard || []) {
    if (s.gate?.allowed || !s.gate?.blockers?.length) continue
    pushGap(gaps, {
      kind: 'stage', severity: 78, blocking: true, stage: s.id, tool: stageTool(s.id),
      title: `Stage gate blocked: ${s.title}`,
      detail: `${s.gate.blockers.length} blocking unknown(s) prevent completing this stage.`,
      action: stageAction(s.id),
      source: 'stages',
      evidence: s.gate.blockers.map((u) => u.evidence).filter(Boolean),
    })
  }

  // 6. Uncited IR nodes: the reconstruction claim has no provenance.
  const ir = readIR(workspace, slug)
  if (ir) {
    const groups = [
      ['controls', ir.surface?.controls || [], 'uimap'],
      ['journeys', ir.behavior?.journeys || [], 'recorder'],
      ['artifacts', ir.state?.artifacts || [], 'artifacts'],
      ['formats', ir.data?.formats || [], 'formats'],
      ['endpoints', ir.protocol?.endpoints || [], 'protocol'],
    ]
    for (const [kind, nodes, tool] of groups) {
      const uncited = nodes.filter((n) => !n.citations || (!n.citations.evidence.length && !n.citations.facts.length && !n.citations.cases.length))
      if (!uncited.length) continue
      pushGap(gaps, {
        kind: 'citation', severity: 52, blocking: false, stage: 'spec', tool,
        title: `${uncited.length} uncited ${kind} in the Clone IR`,
        detail: `Examples: ${uncited.slice(0, 3).map((n) => n.label || n.title || n.name || n.path || n.id).join(', ')}.`,
        action: `Re-run the ${tool} capture so these nodes carry evidence IDs.`,
        source: 'ir', cases: uncited.map((n) => n.case).filter(Boolean),
      })
    }
  }

  // 7. Remaining TODO stubs in the generated clone.
  const stubs = scanStubs(paths.clone)
  if (stubs.length) {
    pushGap(gaps, {
      kind: 'stub', severity: 40, blocking: false, stage: 'build', tool: 'repair',
      title: `${stubs.length} unimplemented stub(s) in the generated clone`,
      detail: `Examples: ${stubs.slice(0, 3).join(', ')}.`,
      action: 'Implement or repair each stub, then re-run its parity case.',
      source: 'clone',
    })
  }

  gaps.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))

  const byKind = {}
  const byTool = {}
  for (const g of gaps) {
    byKind[g.kind] = (byKind[g.kind] || 0) + 1
    byTool[g.tool] = (byTool[g.tool] || 0) + 1
  }
  const n = Math.max(1, Math.min(50, Number(limit) || 5))
  const plan = {
    schema: 1,
    project: project.slug,
    honesty: 'Every gap below comes from a measurement. Only re-measuring can close one.',
    gaps,
    next: gaps.slice(0, n).map((g, i) => ({
      rank: i + 1, id: g.id, tool: g.tool, action: g.action,
      title: g.title, severity: g.severity, blocking: g.blocking,
    })),
    summary: {
      total: gaps.length,
      blocking: gaps.filter((g) => g.blocking).length,
      measured: score.measuredWeight,
      tier: score.tier?.id || null,
      byKind,
      byTool,
    },
  }

  write(path.join(paths.spec, 'gaps.json'), JSON.stringify(plan, null, 2))
  write(path.join(paths.reports, 'gaps.md'), planMarkdown(plan))
  return plan
}

function planMarkdown(plan) {
  const lines = [
    '# Gap plan', '',
    plan.honesty, '',
    `${plan.summary.total} gap(s) · ${plan.summary.blocking} blocking · ` +
      `tier ${plan.summary.tier || '?'} · ${Math.round((plan.summary.measured || 0) * 100)}% of the rubric measured`, '',
    '## Do next', '',
  ]
  for (const n of plan.next) {
    lines.push(`${n.rank}. **${n.tool}** — ${n.title} · ${n.action}`)
  }
  lines.push('', '## All gaps', '', '| Severity | Kind | Blocking | Gap | Tool |', '| --- | --- | --- | --- | --- |')
  for (const g of plan.gaps) {
    lines.push(`| ${g.severity} | ${g.kind} | ${g.blocking ? 'yes' : 'no'} | ${String(g.title).replace(/\|/g, '\\|')} | ${g.tool} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/** The short ranked "what to do next" list, recomputed each time. */
export function planNext(workspace, slug, options = {}) {
  const plan = analyzeGaps(workspace, slug, options)
  return { ok: true, next: plan.next, summary: plan.summary, file: 'spec/gaps.json' }
}

export function gapStatus(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  const plan = readJson(path.join(paths.spec, 'gaps.json'))
  if (!plan) return { ok: true, applied: false, summary: { total: 0, blocking: 0 }, next: [] }
  return { ok: true, applied: true, summary: plan.summary, next: plan.next || [] }
}

export function gapGet(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  return { ok: true, plan: readJson(path.join(paths.spec, 'gaps.json')), status: gapStatus(workspace, slug) }
}
