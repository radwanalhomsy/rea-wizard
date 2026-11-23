/**
 * Semantic facts layer.
 *
 * Turns durable evidence (target hash, evidence snapshots, recorded cases and
 * any structured captures produced by the other toolkit tools) into a single
 * deterministic, citable fact ledger. A fact is never a guess: it always names
 * the evidence and case IDs it came from.
 *
 * Quorum rule: a claim seen from two or more independent sources is promoted
 * to a rule. Conflicting values for the same claim create a blocking unknown
 * instead of silently picking one.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths, readCase, addUnknown } from './cloneStore.mjs'

const SOURCE_CONFIDENCE = {
  target: 0.95,
  inventory: 0.95,
  case: 0.75,
  evidence: 0.6,
  ui: 0.8,
  artifacts: 0.8,
  protocol: 0.8,
  format: 0.7,
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function factId(kind, claim) {
  return 'f_' + crypto.createHash('sha256').update(`${kind}|${claim}`).digest('hex').slice(0, 12)
}

function shortValue(value) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 180 ? text.slice(0, 177) + '…' : text
}

function valueDigest(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 8)
}

/** Add a fact. Repeated claims are merged at the end, not overwritten. */
function push(list, entry) {
  const fact = {
    id: factId(entry.kind, entry.claim),
    kind: entry.kind,
    claim: entry.claim,
    value: entry.value ?? null,
    sources: Array.from(new Set(entry.sources || [])).sort(),
    evidence: Array.from(new Set(entry.evidence || [])).sort(),
    cases: Array.from(new Set(entry.cases || [])).sort(),
    confidence: SOURCE_CONFIDENCE[entry.kind] ?? 0.5,
    promoted: false,
    quorum: 1,
    note: entry.note || '',
  }
  list.push(fact)
}

function collectCaseFacts(facts, workspace, slug, record) {
  let full = null
  try {
    full = readCase(workspace, slug, record.id)
  } catch {
    full = null
  }
  const obs = full?.observation ?? {}
  const request = full?.request ?? {}
  const steps = Array.isArray(record.steps) ? record.steps : []

  push(facts, {
    kind: 'case',
    claim: `journey:${record.id}`,
    value: {
      title: record.title,
      tool: record.provider || record.kind,
      steps: steps.length,
      status: record.status ?? null,
    },
    sources: [`case:${record.id}`],
    evidence: record.evidenceIds || [],
    cases: [record.id],
    note: 'One replayable journey captured from an agent tool call.',
  })

  for (const step of steps) {
    const action = step.action ?? 'step'
    const target = step.target ?? ''
    push(facts, {
      kind: 'case',
      claim: `action:${action}:${target}`,
      value: { action, target, status: step.status ?? null },
      sources: [`case:${record.id}`],
      cases: [record.id],
      note: 'A user action observed inside a journey.',
    })
  }

  for (const key of ['exit_code', 'status', 'normalized_result', 'summary']) {
    const value = obs?.[key]
    if (value === undefined || value === null) continue
    push(facts, {
      kind: 'case',
      claim: `output:${key}`,
      value: { value, digest: valueDigest(value) },
      sources: [`case:${record.id}`],
      evidence: record.evidenceIds || [],
      cases: [record.id],
      note: `Comparable output field from ${record.id}.`,
    })
  }

  const requestKeys = Object.keys(request || {}).filter((k) =>
    /path|url|executable|application|steps|query|input|file/i.test(k),
  )
  for (const key of requestKeys) {
    push(facts, {
      kind: 'case',
      claim: `input:${key}:${shortValue(request[key])}`,
      value: { key, value: shortValue(request[key]) },
      sources: [`case:${record.id}`],
      cases: [record.id],
      note: 'Input field from the exact replay request.',
    })
  }
}

