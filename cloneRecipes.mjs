/**
 * Recipe Store.
 *
 * A recipe is a reusable, evidence-backed description of how a measured gap
 * was closed: which tools were run, on which cases, with which verifications.
 * Recipes are saved at the workspace level so they can be reused across clone
 * projects. Applying a recipe never executes arbitrary code and never claims
 * success — it writes a plan whose steps stay `pending` until the tools are
 * actually run and re-measured.
 *
 * Store: <workspace>/.rea-clone/recipes.json
 * Project outputs: spec/recipe-plan.json, reports/recipe.md
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths, rootFor } from './cloneStore.mjs'
import { readFidelity } from './cloneFidelity.mjs'
import { repairStatus } from './cloneRepair.mjs'

const SCHEMA = 1

function storeFile(workspace) {
  return path.join(rootFor(workspace), 'recipes.json')
}

function readStore(workspace) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(workspace), 'utf8'))
    return Array.isArray(data?.recipes) ? data : { schema: SCHEMA, recipes: [] }
  } catch {
    return { schema: SCHEMA, recipes: [] }
  }
}

function writeStore(workspace, store) {
  fs.mkdirSync(rootFor(workspace), { recursive: true })
  fs.writeFileSync(storeFile(workspace), JSON.stringify({ schema: SCHEMA, recipes: store.recipes }, null, 2) + '\n', 'utf8')
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
}

function digest(value, n = 12) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, n)
}

function uniqueSorted(list) {
  return Array.from(new Set((list || []).map(String).filter(Boolean))).sort()
}

function slice(value, cap = 4000) {
  const text = JSON.stringify(value ?? null)
  if (text.length <= cap) return value
  return { truncated: true, preview: text.slice(0, cap), bytes: text.length }
}

/* ------------------------------------------------------------------- save */

/** Build a recipe from the current project state without writing it. */
export function buildRecipe(workspace, slug, options = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const cases = (project.cases || []).filter((c) =>
    !options.caseIds || (Array.isArray(options.caseIds) && options.caseIds.includes(c.id)),
  ).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const fidelity = readFidelity(workspace, slug)
  const repair = repairStatus(workspace, slug)

  const tools = uniqueSorted(cases.map((c) => c.provider))
  if (repair.applied) tools.push('repair')
  const uniqueTools = uniqueSorted(tools)

  const steps = cases.map((c, i) => ({
    index: i + 1,
    tool: c.provider,
    action: c.title || c.id,
    input: slice(c.request || null),
    verify: c.parity ? `case ${c.id}: ${c.parity.status}` : `replay case ${c.id} and record parity`,
    evidence: uniqueSorted(c.evidenceIds || []),
  }))
  if (repair.applied) {
    steps.push({
      index: steps.length + 1,
      tool: 'repair',
      action: 'Apply the proven transcript repair and re-verify parity',
      input: { runner: repair.summary },
      verify: 'each repaired case reaches parity match',
      evidence: [],
    })
  }

  const evidence = uniqueSorted([
    ...(project.evidence || []).map((e) => e.id),
    ...cases.flatMap((c) => c.evidenceIds || []),
  ])
  const caseIds = cases.map((c) => c.id)
  const body = {
    name: String(options.name || `Recipe: ${project.name}`).trim(),
    description: String(options.description || '').trim(),
    tags: uniqueSorted(options.tags || []),
    source: {
      project: project.slug,
      targetSha256: project.target?.sha256 || null,
      tier: fidelity?.tier?.id || null,
      score: fidelity?.score ?? null,
      measuredWeight: fidelity?.measuredWeight ?? null,
    },
    tools: uniqueTools,
    evidence,
    cases: caseIds,
    steps,
  }
  const id = `recipe_${digest({ name: body.name, tools: body.tools, cases: body.cases, evidence: body.evidence })}`
  return { schema: SCHEMA, id, ...body }
}

/** Persist a recipe in the workspace-level store (idempotent by id). */
export function saveRecipe(workspace, slug, options = {}) {
  const recipe = buildRecipe(workspace, slug, options)
  const store = readStore(workspace)
  const index = store.recipes.findIndex((r) => r.id === recipe.id)
  if (index >= 0) {
    store.recipes[index] = { ...recipe, createdAt: store.recipes[index].createdAt || new Date().toISOString() }
  } else {
    store.recipes.push({ ...recipe, createdAt: new Date().toISOString() })
  }
  store.recipes.sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id))
  writeStore(workspace, store)
  return { ok: true, recipe, count: store.recipes.length, file: '.rea-clone/recipes.json' }
}

