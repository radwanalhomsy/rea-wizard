#!/usr/bin/env node
/**
 * Build the REA Studio manual.
 *
 *   node manual/build.mjs [--lang ar] [--html-only]
 *
 * 1. Concatenate manual/NN-*.html (or manual/ar/NN-*.html) in filename order.
 * 2. Replace {{VERSION}}, {{DATE}}, {{REA_VERSION}}.
 * 3. Inject appendix data from manual/data/*.json.
 * 4. Inline manual.css, plus manual/ar/rtl.css for the Arabic edition.
 * 5. Print A4 PDF with Electron (manual/print.cjs).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const dataDir = path.join(here, 'data')

const argv = process.argv.slice(2)
const langFlag = argv.find((a) => a === '--lang' || a.startsWith('--lang='))
const lang = (langFlag
  ? (langFlag.includes('=') ? langFlag.split('=')[1] : argv[argv.indexOf(langFlag) + 1])
  : 'en') || 'en'
const isAr = lang.toLowerCase() === 'ar'
const sourceDir = isAr ? path.join(here, 'ar') : here

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'))
const meta = readJson('meta.json')
const commands = readJson('commands.json')
const tools = readJson('tools.json')
const workflows = readJson('workflows.json')

const version = pkg.version
const reaVersion = meta.reaVersion || '6.9.0'
const date = new Date().toISOString().slice(0, 10)

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function trimDesc(text, max = 170) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '))
  if (stop > max * 0.55) return cut.slice(0, stop + 1)
  return cut.slice(0, cut.lastIndexOf(' ')) + '…'
}

/* ------------------------------------------------------------- appendices */

const commandsHtml = [
  `<p class="small">${commands.length} commands · generated from REA ${esc(reaVersion)}</p>`,
  '<table class="cmds">',
  '<thead><tr><th style="width:45%">Command</th><th>Description</th></tr></thead>',
  '<tbody>',
  ...commands.map((c) =>
    `<tr><td><code>rea ${esc(c.cmd)}</code></td><td>${esc(c.desc)}</td></tr>`
  ),
  '</tbody></table>',
].join('\n')

const toolsHtml = [
  `<p class="small">${tools.length} tools · generated from the REA ${esc(reaVersion)} MCP catalog</p>`,
  '<div class="toolcols">',
  ...tools.map((t) =>
    `<div class="t"><b>${esc(t.name)}</b><br><span>${esc(t.title)} — ${esc(trimDesc(t.description))}</span></div>`
  ),
  '</div>',
].join('\n')

const workflowsHtml = workflows.map((w, i) => {
  const rows = w.arguments.map((a) =>
    `<tr><td><code>${esc(a.name)}</code></td><td>${a.required ? '<strong>Yes</strong>' : 'No'}</td><td>${esc(a.description)}</td></tr>`
  ).join('\n')
  return [
    `<h2>C.${i + 1} ${esc(w.id)} — ${esc(w.title)}</h2>`,
    `<p>${esc(w.description)}</p>`,
    '<table>',
    '<thead><tr><th style="width:26%">Argument</th><th style="width:12%">Required</th><th>Description</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}).join('\n')

/* --------------------------------------------------------------- assembly */

// Appendix A/B/C rows are generated from the installed REA release, so they stay
// in English in both editions. The Arabic build isolates them so the bidi
// algorithm cannot reorder commands, paths or argument names.
const wrapIndex = (s) => (isAr ? `<div class="en-index" dir="ltr">\n${s}\n</div>` : s)

const parts = fs.readdirSync(sourceDir)
  .filter((f) => /^\d{2}-.*\.html$/.test(f))
  .sort()
if (!parts.length) {
  console.error('No manual parts found in ' + sourceDir)
  process.exit(1)
}

let html = parts.map((f) => fs.readFileSync(path.join(sourceDir, f), 'utf8')).join('\n')

const cssFiles = [path.join(here, 'manual.css')]
if (isAr) cssFiles.push(path.join(here, 'ar', 'rtl.css'))
const css = cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
html = html.replace(
  /<link rel="stylesheet" href="manual\.css" \/>/,
  `<style>\n${css}\n</style>`
)

html = html
  .replaceAll('{{VERSION}}', esc(version))
  .replaceAll('{{DATE}}', esc(date))
  .replaceAll('{{REA_VERSION}}', esc(reaVersion))
  .replace('{{COMMANDS}}', wrapIndex(commandsHtml))
  .replace('{{TOOLS}}', wrapIndex(toolsHtml))
  .replace('{{WORKFLOWS}}', wrapIndex(workflowsHtml))

// Fail loudly if a placeholder survived.
const leftover = html.match(/\{\{[A-Z_]+\}\}/g)
if (leftover) {
  console.error('Unreplaced placeholders: ' + [...new Set(leftover)].join(', '))
  process.exit(1)
}

const htmlPath = path.join(here, isAr ? 'manual-ar.html' : 'manual.html')
fs.writeFileSync(htmlPath, html, 'utf8')
console.log(`assembled ${parts.length} parts (${lang}) -> ${path.relative(root, htmlPath)} (${(html.length / 1024).toFixed(0)} KB)`)

if (argv.includes('--html-only')) process.exit(0)

/* ------------------------------------------------------------------ print */

const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!fs.existsSync(electron)) {
  console.error('Electron not found at ' + electron + ' — run npm install first')
  process.exit(1)
}

const pdfPath = path.join(path.resolve(root, '..'), `REA-Studio-Manual-${version}${isAr ? '-ar' : ''}.pdf`)
const printScript = path.join(here, 'print.cjs')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MANUAL_VERSION = version
env.MANUAL_LANG = isAr ? 'ar' : 'en'

const res = spawnSync(electron, [printScript, htmlPath, pdfPath], {
  cwd: root,
  env,
  stdio: 'inherit',
  timeout: 300000,
})

if (res.error) {
  console.error('print failed: ' + res.error.message)
  process.exit(1)
}
if (res.status !== 0) {
  console.error('print failed with exit code ' + res.status)
  process.exit(1)
}
if (!fs.existsSync(pdfPath)) {
  console.error('PDF was not created at ' + pdfPath)
  process.exit(1)
}

// Chromium duplicates the text of a heading that starts a page in the tagged
// outline (e.g. "ContentsContents"). Repair those titles with pypdf when it is
// available; the manual is still valid without this step.
const fixer = path.join(here, 'fix-outline.py')
if (fs.existsSync(fixer)) {
  const tmpPdf = pdfPath.replace(/\.pdf$/i, '.outline.pdf')
  const py = ['python', 'py', 'python3'].find((exe) => {
    const probe = spawnSync(exe, ['-c', 'import pypdf'], { stdio: 'ignore' })
    return probe.status === 0
  })
  if (!py) {
    console.warn('pypdf not available — keeping the generated bookmarks as-is')
  } else {
    const fix = spawnSync(py, [fixer, pdfPath, tmpPdf], { stdio: 'inherit' })
    if (fix.status === 0 && fs.existsSync(tmpPdf)) {
      fs.copyFileSync(tmpPdf, pdfPath)
      fs.rmSync(tmpPdf, { force: true })
    } else {
      console.warn('bookmark title repair failed — keeping the generated bookmarks as-is')
    }
  }
}

const buf = fs.readFileSync(pdfPath)
const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()

console.log('')
console.log('PDF:    ' + pdfPath)
console.log('Pages:  ' + (pages || 'unknown'))
console.log('Size:   ' + buf.length.toLocaleString('en-US') + ' bytes (' + (buf.length / 1048576).toFixed(2) + ' MB)')
console.log('SHA256: ' + sha)
