/**
 * Clone project store.
 *
 * A "clone project" is a durable directory on disk that survives app restarts,
 * agent sessions and provider teardown. REA's Windows Ghidra path has no
 * checkpoint and no project reuse, so this folder is the only durable record of
 * what has been learned about a target.
 *
 * Layout (root = <workspace>/.rea-clone):
 *
 *   <root>/<slug>/project.json    state, stages, unknown ledger, evidence index
 *   <root>/<slug>/evidence/       exported evidence bundles (ev_*)
 *   <root>/<slug>/spec/           generated contracts and feature notes
 *   <root>/<slug>/cases/          recorded journeys (Sprint 2)
 *   <root>/<slug>/clone/          generated implementation (Sprint 4)
 *   <root>/<slug>/reports/        parity, unknowns, exposure
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SCHEMA_VERSION = 1
export const ROOT_DIRNAME = '.rea-clone'

export const STAGES = [
  {
    id: 'inventory',
    title: 'Inventory',
    goal: 'What is it made of?',
    detail: 'Target hash, packaging, providers, entry points, embedded runtimes.',
  },
  {
    id: 'behavior',
    title: 'Behavior',
    goal: 'What does it observably do?',
    detail: 'Recorded journeys: inputs, outputs, network, screenshots, side effects.',
  },
  {
    id: 'spec',
    title: 'Specification',
    goal: 'What is the contract?',
    detail: 'Features, inputs/outputs, error codes, state machines, each claim cited.',
  },
  {
    id: 'build',
    title: 'Implementation',
    goal: 'Where is the code?',
    detail: 'Scaffolded modules and stubs filled until parity cases pass.',
  },
  {
    id: 'parity',
    title: 'Parity',
    goal: 'Is the clone equivalent?',
    detail: 'Case-by-case differential results against the original.',
  },
  {
    id: 'provenance',
    title: 'Provenance',
    goal: 'Is it legal and safe to ship?',
    detail: 'License inventory, exposure audit, redistribution decision.',
  },
]

export const STAGE_IDS = STAGES.map((s) => s.id)
const STAGE_STATUS = new Set(['pending', 'active', 'complete', 'blocked'])

/* ------------------------------------------------------------------ helpers */

export function slugify(name) {
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
  return base || 'project'
}

export function rootFor(workspace) {
  return path.join(path.resolve(workspace), ROOT_DIRNAME)
}

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write via temp file + rename so a crash cannot leave half a project.json. */
function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function uniqueSlug(root, wanted) {
  let slug = wanted
  let n = 2
  while (fs.existsSync(path.join(root, slug))) slug = `${wanted}-${n++}`
  return slug
}

/* ------------------------------------------------------------------- paths */

export function projectPaths(workspace, slug) {
  const root = rootFor(workspace)
  const dir = path.join(root, slug)
  return {
    root,
    dir,
    file: path.join(dir, 'project.json'),
    evidence: path.join(dir, 'evidence'),
    spec: path.join(dir, 'spec'),
    cases: path.join(dir, 'cases'),
    clone: path.join(dir, 'clone'),
    reports: path.join(dir, 'reports'),
  }
}

/** Directory a stage writes into, so generated artifacts land somewhere sane. */
export function stageDir(workspace, slug, stage) {
  const p = projectPaths(workspace, slug)
  switch (stage) {
    case 'inventory':
      return p.evidence
    case 'behavior':
      return p.cases
    case 'spec':
      return p.spec
    case 'build':
      return p.clone
    case 'parity':
    case 'provenance':
      return p.reports
    default:
      return p.dir
  }
}

/* ------------------------------------------------------------------ project */

function blankStages() {
  const stages = {}
  for (const id of STAGE_IDS) {
    stages[id] = { status: 'pending', note: '', updatedAt: null }
  }
  return stages
}

function normalizeProject(project) {
  const out = { ...project }
  out.schema = SCHEMA_VERSION
  out.stages = { ...blankStages(), ...(project.stages || {}) }
  for (const id of STAGE_IDS) {
    const s = out.stages[id] || {}
    out.stages[id] = {
      status: STAGE_STATUS.has(s.status) ? s.status : 'pending',
      note: typeof s.note === 'string' ? s.note : '',
      updatedAt: s.updatedAt ?? null,
    }
  }
  out.unknowns = Array.isArray(project.unknowns) ? project.unknowns : []
  out.evidence = Array.isArray(project.evidence) ? project.evidence : []
  out.cases = Array.isArray(project.cases) ? project.cases : []
  out.modules = Array.isArray(project.modules) ? project.modules : []
  out.log = Array.isArray(project.log) ? project.log : []
  return out
}

export function listProjects(workspace) {
  const root = rootFor(workspace)
  if (!fs.existsSync(root)) return []
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'project.json')
    const project = readJson(file, null)
    if (!project || typeof project !== 'object') continue
    out.push(summarize(project))
  }
  out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return out
}