export function listRecipes(workspace) {
  const store = readStore(workspace)
  return {
    ok: true,
    recipes: store.recipes.map((r) => ({
      id: r.id, name: r.name, description: r.description, tags: r.tags,
      tools: r.tools, cases: r.cases?.length || 0, evidence: r.evidence?.length || 0,
      tier: r.source?.tier || null, createdAt: r.createdAt,
    })),
    file: '.rea-clone/recipes.json',
  }
}

export function getRecipe(workspace, id) {
  const store = readStore(workspace)
  const recipe = store.recipes.find((r) => r.id === id)
  return { ok: Boolean(recipe), recipe: recipe || null, error: recipe ? null : `No recipe "${id}"` }
}

export function deleteRecipe(workspace, id) {
  const store = readStore(workspace)
  const next = store.recipes.filter((r) => r.id !== id)
  if (next.length === store.recipes.length) return { ok: false, error: `No recipe "${id}"` }
  writeStore(workspace, { ...store, recipes: next })
  return { ok: true, id, count: next.length }
}

/* ------------------------------------------------------------------- apply */

/**
 * Materialise a recipe as a pending plan in a target project. This writes no
 * implementation and asserts no success; every step stays `pending`.
 */
export function applyRecipe(workspace, slug, id) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const store = readStore(workspace)
  const recipe = store.recipes.find((r) => r.id === id)
  if (!recipe) throw new Error(`No recipe "${id}"`)

  const plan = {
    schema: 1,
    recipe: recipe.id,
    name: recipe.name,
    targetProject: project.slug,
    honesty: 'A pending guide. Steps only become complete when the named tool is run and re-measured.',
    steps: (recipe.steps || []).map((s) => ({
      ...s,
      status: 'pending',
      completedAt: null,
      prerequisite: s.tool === 'repair' ? 'A deterministic Oracle self-check must exist for the case.' : null,
    })),
    verification: (recipe.cases || []).map((caseId) => ({
      case: caseId,
      status: project.cases?.find((c) => c.id === caseId)?.parity?.status || 'not recorded',
      target: 'match',
    })),
    source: recipe.source,
  }
  write(path.join(paths.spec, 'recipe-plan.json'), JSON.stringify(plan, null, 2))
  const lines = [
    '# Recipe plan', '',
    `${recipe.name} → ${project.slug}`, '',
    plan.honesty, '',
    '| # | Tool | Step | Verify | Status |',
    '| --- | --- | --- | --- | --- |',
    ...plan.steps.map((s) => `| ${s.index} | ${s.tool} | ${String(s.action).replace(/\|/g, '\\|')} | ${String(s.verify).replace(/\|/g, '\\|')} | ${s.status} |`),
    '',
  ]
  write(path.join(paths.reports, 'recipe.md'), lines.join('\n'))
  return { ok: true, plan, files: ['spec/recipe-plan.json', 'reports/recipe.md'] }
}

export function exportRecipes(workspace) {
  const store = readStore(workspace)
  return { ok: true, exported: store, text: JSON.stringify(store, null, 2) }
}

export function importRecipes(workspace, { text = '', mode = 'merge' } = {}) {
  let incoming
  try { incoming = JSON.parse(String(text)) } catch { throw new Error('Recipe JSON could not be parsed') }
  const list = Array.isArray(incoming?.recipes) ? incoming.recipes : Array.isArray(incoming) ? incoming : null
  if (!list) throw new Error('Recipe JSON has no recipes array')
  const valid = list.filter((r) => r && r.id && r.name && Array.isArray(r.steps))
  if (!valid.length) throw new Error('No valid recipes found')
  const store = readStore(workspace)
  const byId = new Map(store.recipes.map((r) => [r.id, r]))
  for (const r of valid) {
    if (mode === 'replace' || !byId.has(r.id)) byId.set(r.id, { schema: SCHEMA, ...r })
  }
  store.recipes = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id))
  writeStore(workspace, store)
  return { ok: true, imported: valid.length, count: store.recipes.length }
}

export function recipeStatus(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  let plan = null
  try { plan = JSON.parse(fs.readFileSync(path.join(paths.spec, 'recipe-plan.json'), 'utf8')) } catch { /* none */ }
  return {
    ok: true,
    applied: Boolean(plan),
    recipe: plan?.recipe || null,
    steps: (plan?.steps || []).length,
    pending: (plan?.steps || []).filter((s) => s.status === 'pending').length,
  }
}

export function recipeGet(workspace, slug) {
  const store = readStore(workspace)
  let plan = null
  try {
    plan = JSON.parse(fs.readFileSync(path.join(projectPaths(workspace, slug).spec, 'recipe-plan.json'), 'utf8'))
  } catch { /* none */ }
  return { ok: true, recipes: store.recipes, plan, status: recipeStatus(workspace, slug) }
}
