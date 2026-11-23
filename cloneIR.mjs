/**
 * Clone intermediate representation.
 *
 * Compiles everything captured so far — inventory, UI map, journeys, artifact
 * diffs, formats and protocol endpoints — into a single deterministic IR.
 * Every node carries provenance (evidence / case / fact IDs) so generated code
 * and tests can trace a claim back to the observation that produced it.
 *
 * The IR is the contract between capture tools and reconstruction tools:
 * the spec compiler, scaffolder, oracle and repair loop all consume it.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths } from './cloneStore.mjs'
import { listFacts, extractFacts } from './cloneFacts.mjs'

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

function id(prefix, value) {
  return prefix + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10)
}

function citations(facts, claim) {
  const matches = facts.filter((f) => f.claim === claim)
  return {
    facts: matches.map((f) => f.id),
    evidence: [...new Set(matches.flatMap((f) => f.evidence || []))].sort(),
    cases: [...new Set(matches.flatMap((f) => f.cases || []))].sort(),
    confidence: matches.length ? Math.max(...matches.map((f) => f.confidence || 0)) : 0,
  }
}

function stableControls(map, facts) {
  const controls = (map?.controls || []).slice().sort((a, b) =>
    `${a.screen || ''}|${a.name || ''}`.localeCompare(`${b.screen || ''}|${b.name || ''}`),
  )
  return controls.map((c) => ({
    id: id('ctl_', `${c.screen || 'root'}:${c.name || c.label}`),
    screen: c.screen || 'root',
    label: c.label || c.name || 'control',
    type: c.type || 'unknown',
    enabled: Boolean(c.enabled),
    bounds: c.bounds || null,
    source: map?.source || 'ui-map',
    citations: citations(facts, `ui:${c.screen || 'root'}:${c.name || c.label || 'control'}`),
  }))
}

function stableSteps(c) {
  return (c.steps || []).map((s, i) => ({
    index: i,
    action: s.action || 'step',
    target: s.target || '',
    value: s.value ?? null,
    status: s.status ?? null,
  }))
}

function compileBehavior(project, facts) {
  const journeys = (project.cases || []).slice().sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({
    id: c.id,
    title: c.title || c.tool || c.id,
    tool: c.provider || c.kind || c.tool || '',
    steps: stableSteps(c),
    parity: c.parity?.status || 'not checked',
    citations: citations(facts, `journey:${c.id}`),
  }))
  const actionMap = new Map()
  for (const j of journeys) {
    for (const s of j.steps) {
      const key = `${s.action}:${s.target}`
      const rec = actionMap.get(key) || { action: s.action, target: s.target, occurrences: 0, journeys: [] }
      rec.occurrences++
      if (!rec.journeys.includes(j.id)) rec.journeys.push(j.id)
      actionMap.set(key, rec)
    }
  }
  return {
    journeys,
    actions: [...actionMap.values()].sort((a, b) => `${a.action}:${a.target}`.localeCompare(`${b.action}:${b.target}`)),
  }
}

function markdown(ir) {
  const lines = [
    '# Clone IR',
    '',
    `Target: \`${ir.target.sha256 || ir.target.path || 'unknown'}\``,
    '',
    `**Coverage:** ${ir.summary.controls} controls · ${ir.summary.journeys} journeys · ` +
      `${ir.summary.actions} actions · ${ir.summary.artifacts} artifacts · ` +
      `${ir.summary.formats} formats · ${ir.summary.endpoints} endpoints`,
    '',
    `${ir.summary.cited} of ${ir.summary.nodes} nodes are cited by evidence or a case. ` +
      `${ir.unknowns.length} open unknown(s), ${ir.unknowns.filter((u) => u.blocking).length} blocking.`,
    '',
    '## Gaps', '',
  ]
  if (!ir.unknowns.length) lines.push('_No open unknowns._')
  for (const u of ir.unknowns) lines.push(`- ${u.blocking ? '**BLOCKING** ' : ''}${u.question} (${u.stage || 'any stage'})`)
  lines.push('', '## Endpoints', '')
  for (const e of ir.protocol.endpoints) {
    lines.push(`- ${e.method || 'tcp'} \`${e.host || ''}${e.port ? ':' + e.port : ''}${e.path || ''}\` -> ${e.status ?? e.state ?? ''}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Build the IR for a project. Pure with respect to the stored artifacts: the
 * same project state always produces byte-identical JSON.
 */
