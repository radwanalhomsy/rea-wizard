/**
 * Target exploration.
 *
 * Produces a deterministic, offline inventory of a binary target: real SHA-256,
 * PE/COFF headers, sections, imports, exports, bounded strings and a byte
 * histogram. No network, no external CLI, no Ghidra required — this is the
 * inventory layer every later clone tool builds on.
 *
 * The result is written to <project>/spec/inventory.json, captured as durable
 * evidence, and folded into the semantic fact ledger by cloneFacts.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths, addEvidence } from './cloneStore.mjs'

const MAX_STRINGS = 400
const MIN_STRING_LEN = 5
const MAX_STRING_LEN = 200
const MAX_IMPORTS = 400
const MAX_EXPORTS = 400
const MAX_READ = 256 * 1024 * 1024

function u16(b, o) { return b.readUInt16LE(o) }
function u32(b, o) { return b.readUInt32LE(o) }
function u64(b, o) { return Number(b.readBigUInt64LE(o)) }

function cstring(b, offset, max = 512) {
  if (offset < 0 || offset >= b.length) return ''
  const end = Math.min(b.length, offset + max)
  let i = offset
  while (i < end && b[i] !== 0) i++
  return b.subarray(offset, i).toString('utf8').replace(/[^\x20-\x7e]/g, '')
}

function align(n, a) { return a > 0 ? Math.ceil(n / a) * a : n }

/** Map a PE relative virtual address to a file offset using the section table. */
function rvaToOffset(rva, sections, sizeOfHeaders) {
  if (rva < sizeOfHeaders) return rva
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      const delta = rva - s.virtualAddress
      if (delta >= s.rawSize) return -1
      return s.rawPointer + delta
    }
  }
  return -1
}

function parseSections(b, count, offset) {
  const out = []
  for (let i = 0; i < count; i++) {
    const o = offset + i * 40
    if (o + 40 > b.length) break
    const name = b.subarray(o, o + 8).toString('utf8').replace(/\0+$/, '')
    out.push({
      name,
      virtualSize: u32(b, o + 8),
      virtualAddress: u32(b, o + 12),
      rawSize: u32(b, o + 16),
      rawPointer: u32(b, o + 20),
      characteristics: u32(b, o + 36),
    })
  }
  return out
}

function parseImports(b, dir, sections, sizeOfHeaders, is64) {
  const imports = []
  if (!dir || !dir.virtualAddress || !dir.size) return imports
  const step = is64 ? 8 : 4
  const ordFlag = is64 ? 0x8000000000000000n : 0x80000000
  let o = rvaToOffset(dir.virtualAddress, sections, sizeOfHeaders)
  if (o < 0) return imports
  for (let guard = 0; guard < 512 && imports.length < MAX_IMPORTS; guard++) {
    if (o + 20 > b.length) break
    const originalFirstThunk = u32(b, o)
    const nameRva = u32(b, o + 12)
    const firstThunk = u32(b, o + 16)
    if (!originalFirstThunk && !nameRva && !firstThunk) break
    const dll = cstring(b, rvaToOffset(nameRva, sections, sizeOfHeaders))
    const functions = []
    const thunkRva = originalFirstThunk || firstThunk
    let t = rvaToOffset(thunkRva, sections, sizeOfHeaders)
    if (t >= 0) {
      for (let j = 0; j < 1024 && functions.length < 200; j++) {
        if (t + step > b.length) break
        const value = is64 ? u64(b, t) : u32(b, t)
        if (!value) break
        const isOrdinal = is64
          ? (BigInt(value) & 0x8000000000000000n) !== 0n
          : (value & 0x80000000) !== 0
        if (isOrdinal) {
          functions.push({ ordinal: Number(is64 ? BigInt(value) & 0xffffn : BigInt(value & 0xffff)) })
        } else {
          const nameOff = rvaToOffset(Number(value) & 0x7fffffff, sections, sizeOfHeaders)
          if (nameOff >= 0) functions.push({ name: cstring(b, nameOff + 2) })
        }
        t += step
      }
    }
    imports.push({ dll, count: functions.length, functions })
    o += 20
  }
  return imports
}