function summarize(project) {
  const stages = project.stages || {}
  const done = STAGE_IDS.filter((id) => stages[id]?.status === 'complete').length
  return {
    slug: project.slug,
    name: project.name,
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
    target: project.target ?? null,
    stages,
    stageSummary: { done, total: STAGE_IDS.length },
    openUnknowns: (project.unknowns || []).filter((u) => u.status === 'open').length,
    blockingUnknowns: (project.unknowns || []).filter((u) => u.status === 'open' && u.blocking).length,
    evidenceCount: (project.evidence || []).length,
    caseCount: (project.cases || []).length,
  }
}

export function getProject(workspace, slug) {
  if (!slug) return null
  const { file } = projectPaths(workspace, slug)
  const project = readJson(file, null)
  if (!project || typeof project !== 'object') return null
  return normalizeProject(project)
}

export function createProject(workspace, { name, targetPath = null, notes = '' } = {}) {
  const root = rootFor(workspace)
  ensureDir(root)
  const displayName = String(name || (targetPath ? path.basename(targetPath) : 'Untitled target')).trim()
  const slug = uniqueSlug(root, slugify(displayName))
  const paths = projectPaths(workspace, slug)
  for (const dir of [paths.dir, paths.evidence, paths.spec, paths.cases, paths.clone, paths.reports]) {
    ensureDir(dir)
  }
  const project = normalizeProject({
    schema: SCHEMA_VERSION,
    slug,
    name: displayName,
    notes: String(notes ?? ''),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    target: targetPath
      ? { path: path.resolve(targetPath), sha256: null, size: null, kind: null, analyzedAt: null }
      : null,
    provider: null,
    stages: blankStages(),
    unknowns: [],
    evidence: [],
    cases: [],
    modules: [],
    log: [{ at: nowIso(), event: 'created', detail: targetPath ? path.resolve(targetPath) : displayName }],
  })
  writeJson(paths.file, project)
  return summarize(project)
}

/** Apply a shallow patch plus bookkeeping; returns the normalized project. */
export function updateProject(workspace, slug, patch = {}) {
  const paths = projectPaths(workspace, slug)
  const current = getProject(workspace, slug)
  if (!current) throw new Error(`No clone project "${slug}"`)
  const next = normalizeProject({
    ...current,
    ...patch,
    slug: current.slug,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  })
  writeJson(paths.file, next)
  return next
}

export function deleteProject(workspace, slug) {
  const { dir } = projectPaths(workspace, slug)
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/* ------------------------------------------------------------------- stages */

export function setStage(workspace, slug, stage, patch = {}) {
  if (!STAGE_IDS.includes(stage)) throw new Error(`Unknown stage "${stage}"`)
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const prev = project.stages[stage]
  const status = patch.status && STAGE_STATUS.has(patch.status) ? patch.status : prev.status
  project.stages[stage] = {
    status,
    note: typeof patch.note === 'string' ? patch.note : prev.note,
    updatedAt: nowIso(),
  }
  project.updatedAt = nowIso()
  project.log.push({ at: nowIso(), event: 'stage', detail: `${stage} -> ${status}` })
  writeJson(projectPaths(workspace, slug).file, project)
  return project
}

/** A stage cannot complete while a blocking unknown is still open. */
export function stageGate(project, stage) {
  const blockers = (project.unknowns || []).filter(
    (u) => u.status === 'open' && u.blocking && (!u.stage || u.stage === stage),
  )
  return { allowed: blockers.length === 0, blockers }
}

/* ------------------------------------------------------------- unknown ledger */

export function addUnknown(workspace, slug, { question, stage = null, blocking = true, evidence = '', owner = '' }) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const text = String(question ?? '').trim()
  if (!text) throw new Error('Unknown needs a question')
  if (stage && !STAGE_IDS.includes(stage)) throw new Error(`Unknown stage "${stage}"`)
  const unknown = {
    id: newId('un'),
    question: text,
    stage,
    blocking: Boolean(blocking),
    owner: String(owner ?? ''),
    evidence: String(evidence ?? ''),
    status: 'open',
    createdAt: nowIso(),
    closedAt: null,
    resolution: '',
  }
  project.unknowns.push(unknown)
  project.updatedAt = nowIso()
  writeJson(projectPaths(workspace, slug).file, project)
  return unknown
}

export function updateUnknown(workspace, slug, id, patch = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const unknown = project.unknowns.find((u) => u.id === id)
  if (!unknown) throw new Error(`No unknown "${id}"`)
  if (typeof patch.question === 'string' && patch.question.trim()) unknown.question = patch.question.trim()
  if (typeof patch.evidence === 'string') unknown.evidence = patch.evidence
  if (typeof patch.owner === 'string') unknown.owner = patch.owner
  if (typeof patch.blocking === 'boolean') unknown.blocking = patch.blocking
  if (patch.stage === null) unknown.stage = null
  else if (typeof patch.stage === 'string' && STAGE_IDS.includes(patch.stage)) unknown.stage = patch.stage
  if (patch.status === 'open' || patch.status === 'closed') {
    unknown.status = patch.status
    unknown.closedAt = patch.status === 'closed' ? nowIso() : null
  }
  if (typeof patch.resolution === 'string') unknown.resolution = patch.resolution
  project.updatedAt = nowIso()
  writeJson(projectPaths(workspace, slug).file, project)
  return unknown
}

