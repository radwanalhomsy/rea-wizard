/**
 * Format inference.
 *
 * Inspects files discovered by the artifact diff (or any explicit path) and
 * writes deterministic format skeletons to <project>/spec/formats/*.json.
 * These skeletons become data facts, feed the spec compiler, and give the
 * scaffolder enough structure to generate compatible readers/writers.
 *
 * Inference is deliberately conservative: known magic gets named fields,
 * unknown bytes stay "unknown" with observed offsets and strings rather than
 * being guessed into a false schema.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProject, projectPaths, addEvidence, captureEvidence } from './cloneStore.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_STRINGS = 200
const MIN_STRING = 4

const MAGIC = [
  { name: 'png', label: 'PNG image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'jpeg', label: 'JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif', label: 'GIF image', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'bmp', label: 'BMP image', bytes: [0x42, 0x4d] },
  { name: 'pdf', label: 'PDF document', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { name: 'zip', label: 'ZIP archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'gzip', label: 'gzip stream', bytes: [0x1f, 0x8b] },
  { name: 'sqlite', label: 'SQLite database', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
  { name: 'elf', label: 'ELF binary', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'pe', label: 'PE binary', bytes: [0x4d, 0x5a] },
  { name: 'wav', label: 'WAVE audio', bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, at: [0x57, 0x41, 0x56, 0x45] },
  { name: 'ico', label: 'ICO image', bytes: [0x00, 0x00, 0x01, 0x00] },
  { name: 'json', label: 'JSON text', bytes: [0x7b], text: true },
  { name: 'xml', label: 'XML text', bytes: [0x3c], text: true },
]

function matches(b, m) {
  if (m.offset) {
    const o = m.offset
    if (b.length < o + m.at.length) return false
    return m.at.every((v, i) => b[o + i] === v)
  }
  return m.bytes.every((v, i) => b[i] === v)
}

function hex(bytes) {
  return [...bytes].map((v) => v.toString(16).padStart(2, '0')).join(' ')
}

function stringAt(b, offset, encoding = 'ascii') {
  const out = []
  const step = encoding === 'utf16le' ? 2 : 1
  for (let i = offset; i + step <= b.length; i += step) {
    const code = encoding === 'utf16le' ? b.readUInt16LE(i) : b[i]
    if (code === 0 || code === 10 || code === 13 || code === 9) break
    if (code < 0x20 || code > 0x7e) break
    out.push(String.fromCharCode(code))
    if (out.length >= 200) break
  }
  return out.join('')
}

function extractStrings(b) {
  const ascii = []
  const utf16 = []
  for (let i = 0; i < b.length - 1; i++) {
    if (utf16.length < MAX_STRINGS && b[i] >= 0x20 && b[i] <= 0x7e && b[i + 1] === 0) {
      const value = stringAt(b, i, 'utf16le')
      if (value.length >= MIN_STRING) {
        utf16.push({ offset: `0x${i.toString(16)}`, encoding: 'utf16le', value })
        i += value.length * 2
        continue
      }
    }
    if (ascii.length < MAX_STRINGS && b[i] >= 0x20 && b[i] <= 0x7e &&
        (i === 0 || b[i - 1] < 0x20 || b[i - 1] > 0x7e)) {
      const value = stringAt(b, i, 'ascii')
      if (value.length >= MIN_STRING) {
        ascii.push({ offset: `0x${i.toString(16)}`, encoding: 'ascii', value })
      }
    }
  }
  return [...ascii, ...utf16].slice(0, MAX_STRINGS)
}

function shannon(b) {
  const counts = new Uint32Array(256)
  const step = Math.max(1, Math.floor(b.length / 32768))
  let total = 0
  for (let i = 0; i < b.length; i += step) { counts[b[i]]++; total++ }
  let h = 0
  for (const n of counts) {
    if (!n) continue
    const p = n / total
    h -= p * Math.log2(p)
  }
  return Number(h.toFixed(3))
}

/** Find common 4–16 byte runs; useful as record delimiters or file markers. */
function repeatedRuns(b) {
  const seen = new Map()
  const limit = Math.min(b.length, 256 * 1024)
  for (let len = 4; len <= 16; len += 4) {
    for (let i = 0; i + len <= limit; i++) {
      const key = b.subarray(i, i + len).toString('hex')
      const rec = seen.get(key) || { count: 0, first: i }
      rec.count++
      seen.set(key, rec)
    }
  }
  return [...seen.entries()]
    .filter(([, v]) => v.count >= 4)
    .sort((a, b2) => b2[1].count - a[1].count)
    .slice(0, 12)
    .map(([k, v]) => ({ bytes: hex(Buffer.from(k, 'hex')), count: v.count, firstOffset: `0x${v.first.toString(16)}` }))
}