function parseExports(b, dir, sections, sizeOfHeaders) {
  if (!dir || !dir.virtualAddress || !dir.size) return null
  const o = rvaToOffset(dir.virtualAddress, sections, sizeOfHeaders)
  if (o < 0 || o + 40 > b.length) return null
  const nameRva = u32(b, o + 12)
  const base = u32(b, o + 16)
  const numberOfFunctions = u32(b, o + 20)
  const numberOfNames = u32(b, o + 24)
  const namesRva = u32(b, o + 28)
  const names = []
  const no = rvaToOffset(namesRva, sections, sizeOfHeaders)
  if (no >= 0) {
    for (let i = 0; i < Math.min(numberOfNames, MAX_EXPORTS); i++) {
      if (no + i * 4 + 4 > b.length) break
      const nr = u32(b, no + i * 4)
      const so = rvaToOffset(nr, sections, sizeOfHeaders)
      if (so >= 0) {
        const name = cstring(b, so)
        if (name) names.push({ name, ordinal: base + i })
      }
    }
  }
  return {
    dll: cstring(b, rvaToOffset(nameRva, sections, sizeOfHeaders)),
    base,
    functions: numberOfFunctions,
    names,
  }
}

function parsePe(b) {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) throw new Error('Not a PE/MZ binary')
  const pe = u32(b, 0x3c)
  if (pe + 24 > b.length || b[pe] !== 0x50 || b[pe + 1] !== 0x45) throw new Error('Missing PE signature')
  const coff = pe + 4
  const machine = u16(b, coff)
  const numberOfSections = u16(b, coff + 2)
  const timeDateStamp = u32(b, coff + 4)
  const sizeOfOptionalHeader = u16(b, coff + 16)
  const characteristics = u16(b, coff + 18)
  const opt = coff + 20
  const magic = u16(b, opt)
  const is64 = magic === 0x20b
  if (!is64 && magic !== 0x10b) throw new Error(`Unsupported optional header magic 0x${magic.toString(16)}`)

  const addressOfEntryPoint = u32(b, opt + 16)
  const imageBase = is64 ? u64(b, opt + 24) : u32(b, opt + 28)
  const sectionAlignment = u32(b, opt + 32)
  const fileAlignment = u32(b, opt + 36)
  const sizeOfImage = u32(b, opt + 56)
  const sizeOfHeaders = u32(b, opt + 60)
  const subsystem = u16(b, opt + 68)
  const dllCharacteristics = u16(b, opt + 70)
  const ddCountOffset = opt + (is64 ? 108 : 92)
  const ddOffset = opt + (is64 ? 112 : 96)
  const numberOfRvaAndSizes = Math.min(u32(b, ddCountOffset), 16)
  const directories = []
  for (let i = 0; i < numberOfRvaAndSizes; i++) {
    const o = ddOffset + i * 8
    if (o + 8 > b.length) break
    directories.push({ virtualAddress: u32(b, o), size: u32(b, o + 4) })
  }
  const sections = parseSections(b, numberOfSections, opt + sizeOfOptionalHeader)
  const imports = parseImports(b, directories[1], sections, sizeOfHeaders, is64)
  const exports = parseExports(b, directories[0], sections, sizeOfHeaders)

  const arch = { 0x14c: 'x86', 0x8664: 'x64', 0x1c0: 'arm', 0xaa64: 'arm64' }[machine] || `0x${machine.toString(16)}`
  const subsystemName = { 2: 'GUI', 3: 'console', 5: 'OS/2', 7: 'POSIX', 9: 'CE GUI', 10: 'EFI app', 11: 'EFI boot', 12: 'EFI runtime', 13: 'EFI ROM', 14: 'XBOX', 16: 'boot' }[subsystem] || String(subsystem)

  return {
    format: 'pe',
    arch,
    machine: `0x${machine.toString(16)}`,
    bits: is64 ? 64 : 32,
    entryPointRva: `0x${addressOfEntryPoint.toString(16)}`,
    imageBase: `0x${imageBase.toString(16)}`,
    sectionAlignment,
    fileAlignment,
    sizeOfImage,
    sizeOfHeaders,
    subsystem: subsystemName,
    dllCharacteristics: `0x${dllCharacteristics.toString(16)}`,
    characteristics: `0x${characteristics.toString(16)}`,
    compiledAt: Number.isFinite(timeDateStamp) && timeDateStamp > 0
      ? new Date(timeDateStamp * 1000).toISOString()
      : null,
    sections,
    imports,
    exports,
  }
}

