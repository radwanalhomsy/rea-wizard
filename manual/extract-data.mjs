#!/usr/bin/env node
/**
 * Regenerate the manual appendix data from an installed REA release.
 *
 *   node manual/extract-data.mjs <llms.md> <mcp-catalog-full.json> <workflows.json>
 *
 * llms.md                  output of `rea --llms`
 * mcp-catalog-full.json    .../rea-agents/dist/mcp-catalog-full.json
 * workflows.json           output of `rea guided-workflows --format json`
 *
 * Writes manual/data/{commands,tools,workflows}.json and meta.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'data')

const [llmsPath, catalogPath, wfPath] = process.argv.slice(2)
if (!llmsPath || !catalogPath || !wfPath) {
  console.error('usage: node manual/extract-data.mjs <llms.md> <mcp-catalog-full.json> <workflows.json>')
  process.exit(2)
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

/* --------------------------------------------------------------- commands */

// Subcommands that `rea --llms` does not list (hidden command groups).
const EXTRA_COMMANDS = [
  { cmd: 'mcp add --agent opencode --command "npx -y rea-agents@6.9.0 mcp"', desc: 'Register REA as an MCP server in client settings (with backups)' },
  { cmd: 'mcp doctor', desc: 'Validate MCP server startup and tool listing' },
  { cmd: 'mcp', desc: 'MCP server registration and diagnostics' },
]

const llms = fs.readFileSync(llmsPath, 'utf8').replace(/^\uFEFF/, '')
const commands = []
for (const line of llms.split(/\r?\n/)) {
  const m = line.match(/^\|\s*`rea\s+(.+?)`\s*\|\s*(.*?)\s*\|$/)
  if (m) commands.push({ cmd: m[1].trim(), desc: m[2].trim() })
}
for (const c of EXTRA_COMMANDS) {
  if (!commands.some((x) => x.cmd === c.cmd)) commands.push(c)
}

/* ------------------------------------------------------------------ tools */

const catalog = readJson(catalogPath)
const tools = (catalog.tools || []).map((t) => ({
  name: t.name,
  title: t.title || t.name,
  description: t.description || '',
}))

/* -------------------------------------------------------------- workflows */

const wf = readJson(wfPath)
const workflows = (wf.workflows || []).map((w) => ({
  id: w.workflow_id,
  title: w.title || w.workflow_id,
  description: w.description || '',
  arguments: (w.arguments || []).map((a) => ({
    name: a.name,
    required: Boolean(a.required),
    description: a.description || '',
  })),
}))

/* ------------------------------------------------------------------ write */

fs.mkdirSync(outDir, { recursive: true })
const write = (name, value) =>
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n', 'utf8')

write('commands.json', commands)
write('tools.json', tools)
write('workflows.json', workflows)
write('meta.json', {
  reaVersion: catalog.info?.version || catalog.version || null,
  commandCount: commands.length,
  toolCount: tools.length,
  workflowCount: workflows.length,
  generated: new Date().toISOString().slice(0, 10),
})

console.log(`commands:  ${commands.length}`)
console.log(`tools:     ${tools.length}`)
console.log(`workflows: ${workflows.length}`)
console.log(`rea:       ${catalog.info?.version || catalog.version || 'unknown'}`)
console.log(`written to ${outDir}`)