export function removeUnknown(workspace, slug, id) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const before = project.unknowns.length
  project.unknowns = project.unknowns.filter((u) => u.id !== id)
  project.updatedAt = nowIso()
  writeJson(projectPaths(workspace, slug).file, project)
  return project.unknowns.length !== before
}

/* ----------------------------------------------------------------- evidence */

export function addEvidence(workspace, slug, { id, source = '', stage = null, note = '', file = null }) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const evId = String(id ?? '').trim() || newId('ev')
  const existing = project.evidence.find((e) => e.id === evId)
  if (existing) {
    if (note) existing.note = note
    if (file) existing.file = file
    if (stage && STAGE_IDS.includes(stage)) existing.stage = stage
    project.updatedAt = nowIso()
    writeJson(projectPaths(workspace, slug).file, project)
    return existing
  }
  const record = {
    id: evId,
    source: String(source ?? ''),
    stage: STAGE_IDS.includes(stage) ? stage : null,
    note: String(note ?? ''),
    file: file ?? null,
    capturedAt: nowIso(),
  }
  project.evidence.push(record)
  project.updatedAt = nowIso()
  writeJson(projectPaths(workspace, slug).file, project)
  return record
}

/**
 * Snapshot the raw text that produced one or more evidence IDs. REA's CLI has
 * no session dump, so the only durable copy is what we write here.
 */
export function captureEvidence(workspace, slug, { ids = [], source = '', raw = '', maxBytes = 512 * 1024 } = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const list = Array.from(new Set((ids || []).map((x) => String(x).trim()).filter(Boolean)))
  if (!list.length) return { file: null, added: 0 }

  const paths = projectPaths(workspace, slug)
  ensureDir(paths.evidence)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)
  const name = `${stamp}-${digest}.json`
  const file = path.join(paths.evidence, name)

  let text = String(raw ?? '')
  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = text.slice(0, maxBytes)
    truncated = true
  }
  writeJson(file, {
    ids: list,
    source: String(source ?? ''),
    capturedAt: nowIso(),
    truncated,
    bytes: Buffer.byteLength(String(raw ?? ''), 'utf8'),
    raw: text,
  })

  const rel = path.relative(paths.dir, file).split(path.sep).join('/')
  let added = 0
  for (const id of list) {
    const existing = project.evidence.find((e) => e.id === id)
    if (existing) {
      existing.file = existing.file || rel
      continue
    }
    project.evidence.push({
      id,
      source: String(source ?? ''),
      stage: null,
      note: '',
      file: rel,
      capturedAt: nowIso(),
    })
    added += 1
  }
  project.updatedAt = nowIso()
  writeJson(paths.file, project)
  return { file: rel, added }
}

/* -------------------------------------------------------------------- cases */export function addCase(workspace, slug, testCase) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const id = String(testCase?.id ?? '').trim() || newId('case')
  const record = {
    id,
    title: String(testCase?.title ?? 'Untitled journey'),
    kind: String(testCase?.kind ?? 'unknown'),
    provider: String(testCase?.provider ?? ''),
    recordedAt: nowIso(),
    steps: Array.isArray(testCase?.steps) ? testCase.steps : [],
    expected: testCase?.expected ?? null,
    source: String(testCase?.source ?? ''),
    file: testCase?.file ?? null,
    parity: null,
  }
  project.cases = project.cases.filter((c) => c.id !== id).concat(record)
  project.updatedAt = nowIso()
  writeJson(projectPaths(workspace, slug).file, project)
  return record
}

/* -------------------------------------------------------------- target hash */

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Record (or refresh) the analysed target. Hashing is async and skips files
 * above `maxBytes` so a 200 MB installer does not stall the UI.
 */
export async function setTarget(workspace, slug, targetPath, { maxBytes = 512 * 1024 * 1024 } = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const abs = path.resolve(targetPath)
  const stat = fs.statSync(abs)
  let sha256 = null
  let hashed = false
  if (stat.isFile() && stat.size <= maxBytes) {
    sha256 = await hashFile(abs)
    hashed = true
  }
  project.target = {
    path: abs,
    sha256,
    size: stat.isFile() ? stat.size : null,
    kind: project.target?.kind ?? null,
    analyzedAt: hashed ? nowIso() : null,
  }
  project.updatedAt = nowIso()
  project.log.push({ at: nowIso(), event: 'target', detail: abs })
  writeJson(projectPaths(workspace, slug).file, project)
  return project.target
}

/** Full project plus computed gate state, for the renderer. */
export function projectDetail(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) return null
  const stages = STAGE_IDS.map((id) => {
    const def = STAGES.find((s) => s.id === id)
    const state = project.stages[id]
    const gate = stageGate(project, id)
    return { ...def, ...state, gate }
  })
  return { ...project, stageBoard: stages, paths: projectPaths(workspace, slug) }
}