function collectStructuredFacts(facts, paths) {
  const inventory = readJson(path.join(paths.spec, 'inventory.json'))
  if (inventory?.file) {
    push(facts, {
      kind: 'inventory',
      claim: `inventory:sha256:${inventory.file.sha256 || 'none'}`,
      value: { path: inventory.file.path, size: inventory.file.size, kind: inventory.file.kind },
      sources: ['explore'],
      note: 'Hashed and parsed target identity.',
    })
    for (const imp of inventory.pe?.imports || []) {
      for (const fn of imp.functions || []) {
        const name = fn.name || `#${fn.ordinal}`
        push(facts, {
          kind: 'inventory',
          claim: `import:${imp.dll || '?'}:${name}`,
          value: { dll: imp.dll || '', name: fn.name || null, ordinal: fn.ordinal ?? null },
          sources: ['explore-imports'],
          note: 'Imported symbol observed in the target binary.',
        })
      }
    }
    for (const s of inventory.pe?.sections || []) {
      push(facts, {
        kind: 'inventory',
        claim: `section:${s.name}`,
        value: { virtualAddress: s.virtualAddress, virtualSize: s.virtualSize, rawSize: s.rawSize },
        sources: ['explore-sections'],
        note: 'PE section header from the target binary.',
      })
    }
  }

  const ui = readJson(path.join(paths.spec, 'ui-map.json'))
  if (ui?.controls) {
    for (const control of ui.controls) {
      const name = control.name || control.id || control.label || 'control'
      push(facts, {
        kind: 'ui',
        claim: `ui:${control.screen || 'root'}:${name}`,
        value: { label: control.label || name, type: control.type || 'unknown', enabled: control.enabled ?? null },
        sources: ['ui-map'],
        note: 'Control enumerated from the accessibility tree.',
      })
    }
  }

  const persistence = readJson(path.join(paths.spec, 'persistence.json'))
  if (persistence?.artifacts) {
    for (const artifact of persistence.artifacts) {
      const name = artifact.path || artifact.key || 'artifact'
      push(facts, {
        kind: 'artifacts',
        claim: `data:${name}`,
        value: { kind: artifact.kind || 'file', operation: artifact.operation || 'write' },
        sources: artifact.sources || ['artifact-diff'],
        note: 'Filesystem or registry side effect of an action.',
      })
    }
  }

  const protocol = readJson(path.join(paths.spec, 'protocol.json'))
  if (protocol?.endpoints) {
    for (const endpoint of protocol.endpoints) {
      const name = `${endpoint.method || 'GET'} ${endpoint.path || endpoint.url || '/'}`
      push(facts, {
        kind: 'protocol',
        claim: `protocol:${name}`,
        value: { status: endpoint.status ?? null, schema: endpoint.schema ?? null },
        sources: ['protocol-capture'],
        note: 'Loopback endpoint observed during a journey.',
      })
    }
  }

  let formats = []
  try {
    formats = fs.readdirSync(path.join(paths.spec, 'formats')).filter((f) => f.endsWith('.json'))
  } catch {
    formats = []
  }
  for (const file of formats) {
    const fmt = readJson(path.join(paths.spec, 'formats', file)) || {}
    push(facts, {
      kind: 'format',
      claim: `format:${fmt.name || file}`,
      value: { magic: fmt.magic || null, fields: (fmt.fields || []).length },
      sources: ['format-infer'],
      note: 'Inferred binary format skeleton.',
    })
  }
}

