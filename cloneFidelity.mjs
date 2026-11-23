/**
 * Fidelity scorecard.
 *
 * A clone cannot be "40% done" without denominators. This module scores six
 * independent dimensions from evidence already in a project, marks dimensions
 * that were never measured as unmeasured (never as "ok"), and ranks the gaps
 * by how much overall fidelity they would buy if closed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { getProject, projectPaths } from './cloneStore.mjs'
import { listFacts } from './cloneFacts.mjs'

const WEIGHTS = {
  inventory: 0.1,
  interface: 0.2,
  behavior: 0.3,
  state: 0.15,
  data: 0.15,
  protocol: 0.1,
}

const STAGE_FOR = {
  inventory: 'inventory',
  interface: 'behavior',
  behavior: 'parity',
  state: 'behavior',
  data: 'behavior',
  protocol: 'behavior',
}

const DIMENSION_LABELS = {
  inventory: 'Target inventory',
  interface: 'UI surface',
  behavior: 'Recorded behavior',
  state: 'State / action model',
  data: 'Persistence compatibility',
  protocol: 'Protocol compatibility',
}

function ratio(covered, total) {
  return total > 0 ? Number(Math.min(1, covered / total).toFixed(4)) : 0
}

function blockersFor(project, id) {
  const stage = STAGE_FOR[id]
  return (project.unknowns || [])
    .filter((u) => u.status === 'open' && u.blocking && (!u.stage || u.stage === stage))
    .map((u) => ({ id: u.id, question: u.question, stage: u.stage || stage }))
}

function dimension(id, covered, total, measured, detail, project) {
  const weight = WEIGHTS[id]
  const score = measured ? ratio(covered, total) : 0
  return {
    id,
    label: DIMENSION_LABELS[id],
    weight,
    covered,
    total,
    measured,
    score,
    gap: Number((weight * (1 - score)).toFixed(4)),
    detail,
    blockers: blockersFor(project, id),
  }
}

function tier(score) {
  if (score >= 0.8) return { id: 'L4', label: 'High fidelity' }
  if (score >= 0.6) return { id: 'L3', label: 'Data compatible' }
  if (score >= 0.4) return { id: 'L2', label: 'Interactive clone' }
  if (score >= 0.2) return { id: 'L1', label: 'UI shell' }
  return { id: 'L0', label: 'Inventory only' }
}

function markdown(result) {
  const lines = [
    '# Clone fidelity scorecard',
    '',
    `**Overall ${(result.score * 100).toFixed(1)}%** · ${result.tier.id} ${result.tier.label} · ` +
      `measured coverage ${(result.measuredWeight * 100).toFixed(0)}% of the rubric`,
    '',
    'Unmeasured dimensions score zero. That is deliberate: an unchecked dimension',
    'is not a passing dimension.',
    '',
    '| Dimension | Weight | Covered | Score | Status | Blockers |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const d of result.dimensions) {
    lines.push(
      `| ${d.label} | ${(d.weight * 100).toFixed(0)}% | ${d.covered}/${d.total} ` +
        `| ${(d.score * 100).toFixed(1)}% | ${d.measured ? 'measured' : 'unmeasured'} ` +
        `| ${d.blockers.length} |`,
    )
    lines.push(`| &nbsp; | | | | ${d.detail} | |`)
  }
  lines.push('', '## Biggest gains', '')
  if (!result.improvements.length) {
    lines.push('_No ranked gaps. Record evidence and journeys to populate the rubric._', '')
  } else {
    for (const item of result.improvements) {
      lines.push(`- **+${(item.gain * 100).toFixed(1)}%** — ${item.label}: ${item.action}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function computeFidelity(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const facts = listFacts(workspace, slug)
  const cases = project.cases || []
  const evidence = project.evidence || []

  const staticFacts = facts.filter((f) => ['target', 'inventory', 'ui', 'artifacts', 'protocol', 'format'].includes(f.kind))
  const inventoryFacts = facts.filter((f) => f.kind === 'inventory')
  const inventory = dimension(
    'inventory',
    (project.target?.sha256 ? 1 : 0) + (evidence.length ? 1 : 0) + (inventoryFacts.length ? 1 : 0),
    3,
    Boolean(project.target || evidence.length),
    `target hash ${project.target?.sha256 ? 'yes' : 'no'}, ${evidence.length} evidence records, ` +
      `${inventoryFacts.length} inventory facts`,
    project,
  )

  const uiFacts = facts.filter((f) => f.kind === 'ui')
  const stepsText = JSON.stringify(cases.flatMap((c) => c.steps || []))
  const uiCovered = uiFacts.filter((f) => {
    const name = String(f.value?.label || f.claim.split(':').pop() || '')
    return (f.cases?.length || 0) > 0 || (name && stepsText.toLowerCase().includes(name.toLowerCase()))
  }).length

  let guiManifest = null
  try {
    guiManifest = JSON.parse(fs.readFileSync(path.join(paths.clone, 'gui', 'manifest.json'), 'utf8'))
  } catch { /* no generated GUI clone yet */ }

  const guiVerification = guiManifest?.verification
  const useGuiVerification = Boolean(
    guiVerification && guiVerification.totalNodes > 0 && guiVerification.completeness !== undefined,
  )
  const interfaceDim = useGuiVerification
    ? dimension(
        'interface',
        guiVerification.renderedNodes || 0,
        guiVerification.totalNodes,
        true,
        `${guiVerification.renderedNodes}/${guiVerification.totalNodes} captured GUI nodes rendered; ` +
          `${guiManifest.counts?.menuSurfaces || 0} menus, ${guiManifest.counts?.submenus || 0} submenu nodes, ` +
          `${guiManifest.counts?.tabSurfaces || 0} tab surfaces`,
        project,
      )
    : dimension(
        'interface',
        uiCovered,
        uiFacts.length,
        uiFacts.length > 0,
        uiFacts.length ? `${uiCovered} of ${uiFacts.length} enumerated controls exercised` : 'no UI map captured yet',
        project,
      )

  const checked = cases.filter((c) => c.parity && c.parity.status !== 'not checked')
  const passing = checked.filter((c) => c.parity.status === 'pass' || c.parity.status === 'match')
  const withSteps = cases.filter((c) => (c.steps || []).length > 0)
  const behavior = dimension(
    'behavior',
    passing.length + withSteps.length,
    cases.length * 2,
    cases.length > 0,
    `${cases.length} journeys, ${withSteps.length} with steps, ${passing.length}/${checked.length} parity cases passing`,
    project,
  )

  const actionFacts = facts.filter((f) => f.kind === 'case' && f.claim.startsWith('action:'))
  const actionKeys = new Set(actionFacts.map((f) => f.claim))
  const stateTotal = new Set([...uiFacts.map((f) => f.claim), ...actionKeys]).size
  const state = dimension(
    'state',
    actionKeys.size,
    stateTotal,
    uiFacts.length > 0 && actionKeys.size > 0,
    `${actionKeys.size} distinct actions observed against ${uiFacts.length} enumerated controls`,
    project,
  )

  const dataFacts = facts.filter((f) => f.kind === 'artifacts' || f.claim.startsWith('data:'))
  const dataCovered = dataFacts.filter((f) => (f.evidence?.length || 0) > 0 || (f.cases?.length || 0) > 0 || f.promoted).length
  const data = dimension(
    'data',
    dataCovered,
    dataFacts.length,
    dataFacts.length > 0,
    dataFacts.length ? `${dataCovered} of ${dataFacts.length} persistence facts cited or promoted` : 'no artifact diff captured yet',
    project,
  )

  const protocolFacts = facts.filter((f) => f.kind === 'protocol' || f.claim.startsWith('protocol:'))
  const protocolCovered = protocolFacts.filter((f) => (f.cases?.length || 0) > 0 || f.promoted).length
  const protocol = dimension(
    'protocol',
    protocolCovered,
    protocolFacts.length,
    protocolFacts.length > 0,
    protocolFacts.length ? `${protocolCovered} of ${protocolFacts.length} endpoints exercised` : 'no protocol capture yet',
    project,
  )

  const dimensions = [inventory, interfaceDim, behavior, state, data, protocol]
  const weightTotal = dimensions.reduce((n, d) => n + d.weight, 0)
  const score = dimensions.reduce((n, d) => n + d.weight * d.score, 0) / weightTotal
  const measuredDims = dimensions.filter((d) => d.measured)
  const measuredWeight = measuredDims.reduce((n, d) => n + d.weight, 0) / weightTotal
  const measuredScore = measuredWeight
    ? measuredDims.reduce((n, d) => n + d.weight * d.score, 0) /
      measuredDims.reduce((n, d) => n + d.weight, 0)
    : 0

  const suggestions = {
    inventory: 'hash the target and capture REA evidence into the project',
    interface: 'capture a UI map so the control denominator exists, then exercise those controls',
    behavior: 'record end-to-end journeys and pass parity on each one',
    state: 'record more distinct actions until the observed actions cover the UI map',
    data: 'capture artifact diffs and cite them from journeys',
    protocol: 'capture loopback traffic and exercise each endpoint in a journey',
  }
  const improvements = dimensions
    .map((d) => ({ label: d.label, gain: d.gap, action: suggestions[d.id] }))
    .sort((a, b) => b.gain - a.gain)

  const result = {
    schema: 1,
    slug,
    at: new Date().toISOString(),
    score: Number(score.toFixed(4)),
    measuredScore: Number(measuredScore.toFixed(4)),
    measuredWeight: Number(measuredWeight.toFixed(4)),
    tier: tier(score),
    dimensions,
    improvements,
    blockers: (project.unknowns || []).filter((u) => u.status === 'open' && u.blocking),
  }

  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'fidelity.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(paths.reports, 'fidelity.md'), markdown(result), 'utf8')
  return result
}

export function readFidelity(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.reports, 'fidelity.json'), 'utf8'))
  } catch {
    return null
  }
}