function extractStrings(b) {
  const out = []
  let start = -1
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i] : 0
    const printable = c >= 0x20 && c <= 0x7e
    if (printable && start < 0) start = i
    if (!printable && start >= 0) {
      const len = i - start
      if (len >= MIN_STRING_LEN && len <= MAX_STRING_LEN) {
        out.push({ offset: `0x${start.toString(16)}`, value: b.subarray(start, i).toString('ascii') })
      }
      start = -1
      if (out.length >= MAX_STRINGS) break
    }
  }
  return out
}

function byteHistogram(b) {
  const h = new Array(16).fill(0)
  let total = 0
  const step = Math.max(1, Math.floor(b.length / 65536))
  for (let i = 0; i < b.length; i += step) {
    h[b[i] >> 4]++
    total++
  }
  return h.map((n) => total ? Number((n / total).toFixed(4)) : 0)
}

function markdown(inv) {
  const lines = [
    '# Target inventory',
    '',
    `- **File:** \`${inv.file.path}\``,
    `- **SHA-256:** \`${inv.file.sha256 || 'not computed'}\``,
    `- **Size:** ${inv.file.size} bytes`,
    `- **Format:** ${inv.pe?.format || inv.file.kind || 'unknown'} ${inv.pe?.arch || ''} ${inv.pe?.bits ? `(${inv.pe.bits}-bit)` : ''}`,
    `- **Entry point:** ${inv.pe?.entryPointRva || '—'} @ ${inv.pe?.imageBase || '—'}`,
    `- **Subsystem:** ${inv.pe?.subsystem || '—'}`,
    '',
    '## Sections',
    '',
    '| Name | Virtual address | Virtual size | Raw size | Characteristics |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const s of inv.pe?.sections || []) {
    lines.push(`| ${s.name} | 0x${s.virtualAddress.toString(16)} | 0x${s.virtualSize.toString(16)} | 0x${s.rawSize.toString(16)} | 0x${s.characteristics.toString(16)} |`)
  }
  lines.push('', '## Imports', '')
  for (const imp of inv.pe?.imports || []) {
    const names = imp.functions.map((f) => f.name || `#${f.ordinal}`).slice(0, 12).join(', ')
    lines.push(`- **${imp.dll || '(unknown)'}** (${imp.count}) — ${names}${imp.count > 12 ? ', …' : ''}`)
  }
  if (!inv.pe?.imports?.length) lines.push('_No imports parsed._')
  if (inv.pe?.exports?.names?.length) {
    lines.push('', '## Exports', '')
    for (const e of inv.pe.exports.names.slice(0, 40)) lines.push(`- ${e.name} (ordinal ${e.ordinal})`)
  }
  lines.push('', `## Strings (${inv.strings.length} of ${inv.stats.stringCountTotal} total)`, '')
  for (const s of inv.strings.slice(0, 80)) lines.push(`- \`${s.offset}\` ${s.value}`)
  lines.push('')
  return lines.join('\n')
}