/** Merge repeated claims, apply quorum and record conflicts as unknowns. */
function consolidate(facts, project, workspace, slug) {
  const groups = new Map()
  for (const fact of facts) {
    if (!groups.has(fact.claim)) groups.set(fact.claim, [])
    groups.get(fact.claim).push(fact)
  }

  const merged = []
  const conflicts = []
  for (const [claim, entries] of groups) {
    const base = entries[0]
    const sources = Array.from(new Set(entries.flatMap((e) => e.sources))).sort()
    const evidence = Array.from(new Set(entries.flatMap((e) => e.evidence))).sort()
    const cases = Array.from(new Set(entries.flatMap((e) => e.cases))).sort()
    const digests = new Set(entries.map((e) => valueDigest(e.value)))
    const quorum = sources.length
    const confidence = Math.min(0.98, (SOURCE_CONFIDENCE[base.kind] ?? 0.5) + 0.12 * Math.max(0, quorum - 1))
    const fact = {
      ...base,
      sources,
      evidence,
      cases,
      quorum,
      confidence: Number(confidence.toFixed(3)),
      promoted: quorum >= 2 && digests.size === 1,
      conflict: digests.size > 1,
      variants: digests.size > 1 ? entries.map((e) => e.value) : undefined,
    }
    merged.push(fact)
    if (fact.conflict) conflicts.push(fact)
  }

  for (const fact of conflicts) {
    const question = `Conflicting observations for ${fact.claim}: ${fact.variants.length} different values were captured`
    const exists = (project.unknowns || []).some((u) => u.question === question)
    if (!exists) {
      addUnknown(workspace, slug, {
        question,
        stage: 'behavior',
        blocking: true,
        evidence: fact.evidence.join(' '),
        owner: 'facts',
      })
    }
  }

  merged.sort((a, b) => a.id.localeCompare(b.id))
  return merged
}

function markdown(facts) {
  const lines = [
    '# Semantic facts',
    '',
    `Generated from durable evidence. ${facts.length} facts, ` +
      `${facts.filter((f) => f.promoted).length} promoted by quorum, ` +
      `${facts.filter((f) => f.conflict).length} in conflict.`,
    '',
    '| Fact | Kind | Claim | Value | Confidence | Sources | Citations |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const f of facts) {
    lines.push(
      `| \`${f.id}\` | ${f.kind} | ${f.claim} | ${shortValue(f.value).replace(/\|/g, '\\|')} ` +
        `| ${f.confidence}${f.promoted ? ' (rule)' : ''}${f.conflict ? ' (conflict)' : ''} ` +
        `| ${f.sources.join(', ')} | ${[...f.evidence, ...f.cases].join(', ') || '—'} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** Rebuild the fact ledger from project state. Deterministic for the same state. */
export function extractFacts(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const facts = []

  if (project.target?.path) {
    push(facts, {
      kind: 'target',
      claim: `target:${project.target.sha256 || project.target.path}`,
      value: {
        path: project.target.path,
        sha256: project.target.sha256 || null,
        size: project.target.size ?? null,
        kind: project.target.kind ?? null,
      },
      sources: [project.target.sha256 ? 'target-hash' : 'target-path'],
      note: project.target.sha256 ? 'The analyzed target binary identity.' : 'Target path recorded but not hashed yet.',
    })
  }

  for (const record of project.cases || []) collectCaseFacts(facts, workspace, slug, record)
  for (const ev of project.evidence || []) {
    push(facts, {
      kind: 'evidence',
      claim: `evidence:${ev.id}`,
      value: { source: ev.source || '', note: ev.note || '', file: ev.file || null },
      sources: [ev.source || 'evidence'],
      evidence: [ev.id],
      note: 'A cited REA evidence record.',
    })
  }
  collectStructuredFacts(facts, paths)

  const merged = consolidate(facts, project, workspace, slug)
  const file = path.join(paths.spec, 'facts.jsonl')
  fs.mkdirSync(paths.spec, { recursive: true })
  fs.writeFileSync(file, merged.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8')
  const report = path.join(paths.reports, 'facts.md')
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(report, markdown(merged), 'utf8')

  return {
    facts: merged,
    count: merged.length,
    promoted: merged.filter((f) => f.promoted).length,
    conflicts: merged.filter((f) => f.conflict).length,
    files: ['spec/facts.jsonl', 'reports/facts.md'],
  }
}

export function listFacts(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  try {
    return fs
      .readFileSync(path.join(paths.spec, 'facts.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