export function compileIR(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  // The IR is the entry point for reconstruction, so it must be self-contained:
  // refresh the fact ledger from captured artifacts on every compile. The ledger
  // is idempotent (consolidated by claim), so this is safe to repeat.
  extractFacts(workspace, slug)
  const facts = listFacts(workspace, slug)

  const inventory = readJson(path.join(paths.spec, 'inventory.json'))
  const uiMap = readJson(path.join(paths.spec, 'ui-map.json'))
  const persistence = readJson(path.join(paths.spec, 'persistence.json'))
  const protocol = readJson(path.join(paths.spec, 'protocol.json'))
  const formatDir = path.join(paths.spec, 'formats')
  let formats = []
  try {
    formats = fs.readdirSync(formatDir).filter((f) => f.endsWith('.json')).sort().map((f) =>
      JSON.parse(fs.readFileSync(path.join(formatDir, f), 'utf8')))
  } catch { /* no formats yet */ }

  const target = {
    path: inventory?.file?.path || project.target?.path || null,
    sha256: inventory?.file?.sha256 || project.target?.sha256 || null,
    size: inventory?.file?.size ?? project.target?.size ?? null,
    kind: inventory?.file?.kind || project.target?.kind || null,
    arch: inventory?.pe?.arch || null,
    bits: inventory?.pe?.bits || null,
    entryPoint: inventory?.pe?.entryPointRva || null,
    imageBase: inventory?.pe?.imageBase || null,
    subsystem: inventory?.pe?.subsystem || null,
  }

  const controls = stableControls(uiMap, facts)
  const behavior = compileBehavior(project, facts)

  const state = {
    artifacts: (persistence?.artifacts || []).slice()
      .sort((a, b) => `${a.kind || ''}|${a.path || ''}`.localeCompare(`${b.kind || ''}|${b.path || ''}`))
      .map((a) => ({
        id: id('art_', `${a.kind}:${a.path}`),
        path: a.path,
        kind: a.kind || 'file',
        operation: a.operation || 'write',
        citations: citations(facts, `data:${a.path}`),
      })),
    transitions: [],
  }
  // Derive simple action → artifact adjacency from shared journeys/citations.
  for (const action of behavior.actions) {
    const related = state.artifacts.filter((a) =>
      action.journeys.some((j) => a.citations.cases.includes(j)))
    if (related.length) {
      state.transitions.push({ action: `${action.action}:${action.target}`, artifacts: related.map((a) => a.id) })
    }
  }

  const data = {
    formats: formats.map((f) => ({
      id: id('fmt_', f.name || f.source?.path || ''),
      name: f.name,
      label: f.label,
      magic: f.magic,
      confidence: f.confidence,
      fields: (f.fields || []).map((field) => ({
        name: field.name, offset: field.offset, size: field.size, type: field.type, value: field.value,
      })),
      citations: citations(facts, `format:${f.name}`),
    })),
  }

  const net = {
    endpoints: (protocol?.endpoints || []).slice()
      .sort((a, b) => `${a.method || a.protocol || ''}|${a.host || ''}|${a.port || ''}|${a.path || ''}`
        .localeCompare(`${b.method || b.protocol || ''}|${b.host || ''}|${b.port || ''}|${b.path || ''}`))
      .map((e) => ({
        id: id('ep_', `${e.method || e.protocol}|${e.host}|${e.port}|${e.path}`),
        protocol: e.protocol || 'http',
        method: e.method || '',
        host: e.host || '',
        port: e.port || 0,
        path: e.path || '/',
        status: e.status ?? null,
        state: e.state || null,
        loopback: Boolean(e.loopback),
        source: e.source || '',
        citations: citations(facts, `protocol:${e.method || 'GET'} ${e.path || '/'}`),
      })),
    limitations: protocol?.limitations || [],
  }

  const unknowns = (project.unknowns || [])
    .filter((u) => u.status === 'open')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u) => ({
      id: u.id, question: u.question, stage: u.stage || null, blocking: Boolean(u.blocking), owner: u.owner || null,
    }))

  const ir = {
    schema: 1,
    project: { slug: project.slug, name: project.name },
    target,
    surface: { source: uiMap?.source || null, title: uiMap?.title || null, controls },
    behavior,
    state,
    data,
    protocol: net,
    unknowns,
    evidence: [...new Set((project.evidence || []).map((e) => e.id))].sort(),
    facts: facts.map((f) => ({ id: f.id, claim: f.claim, kind: f.kind, confidence: f.confidence })),
    summary: {
      controls: controls.length,
      journeys: behavior.journeys.length,
      actions: behavior.actions.length,
      artifacts: state.artifacts.length,
      formats: data.formats.length,
      endpoints: net.endpoints.length,
      nodes: controls.length + behavior.journeys.length + behavior.actions.length + state.artifacts.length + data.formats.length + net.endpoints.length,
      cited: 0,
    },
  }
  ir.summary.cited = [
    ...controls.map((c) => (c.citations.evidence.length || c.citations.facts.length) > 0),
    ...behavior.journeys.map((j) => (j.citations.evidence.length || j.citations.cases.length) > 0),
    ...state.artifacts.map((a) => a.citations.evidence.length > 0),
    ...data.formats.map((f) => f.citations.evidence.length > 0),
    ...net.endpoints.map((e) => e.citations.evidence.length > 0),
  ].filter(Boolean).length

  fs.mkdirSync(paths.spec, { recursive: true })
  fs.writeFileSync(path.join(paths.spec, 'clone-ir.json'), JSON.stringify(ir, null, 2) + '\n', 'utf8')
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'clone-ir.md'), markdown(ir), 'utf8')
  return ir
}

export function readIR(workspace, slug) {
  const file = path.join(projectPaths(workspace, slug).spec, 'clone-ir.json')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Validate an IR for reconstruction readiness without mutating the project. */
export function validateIR(workspace, slug) {
  const ir = readIR(workspace, slug) || compileIR(workspace, slug)
  const errors = []
  const warnings = []
  if (!ir.target.sha256) errors.push('Target is not hashed — run Explore.')
  if (!ir.surface.controls.length) warnings.push('No UI controls in the IR — run UI Map.')
  if (!ir.behavior.journeys.length) warnings.push('No journeys in the IR — record a case.')
  if (!ir.state.artifacts.length) warnings.push('No persistence artifacts in the IR — run Artifact diff.')
  if (!ir.data.formats.length) warnings.push('No format skeletons in the IR — run Format inference.')
  if (!ir.protocol.endpoints.length) warnings.push('No protocol endpoints in the IR — run Protocol capture.')
  for (const u of ir.unknowns.filter((x) => x.blocking)) errors.push(`Blocking unknown: ${u.question}`)
  return {
    readyForScaffold: errors.length === 0,
    errors,
    warnings,
    summary: ir.summary,
    blockers: ir.unknowns.filter((u) => u.blocking),
  }
}