function textPreview(b) {
  return b.subarray(0, 400).toString('utf8').replace(/[^\x20-\x7e\n\r\t]/g, '.')
}

function knownFields(fmt, b) {
  const base = [{ name: 'magic', offset: 0, size: fmt.bytes.length, value: hex(Buffer.from(fmt.bytes)), type: 'bytes' }]
  if (fmt.name === 'png' && b.length >= 24) {
    base.push(
      { name: 'ihdr_length', offset: 8, size: 4, value: b.readUInt32BE(8), type: 'uint32be' },
      { name: 'ihdr_type', offset: 12, size: 4, value: b.subarray(12, 16).toString('ascii'), type: 'ascii' },
      { name: 'width', offset: 16, size: 4, value: b.readUInt32BE(16), type: 'uint32be' },
      { name: 'height', offset: 20, size: 4, value: b.readUInt32BE(20), type: 'uint32be' },
      { name: 'bit_depth', offset: 24, size: 1, value: b[24], type: 'uint8' },
    )
  }
  if (fmt.name === 'jpeg') {
    base.push({ name: 'marker', offset: 0, size: 2, value: 'FFD8', type: 'uint16be' })
  }
  if (fmt.name === 'sqlite' && b.length >= 100) {
    base.push(
      { name: 'page_size', offset: 16, size: 2, value: b.readUInt16BE(16), type: 'uint16be' },
      { name: 'file_format_version', offset: 18, size: 2, value: b.readUInt16BE(18), type: 'uint16be' },
    )
  }
  if (fmt.name === 'elf' && b.length >= 20) {
    base.push(
      { name: 'class', offset: 4, size: 1, value: b[4] === 2 ? 'ELF64' : 'ELF32', type: 'enum' },
      { name: 'data', offset: 5, size: 1, value: b[5] === 1 ? 'little' : 'big', type: 'enum' },
    )
  }
  return base
}

