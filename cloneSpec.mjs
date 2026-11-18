/**
 * Spec compiler and scaffolder.
 *
 * Both are deterministic: the same project state produces byte-identical
 * output. Nothing here calls REA or the network, so it works on any host.
 *
 * Honesty rules:
 *  - every generated claim cites the evidence IDs or case IDs behind it
 *  - a dimension that was never checked is written as unchecked, never "ok"
 *  - generated code is a skeleton with explicit TODOs, not a pretend clone
 */

import fs from 'node:fs'
import path from 'node:path'
import { getProject, projectPaths, readCase } from './cloneStore.mjs'

/* ------------------------------------------------------------------ helpers */

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function write(file, text) {
  ensure(path.dirname(file))
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
}

function rel(workspace, slug, file) {
  return path.relative(projectPaths(workspace, slug).dir, file).split(path.sep).join('/')
}

function ident(text) {
  const s = String(text ?? '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
  return s || 'Feature'
}

function camel(text) {
  const i = ident(text)
  return i ? i[0].toLowerCase() + i.slice(1) : 'feature'
}

function fence(text, lang = '') {
  return '```' + lang + '\n' + text + '\n```'
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

function caseList(workspace, slug, project) {
  return (project.cases || [])
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((entry) => {
      let request = null
      let observation = null
      try {
        const full = readCase(workspace, slug, entry.id)
        request = full.request
        observation = full.record?.observation ?? null
      } catch { }
      return { ...entry, request, observation }
    })
}

function stepLines(c) {
  const steps = Array.isArray(c.steps) ? c.steps : []
  return steps.map((s, i) => {
    const action = s.action ?? 'step'
    const target = s.target ? ` ${s.target}` : ''
    const status = s.status ? ` (${s.status})` : ''
    return `${i + 1}. \`${action}\`${target}${status}`
  })
}

/* ------------------------------------------------------------ spec compiler */

export function compileSpec(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const paths = projectPaths(workspace, slug)
  const cases = caseList(workspace, slug, project)
  const written = []

  /* -------------------------------------------------------------- features */
  const board = project.stageBoard || Object.entries(project.stages || {}).map(([id, s]) => ({ id, ...s }))
  const stageTable = table(
    ['Stage', 'Status', 'Note'],
    board.map((s) => [s.id, s.status, s.note || '']),
  )

  const caseTable = cases.length
    ? table(
        ['Case', 'Kind', 'Title', 'Steps', 'Evidence'],
        cases.map((c) => [
          c.id,
          c.kind,
          c.title,
          (c.steps || []).length,
          (c.evidenceIds || []).join(' ') || '—',
        ]),
      )
    : '_No journeys recorded yet._'

  const featureMd = [
    `# Features — ${project.name}`,
    '',
    'Generated from recorded evidence. Every row names the case or evidence ID behind it;',
    'nothing here is inferred beyond what was captured.',
    '',
    '## Target',
    '',
    project.target
      ? [
          `- Path: \`${project.target.path}\``,
          `- SHA-256: \`${project.target.sha256 || 'not hashed'}\``,
          `- Size: ${project.target.size ?? 'unknown'} bytes`,
          `- Kind: ${project.target.kind || 'unknown'}`,
        ].join('\n')
      : '- No target recorded.',
    '',
    '## Stage state',
    '',
    stageTable,
    '',
    '## Recorded journeys',
    '',
    caseTable,
    '',
    '## Per-journey detail',
    '',
    ...(cases.length
      ? cases.flatMap((c) => [
          `### ${c.title}`,
          '',
          `- Case: \`${c.id}\``,
          `- Kind: ${c.kind}`,
          `- Provider: \`${c.provider}\``,
          c.cli ? `- Replay: \`rea ${c.cli} <request.json>\`` : '- Replay: no CLI path',
          `- Parity: ${c.parity ? `${c.parity.status} (${c.parity.at})` : 'not checked'}`,
          '',
          'Steps:',
          '',
          ...(stepLines(c).length ? stepLines(c) : ['_No structured steps were captured._']),
          '',
        ])
      : ['_None yet._', '']),
  ].join('\n')
  const featuresFile = path.join(paths.spec, 'features.md')
  write(featuresFile, featureMd)
  written.push(rel(workspace, slug, featuresFile))

  /* ------------------------------------------------------------- contracts */
  for (const c of cases) {
    const contract = {
      schema: 1,
      id: c.id,
      title: c.title,
      kind: c.kind,
      provider: c.provider,
      replay: c.cli ? { command: c.cli, input: c.request } : null,
      steps: c.steps || [],
      expected: c.expected || null,
      evidence: c.evidenceIds || [],
      parity: c.parity || null,
    }
    const file = path.join(paths.spec, 'contracts', `${c.id}.json`)
    write(file, JSON.stringify(contract, null, 2))
    written.push(rel(workspace, slug, file))
  }

  /* --------------------------------------------------------- state machines */
  for (const c of cases) {
    const steps = Array.isArray(c.steps) ? c.steps : []
    if (!steps.length) continue
    const lines = ['stateDiagram-v2', '  [*] --> s0']
    steps.forEach((s, i) => {
      const label = [s.action, s.target].filter(Boolean).join(' ').replace(/["\n]/g, ' ')
      lines.push(`  s${i} --> s${i + 1} : ${label || 'step ' + (i + 1)}`)
    })
    lines.push(`  s${steps.length} --> [*]`)
    const file = path.join(paths.spec, 'state-machines', `${c.id}.mmd`)
    write(file, lines.join('\n'))
    written.push(rel(workspace, slug, file))
  }

  /* ---------------------------------------------------------------- tests */
  for (const c of cases) {
    const contractPath = `../contracts/${c.id}.json`
    const body = `// Generated from case ${c.id}. Replace the replay call with your implementation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const contract = JSON.parse(readFileSync(new URL('${contractPath}', import.meta.url), 'utf8'))

test(${JSON.stringify(c.title + ' — recorded journey')}, { skip: !process.env.CLONE_REPLAY }, async () => {
  // TODO(clone): perform contract.replay.input against your implementation.
  const observed = null // <- your implementation's result

  assert.ok(observed, 'implementation result is missing')
  const expected = contract.expected
  if (expected && Array.isArray(expected.steps)) {
    assert.equal(observed.steps?.length, expected.steps.length, 'step count differs from the recording')
  }
})
`
    const file = path.join(paths.spec, 'tests', `${c.id}.test.mjs`)
    write(file, body)
    written.push(rel(workspace, slug, file))
  }

  /* -------------------------------------------------------------- unknowns */
  const unknowns = (project.unknowns || [])
    .slice()
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1))
  const unknownMd = [
    `# Unknown ledger — ${project.name}`,
    '',
    unknowns.length
      ? table(
          ['ID', 'Question', 'Stage', 'Blocking', 'Status', 'Evidence'],
          unknowns.map((u) => [
            u.id,
            u.question,
            u.stage || 'any',
            u.blocking ? 'yes' : 'no',
            u.status,
            u.evidence || '—',
          ]),
        )
      : '_No unknowns recorded. That is only credible if the stages are actually complete._',
    '',
  ].join('\n')
  const unknownFile = path.join(paths.spec, 'unknowns.md')
  write(unknownFile, unknownMd)
  written.push(rel(workspace, slug, unknownFile))

  /* ---------------------------------------------------------------- reports */
  const parityRows = cases.map((c) => {
    const dims = c.parity?.dims || []
    const get = (name) => dims.find((d) => d.name === name)?.status || 'not checked'
    return [c.id, c.title, c.parity?.status || 'not checked', get('steps'), get('exit code'), get('unknowns')]
  })
  const parityMd = [
    `# Parity — ${project.name}`,
    '',
    'A dimension is `not checked` when the replay or comparison could not produce it.',
    'That is not a pass.',
    '',
    cases.length
      ? table(['Case', 'Title', 'Overall', 'Steps', 'Exit code', 'Unknowns'], parityRows)
      : '_No journeys recorded, so nothing can be compared._',
    '',
  ].join('\n')
  const parityFile = path.join(paths.reports, 'parity.md')
  write(parityFile, parityMd)
  written.push(rel(workspace, slug, parityFile))

  const exposureMd = [
    `# Provenance and exposure — ${project.name}`,
    '',
    'This file is a checklist with what is actually known. It is not a legal opinion.',
    '',
    '## Known',
    '',
    project.target ? `- Analysed artifact: \`${project.target.path}\`` : '- No artifact recorded.',
    project.target?.sha256 ? `- SHA-256: \`${project.target.sha256}\`` : '- Artifact not hashed.',
    `- Recorded journeys: ${cases.length}`,
    `- Evidence records: ${(project.evidence || []).length}`,
    '',
    '## Not yet established',
    '',
    '- License of the original artifact and of every bundled third-party component',
    '- Whether redistribution of assets, strings, or embedded data is permitted',
    '- Whether the clone reproduces trademarks, icons, or trade dress',
    '- Whether any captured secret or personal data is present in the evidence folder',
    '',
    'Run `rea audit-release-exposure <path>` and record the result here before shipping.',
    '',
  ].join('\n')
  const exposureFile = path.join(paths.reports, 'exposure.md')
  write(exposureFile, exposureMd)
  written.push(rel(workspace, slug, exposureFile))

  return { written, counts: { cases: cases.length, unknowns: unknowns.length, stages: board.length } }
}

/* --------------------------------------------------------------- scaffolder */

const LANGUAGES = new Set(['typescript', 'python'])

function packageName(slug) {
  return String(slug).replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'clone'
}

function moduleFor(c) {
  const base = c.kind === 'tool' ? c.provider : c.kind
  return camel(base || 'feature')
}

export function scaffold(workspace, slug, { language = 'typescript' } = {}) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  if (!LANGUAGES.has(language)) throw new Error(`Unsupported language "${language}"`)
  const paths = projectPaths(workspace, slug)
  const cases = caseList(workspace, slug, project)
  const pkg = packageName(slug)
  const written = []

  const modules = new Map()
  for (const c of cases) {
    const name = moduleFor(c)
    if (!modules.has(name)) modules.set(name, [])
    modules.get(name).push(c)
  }
  if (!modules.size) modules.set('feature', [])

  const manifest = {
    schema: 1,
    project: project.name,
    slug: project.slug,
    language,
    target: project.target ? { sha256: project.target.sha256, kind: project.target.kind } : null,
    modules: Array.from(modules.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({
        name,
        cases: list.map((c) => c.id),
        parity: list.map((c) => ({ case: c.id, status: c.parity?.status || 'not checked' })),
      })),
    evidence: (project.evidence || []).map((e) => e.id).sort(),
    openUnknowns: (project.unknowns || []).filter((u) => u.status === 'open').map((u) => u.id).sort(),
  }

  const todo = (c) =>
    `// TODO(${c.id}): reproduce "${c.title}" (${c.kind}); replay request in contracts/${c.id}.json`

  if (language === 'typescript') {
    write(
      path.join(paths.clone, 'package.json'),
      JSON.stringify(
        {
          name: pkg,
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: { build: 'tsc -p .', test: 'node --test' },
          devDependencies: { typescript: '^5.6.0', '@types/node': '^22.0.0' },
        },
        null,
        2,
      ),
    )
    write(
      path.join(paths.clone, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            outDir: 'dist',
            rootDir: 'src',
            declaration: true,
            skipLibCheck: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    )
    write(
      path.join(paths.clone, 'src', 'index.ts'),
      [
        '// Generated skeleton. Fill the stubs; parity tells you when you are done.',
        `export const project = ${JSON.stringify({ name: project.name, slug: project.slug })} as const`,
        '',
        ...Array.from(modules.keys())
          .sort()
          .map((m) => `export * from './features/${m}.js'`),
        '',
      ].join('\n'),
    )
    for (const [name, list] of Array.from(modules.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      write(
        path.join(paths.clone, 'src', 'features', `${name}.ts`),
        [
          '// Generated skeleton for one observed feature area.',
          ...list.flatMap((c) => [
            '',
            todo(c),
            `export function ${camel(c.title || name)}(): unknown {`,
            '  throw new Error("not implemented")',
            '}',
          ]),
          '',
        ].join('\n'),
      )
    }
    for (const c of cases) {
      write(
        path.join(paths.clone, 'test', `${c.id}.test.mjs`),
        [
          `// Parity test generated from case ${c.id}.`,
          "import test from 'node:test'",
          "import assert from 'node:assert/strict'",
          "import { readFileSync } from 'node:fs'",
          '',
          `const contract = JSON.parse(readFileSync(new URL('../contracts/${c.id}.json', import.meta.url), 'utf8'))`,
          '',
          `test(${JSON.stringify(c.title)}, { skip: !process.env.CLONE_REPLAY }, () => {`,
          '  // TODO: call your implementation and compare with contract.expected',
          '  assert.ok(contract.id)',
          '})',
          '',
        ].join('\n'),
      )
    }
  } else {
    write(
      path.join(paths.clone, 'pyproject.toml'),
      [
        '[project]',
        `name = "${pkg}"`,
        'version = "0.0.0"',
        'requires-python = ">=3.11"',
        '',
        '[tool.pytest.ini_options]',
        'testpaths = ["tests"]',
        '',
      ].join('\n'),
    )
    const mod = pkg.replace(/-/g, '_')
    write(path.join(paths.clone, 'src', mod, '__init__.py'), `"""Generated skeleton for ${project.name}."""\n`)
    for (const [name, list] of Array.from(modules.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      write(
        path.join(paths.clone, 'src', mod, `${name.replace(/([A-Z])/g, '_$1').toLowerCase()}.py`),
        [
          '"""Generated skeleton for one observed feature area."""',
          '',
          ...list.flatMap((c) => [
            '',
            `# TODO(${c.id}): reproduce ${JSON.stringify(c.title)} (${c.kind})`,
            `def ${name.replace(/([A-Z])/g, '_$1').toLowerCase()}():`,
            '    raise NotImplementedError',
          ]),
          '',
        ].join('\n'),
      )
    }
    for (const c of cases) {
      write(
        path.join(paths.clone, 'tests', `test_${c.id}.py`),
        [
          'import json',
          'import pathlib',
          'import pytest',
          '',
          `CONTRACT = pathlib.Path(__file__).parent.parent / "contracts" / "${c.id}.json"`,
          '',
          '@pytest.mark.skipif(not __import__("os").environ.get("CLONE_REPLAY"), reason="set CLONE_REPLAY=1")',
          `def test_${c.id}():`,
          `    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))`,
          '    assert contract["id"]',
          '    # TODO: call your implementation and compare with contract["expected"]',
          '',
        ].join('\n'),
      )
    }
  }

  for (const c of cases) {
    write(path.join(paths.clone, 'contracts', `${c.id}.json`), JSON.stringify({
      id: c.id,
      title: c.title,
      kind: c.kind,
      replay: c.cli ? { command: c.cli, input: c.request } : null,
      expected: c.expected || null,
      steps: c.steps || [],
    }, null, 2))
  }

  write(path.join(paths.clone, 'parity.json'), JSON.stringify(manifest, null, 2))
  write(
    path.join(paths.clone, 'README.md'),
    [
      `# ${project.name} — clone skeleton`,
      '',
      'Generated by REA Studio. This is a skeleton, not a working clone: every module',
      'throws until it is implemented.',
      '',
      '## Contract',
      '',
      `- Modules: ${manifest.modules.length}`,
      `- Recorded journeys: ${cases.length}`,
      `- Open unknowns: ${manifest.openUnknowns.length}`,
      '',
      '## Run',
      '',
      language === 'typescript'
        ? ['```', 'npm install', 'npm run build', 'CLONE_REPLAY=1 npm test', '```'].join('\n')
        : ['```', 'pip install -e .', 'CLONE_REPLAY=1 pytest', '```'].join('\n'),
      '',
      'Tests are skipped unless `CLONE_REPLAY` is set, so a fresh skeleton never reports a false pass.',
      '',
    ].join('\n'),
  )

  const collect = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) collect(full)
      else written.push(rel(workspace, slug, full))
    }
  }
  collect(paths.clone)

  return { language, written: Array.from(new Set(written)).sort(), manifest }
}

/* --------------------------------------------------------------- artifacts */

export function listArtifacts(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  const out = []
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, prefix ? `${prefix}/${entry.name}` : entry.name)
      else {
        const stat = fs.statSync(full)
        out.push({ area: prefix.split('/')[0] || prefix, path: rel(workspace, slug, full), bytes: stat.size })
      }
    }
  }
  walk(paths.spec, 'spec')
  walk(paths.reports, 'reports')
  walk(paths.clone, 'clone')
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}