/** Analyze a file path and return a structured inventory (no project writes). */
export function analyzeFile(filePath, hash = null) {
  const abs = path.resolve(String(filePath || ''))
  if (!fs.existsSync(abs)) throw new Error('Target file does not exist')
  const st = fs.statSync(abs)
  if (!st.isFile()) throw new Error('Target must be a file')
  const b = fs.readFileSync(abs)
  if (b.length > MAX_READ) throw new Error('Target is too large to analyze in memory')
  const sha256 = hash || crypto.createHash('sha256').update(b).digest('hex')
  let pe = null
  let parseError = null
  try {
    pe = parsePe(b)
  } catch (e) {
    parseError = e.message
  }
  const allStrings = extractStrings(b)
  return {
    schema: 1,
    // Tie metadata to the file itself so the inventory is byte-identical for
    // the same target, regardless of when it was analyzed.
    sourceModifiedAt: st.mtime.toISOString(),
    file: { path: abs, sha256, size: st.size, kind: pe?.format || (b[0] === 0x7f && b[1] === 0x45 ? 'elf' : 'unknown') },
    pe,
    parseError,
    strings: allStrings.slice(0, MAX_STRINGS),
    stats: {
      stringCountTotal: allStrings.length,
      nibbleHistogram: byteHistogram(b),
      importCount: (pe?.imports || []).reduce((n, i) => n + i.count, 0),
      exportCount: pe?.exports?.names?.length || 0,
      sectionCount: (pe?.sections || []).length,
    },
  }
}

/**
 * Run a full exploration for a clone project: hash via the canonical store,
 * parse, persist inventory + report, and capture durable evidence.
 */
export async function exploreTarget(workspace, slug, { targetPath = null } = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const store = await import('./cloneStore.mjs')
  const file = targetPath || project.target?.path
  if (!file) throw new Error('No target path set for this project')
  const target = await store.setTarget(workspace, slug, file)
  const inventory = analyzeFile(file, target.sha256)
  const paths = projectPaths(workspace, slug)
  fs.mkdirSync(paths.spec, { recursive: true })
  fs.writeFileSync(path.join(paths.spec, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', 'utf8')
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'inventory.md'), markdown(inventory), 'utf8')

  const source = 'explore'
  const evTarget = `ev_explore_${(target.sha256 || '').slice(0, 12)}`
  const added = []
  const recTarget = store.addEvidence(workspace, slug, {
    id: evTarget,
    source,
    stage: 'inventory',
    note: `Target identity ${inventory.file.sha256 ? inventory.file.sha256.slice(0, 16) : path.basename(file)}`,
    file: 'spec/inventory.json',
  })
  added.push(recTarget.id)
  if (inventory.pe) {
    const evPe = `ev_explore_pe_${(target.sha256 || '').slice(0, 8)}`
    added.push(store.addEvidence(workspace, slug, {
      id: evPe,
      source,
      stage: 'inventory',
      note: `${inventory.pe.format} ${inventory.pe.arch} ${inventory.pe.bits}-bit, ${inventory.stats.sectionCount} sections, ${inventory.stats.importCount} imports`,
      file: 'reports/inventory.md',
    }).id)
  }
  store.captureEvidence(workspace, slug, {
    ids: added,
    source,
    raw: JSON.stringify(inventory),
  })

  return {
    target,
    file: inventory.file,
    pe: inventory.pe ? {
      format: inventory.pe.format,
      arch: inventory.pe.arch,
      bits: inventory.pe.bits,
      sections: inventory.stats.sectionCount,
      imports: inventory.stats.importCount,
      exports: inventory.stats.exportCount,
    } : null,
    parseError: inventory.parseError,
    strings: inventory.strings.length,
    evidence: added,
    files: ['spec/inventory.json', 'reports/inventory.md'],
  }
}

export function readInventory(workspace, slug) {
  const file = path.join(projectPaths(workspace, slug).spec, 'inventory.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