/** Infer a single file's format skeleton. Deterministic for the same bytes. */
export function inferFormat(filePath, { label = null, maxBytes = MAX_BYTES } = {}) {
  const abs = path.resolve(String(filePath || ''))
  if (!fs.existsSync(abs)) throw new Error('Format source file does not exist')
  const st = fs.statSync(abs)
  if (!st.isFile()) throw new Error('Format source must be a file')
  const fd = fs.openSync(abs, 'r')
  let b
  try {
    b = Buffer.alloc(Math.min(st.size, maxBytes))
    fs.readSync(fd, b, 0, b.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  const magic = MAGIC.find((m) => matches(b, m)) || null
  const printable = b.length
    ? [...b.subarray(0, Math.min(b.length, 4096))].filter((v) => v === 9 || v === 10 || v === 13 || (v >= 0x20 && v <= 0x7e)).length /
      Math.min(b.length, 4096)
    : 0
  const isText = printable > 0.9
  let textKind = null
  if (isText) {
    const head = textPreview(b).trimStart()
    if (head.startsWith('{') || head.startsWith('[')) textKind = 'json'
    else if (head.startsWith('<')) textKind = 'xml'
    else if (/^#\s/.test(head)) textKind = 'markdown'
    else if (head.includes('=') && /^[\w.]+=/m.test(head)) textKind = 'ini'
    else textKind = 'text'
  }
  const fmt = magic || (textKind ? { name: textKind, label: `${textKind} text`, bytes: [...b.subarray(0, 1)], text: true } : null)
  const strings = extractStrings(b)
  const fields = magic ? knownFields(magic, b) : []
  if (!fields.length) {
    fields.push({ name: 'header', offset: 0, size: Math.min(32, b.length), value: hex(b.subarray(0, Math.min(32, b.length))), type: 'bytes' })
  }

  return {
    schema: 1,
    name: label || fmt?.name || 'unknown',
    label: fmt?.label || (isText ? `${textKind || 'text'} text` : 'unknown binary'),
    source: { path: abs, size: st.size, sha256: crypto.createHash('sha256').update(b).digest('hex'), modifiedAt: st.mtime.toISOString() },
    magic: fmt ? hex(Buffer.from(fmt.bytes)) : null,
    text: { detected: isText, kind: textKind, printableRatio: Number(printable.toFixed(3)), preview: isText ? textPreview(b) : null },
    entropy: shannon(b),
    fields,
    strings,
    repeatedRuns: repeatedRuns(b),
    confidence: fmt ? (magic ? 0.9 : 0.7) : 0.3,
    unknownBytes: fmt ? Math.max(0, st.size - fields.reduce((n, f) => n + (f.size || 0), 0)) : st.size,
  }
}

function slugFor(name) {
  return String(name || 'format').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'format'
}

function markdown(formats) {
  const lines = ['# Inferred formats', '', `${formats.length} format skeleton(s).`, '']
  for (const f of formats) {
    lines.push(`## ${f.label} — \`${f.name}\``, '')
    lines.push(`- **Source:** \`${f.source.path}\` (${f.source.size} bytes)`)
    lines.push(`- **SHA-256:** \`${f.source.sha256}\``)
    lines.push(`- **Magic:** ${f.magic || '—'} · **Entropy:** ${f.entropy} · **Confidence:** ${f.confidence}`)
    lines.push('', '| Field | Offset | Size | Type | Value |', '| --- | --- | --- | --- | --- |')
    for (const field of f.fields) {
      lines.push(`| ${field.name} | ${field.offset} | ${field.size} | ${field.type} | ${String(field.value).slice(0, 80)} |`)
    }
    if (f.strings.length) {
      lines.push('', 'Strings:', '')
      for (const s of f.strings.slice(0, 40)) lines.push(`- \`${s.offset}\` (${s.encoding}) ${s.value}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function writeFormat(workspace, slug, fmt) {
  const paths = projectPaths(workspace, slug)
  const dir = path.join(paths.spec, 'formats')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${slugFor(fmt.name)}.json`)
  fs.writeFileSync(file, JSON.stringify(fmt, null, 2) + '\n', 'utf8')
  return `spec/formats/${slugFor(fmt.name)}.json`
}

export function listFormats(workspace, slug) {
  const dir = path.join(projectPaths(workspace, slug).spec, 'formats')
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  } catch {
    return []
  }
}

function report(workspace, slug, formats, files) {
  const paths = projectPaths(workspace, slug)
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'formats.md'), markdown(formats), 'utf8')
  return [...files, 'reports/formats.md']
}

/** Infer formats for files named in the artifact diff that still exist. */
export function inferFromArtifacts(workspace, slug, { limit = 24 } = {}) {
  const paths = projectPaths(workspace, slug)
  let diff = null
  try {
    diff = JSON.parse(fs.readFileSync(path.join(paths.spec, 'persistence.json'), 'utf8'))
  } catch {
    throw new Error('No artifact diff yet. Run Artifacts first.')
  }
  const candidates = (diff.artifacts || [])
    .filter((a) => a.kind === 'file' && a.operation !== 'deleted')
    .map((a) => a.path)
    .filter((p) => typeof p === 'string' && fs.existsSync(p))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 24)))
  if (!candidates.length) throw new Error('No existing artifact files to inspect')

  const formats = []
  const files = []
  const evidence = []
  for (const candidate of candidates) {
    const fmt = inferFormat(candidate, { label: path.basename(candidate) })
    files.push(writeFormat(workspace, slug, fmt))
    formats.push(fmt)
    const evId = `ev_fmt_${fmt.source.sha256.slice(0, 12)}`
    addEvidence(workspace, slug, {
      id: evId,
      source: 'format-infer',
      stage: 'data',
      note: `${fmt.label} (${fmt.confidence}): ${path.basename(candidate)}`,
      file: files[files.length - 1],
    })
    evidence.push(evId)
  }
  captureEvidence(workspace, slug, {
    ids: evidence,
    source: 'format-infer',
    raw: JSON.stringify(formats.map((f) => ({ name: f.name, magic: f.magic, fields: f.fields.length }))),
  })
  return { formats: formats.map((f) => ({ name: f.name, label: f.label, confidence: f.confidence, fields: f.fields.length })), evidence, files: report(workspace, slug, formats, files) }
}

/** Infer one explicit file and persist it. */
export function inferFile(workspace, slug, filePath, label = null) {
  const fmt = inferFormat(filePath, { label })
  const file = writeFormat(workspace, slug, fmt)
  const evId = `ev_fmt_${fmt.source.sha256.slice(0, 12)}`
  addEvidence(workspace, slug, {
    id: evId,
    source: 'format-infer',
    stage: 'data',
    note: `${fmt.label} (${fmt.confidence}): ${path.basename(fmt.source.path)}`,
    file,
  })
  captureEvidence(workspace, slug, { ids: [evId], source: 'format-infer', raw: JSON.stringify(fmt) })
  return { format: fmt, evidence: [evId], files: report(workspace, slug, [fmt], [file]) }
}
