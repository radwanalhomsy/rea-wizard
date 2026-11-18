/* REA Studio renderer — vanilla JS, no build step. */

const api = window.rea
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

/* ------------------------------------------------------------------ cards */

const QUICK_TASKS = [
  {
    id: 'triage', icon: '◈', title: 'Triage a binary',
    sub: 'What is this file, what does it import, what does it do?',
    fields: [{ key: 'target', label: 'Target file', type: 'file', required: true, hint: 'Absolute path. PE, ELF, Mach-O, APK, archive…' }],
    prompt: (v) => `Use REA on "${v.target}". Start with binary_overview (or the appropriate format inspector) and give me: ` +
      `file type and architecture, compiler, imports, packing/entropy hints, and the functions with the most callers. ` +
      `Then decompile the entry point and summarize what the program does. Cite evidence IDs.`,
  },
  {
    id: 'decompile', icon: 'ƒ', title: 'Explain a function',
    sub: 'Decompile one procedure, its callers and callees',
    fields: [
      { key: 'target', label: 'Target file', type: 'file', required: true },
      { key: 'fn', label: 'Function name or address', type: 'text', required: true, placeholder: 'entry  ·  main  ·  0x1400012a0' },
    ],
    prompt: (v) => `Use REA on "${v.target}". Find the procedure "${v.fn}" and decompile it. Explain its purpose, arguments and key branches. ` +
      `Then show its callers and callees and explain how they connect. Cite evidence IDs.`,
  },
  {
    id: 'behavior', icon: '⇄', title: 'Find a behavior',
    sub: 'Locate the code behind a capability',
    fields: [
      { key: 'target', label: 'Target file', type: 'file', required: true },
      { key: 'behavior', label: 'Behavior to find', type: 'text', required: true, placeholder: 'writes to HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
    ],
    prompt: (v) => `Use REA on "${v.target}". Find every code path that implements: ${v.behavior}. ` +
      `Show the relevant functions, the strings and APIs involved, and how they connect. Cite evidence IDs.`,
  },
  {
    id: 'compare', icon: '≒', title: 'Compare two builds',
    sub: 'Which functions changed between versions?',
    fields: [
      { key: 'a', label: 'Old build', type: 'file', required: true },
      { key: 'b', label: 'New build', type: 'file', required: true },
    ],
    prompt: (v) => `Compare "${v.a}" and "${v.b}" with REA. List the functions that changed and explain the security-relevant differences. ` +
      `Cite evidence IDs for both builds.`,
  },
  {
    id: 'dotnet', icon: '#', title: 'Inspect a .NET assembly',
    sub: 'Types, methods, P/Invoke boundaries, app graph',
    fields: [{ key: 'target', label: 'Managed assembly', type: 'file', required: true, hint: '.dll or .exe built for the CLR' }],
    prompt: (v) => `Inspect "${v.target}" as a managed .NET assembly: list the types and methods, identify the interesting logic ` +
      `(crypto, string decoding, networking, licensing), and show the relevant members and P/Invoke boundaries. Cite evidence IDs.`,
  },
  {
    id: 'apk', icon: '▣', title: 'Inspect an Android APK',
    sub: 'Components, permissions, network code',
    fields: [{ key: 'target', label: 'APK / AAB / IPA', type: 'file', required: true }],
    prompt: (v) => `Open "${v.target}" with REA: list the manifest components, dangerous permissions, and the code that builds network URLs ` +
      `or contacts remote hosts. Cite evidence IDs.`,
  },
  {
    id: 'js', icon: '{}', title: 'Analyze JS / Electron',
    sub: 'Map features in an ASAR bundle or JS tree',
    fields: [
      { key: 'target', label: 'ASAR, bundle or folder', type: 'any', required: true },
      { key: 'feature', label: 'Feature to locate', type: 'text', placeholder: 'license check · auto-update · checkout' },
    ],
    prompt: (v) => `Analyze the JavaScript application at "${v.target}": map its features` +
      (v.feature ? `, locate "${v.feature}", and show where it is called` : '') +
      `. If a source tree is available, compare_source_to_bundle. Cite evidence IDs.`,
  },
  {
    id: 'web', icon: '◐', title: 'Inspect a web page',
    sub: 'Live page traffic, API surface, click flows',
    fields: [{ key: 'target', label: 'Page URL or capture file', type: 'text', required: true, placeholder: 'https://app.example.com' }],
    prompt: (v) => `Inspect "${v.target}" with REA: capture the page or capture file, list the API endpoints and their request shapes, ` +
      `and point out which bundle code calls them. Cite evidence IDs.`,
  },
  {
    id: 'evidence', icon: '⛁', title: 'Export evidence',
    sub: 'Write the investigation to a portable bundle',
    fields: [{ key: 'out', label: 'Output file', type: 'text', required: true, hint: 'Absolute path for the exported bundle' }],
    prompt: (v) => `Export the current investigation's evidence bundle to "${v.out}". Then summarize what the bundle contains and ` +
      `list the unknowns that remain open.`,
  },
  {
    id: 'custom', icon: '✎', title: 'Custom request',
    sub: 'Write your own REA prompt',
    noClauses: true,
    fields: [{ key: 'text', label: 'Request', type: 'area', required: true, placeholder: 'Use REA on D:\\samples\\app.exe and …' }],
    prompt: (v) => v.text,
  },
]

const DOMAIN_TASKS = [
  {
    id: 'firmware', icon: '▤', title: 'Firmware image',
    sub: 'Regions, extraction, bootloader, embedded keys',
    fields: [
      { key: 'target', label: 'Firmware file', type: 'file', required: true },
      { key: 'goal', label: 'Focus', type: 'text', placeholder: 'bootloader · filesystem · keys · update logic' },
    ],
    prompt: (v) => `Use REA on the firmware image "${v.target}". Work in this order: inspect_firmware_regions to map signature candidates, ` +
      `extract_firmware into a new folder under the workspace, then inspect what was extracted (filesystem, bootloader, kernel, config, embedded keys and certificates).` +
      (v.goal ? ` Focus on: ${v.goal}.` : '') + ` Cite evidence IDs and list what could not be recovered.`,
  },
  {
    id: 'apple', icon: '', title: 'Apple binary / IPA',
    sub: 'Mach-O, entitlements, plists, Swift symbols',
    fields: [
      { key: 'target', label: 'Mach-O, .app, IPA or dSYM', type: 'file', required: true },
      { key: 'goal', label: 'Focus', type: 'text', placeholder: 'signing · entitlements · Swift dispatch · networking' },
    ],
    prompt: (v) => `Use REA on "${v.target}" as an Apple artifact. Run inspect_macho, inspect_signature and, when present, inspect_plist; ` +
      `use inspect_native_dispatch_metadata for Objective-C/Swift dispatch and demangle_swift for Swift symbols. ` +
      `Report architectures, signing/entitlements, linked frameworks and the code behind the requested focus` +
      (v.goal ? ` (${v.goal})` : '') + `. Cite evidence IDs.`,
  },
  {
    id: 'adb', icon: '▷', title: 'Android device (adb)',
    sub: 'Device facts, packages, screen, logcat',
    fields: [
      { key: 'serial', label: 'Device serial', type: 'text', required: true, placeholder: 'emulator-5554  ·  R58M12345A' },
      { key: 'action', label: 'Action', type: 'select', options: ['Device facts', 'List packages', 'Capture screen', 'Read logcat', 'Pull package APKs', 'Start app'] },
      { key: 'pkg', label: 'Package (optional)', type: 'text', placeholder: 'com.example.app' },
    ],
    prompt: (v) => {
      const pkg = v.pkg ? ` Target package: ${v.pkg}.` : ''
      const actions = {
        'Device facts': 'Run list-adb-devices, inspect-adb-device, inspect-adb-display, list-adb-features and list-adb-services, then summarize the device identity and capabilities.',
        'List packages': 'Run list-adb-packages and resolve-adb-packages for the query, then report third-party packages and their base APK paths.' + pkg,
        'Capture screen': 'Run inspect-adb-window and capture-adb-screen, then describe what is on screen and which package owns the focused window.' + pkg,
        'Read logcat': 'Run read-adb-logcat and summarize crashes, permission denials and network activity.' + pkg,
        'Pull package APKs': 'Run pull-adb-package for the package, then inspect the pulled APKs with inspect-android-package and inspect-apk-signature.' + pkg,
        'Start app': 'Run start-adb-app for the package, then inspect-adb-window and capture-adb-screen to confirm it launched.' + pkg,
      }
      return `Use REA against the attached Android device with serial "${v.serial}". Start with list-adb-devices to confirm the transport. ` +
        (actions[v.action] || actions['Device facts']) + ' Cite evidence IDs.'
    },
  },
  {
    id: 'debugger', icon: '⌁', title: 'Live debugging',
    sub: 'GDB, Rizin, Frida or Cutter sessions',
    fields: [
      { key: 'target', label: 'Target file or process', type: 'text', required: true, placeholder: 'D:\\samples\\app.exe  ·  process name' },
      { key: 'mode', label: 'Engine', type: 'select', options: ['GDB', 'Rizin', 'Frida', 'Cutter'] },
      { key: 'command', label: 'Command or breakpoint', type: 'text', placeholder: 'break main · continue · info registers' },
      { key: 'script', label: 'Frida script (optional)', type: 'file' },
    ],
    prompt: (v) => {
      const cmd = v.command ? ` Run: ${v.command}.` : ''
      const script = v.script ? ` Use the script file "${v.script}".` : ''
      if (v.mode === 'Rizin') return `Use REA on "${v.target}" with a persistent Rizin debugger session (start_rizin_debug_session).${cmd} ` +
        `Use execute-rizin-command for follow-up commands, explain registers/stack/control flow, and detach cleanly. Cite evidence IDs.`
      if (v.mode === 'Frida') return `Use REA to instrument "${v.target}" with Frida: list-frida-devices and list-frida-processes first, then instrument-with-frida.${script}${cmd} ` +
        `Summarize observed calls, arguments and return values, and detach. Cite evidence IDs.`
      if (v.mode === 'Cutter') return `Use REA against the running Cutter instance: list-cutter-sessions, then cutter-command for "${v.target}".${cmd} ` +
        `Explain the result and keep the session consistent. Cite evidence IDs.`
      return `Use REA on "${v.target}" with a persistent GDB session (start_gdb_session).${cmd} ` +
        `Use debug-with-gdb for follow-up commands, explain registers, stack and control flow, and detach cleanly. Cite evidence IDs.`
    },
  },
  {
    id: 'capture', icon: '◉', title: 'Capture behavior',
    sub: 'Bounded process, browser, Electron or desktop run',
    fields: [
      { key: 'target', label: 'Executable, URL or capture', type: 'text', required: true, placeholder: 'D:\\samples\\app.exe  ·  https://app.example.com' },
      { key: 'kind', label: 'Kind', type: 'select', options: ['Process', 'Browser', 'Electron', 'Desktop application', 'Native UI'] },
      { key: 'question', label: 'Behavior question', type: 'text', required: true, placeholder: 'what does it write to disk on first launch?' },
    ],
    prompt: (v) => {
      const k = v.kind
      if (k === 'Browser') return `Use REA to run one bounded browser scenario against "${v.target}" while answering: ${v.question}. ` +
        `Use capture-browser-scenario (validate-browser-scenario first if the scenario is complex), then inspect-web-network-capture and capture-web-screenshot. Cite evidence IDs.`
      if (k === 'Electron') return `Use REA to run one owned Electron scenario against "${v.target}" while answering: ${v.question}. ` +
        `Use capture-electron-scenario, inspect-electron-fuses and inspect-electron-page. Cite evidence IDs.`
      if (k === 'Desktop application') return `Use REA to capture the desktop application "${v.target}" while answering: ${v.question}. ` +
        `Use capture-desktop-application, then inspect-desktop-application-state and describe-desktop-application-task. Cite evidence IDs.`
      if (k === 'Native UI') return `Use REA to run a declarative native UI scenario on "${v.target}" while answering: ${v.question}. ` +
        `Use capture-native-ui-scenario and observe-native-calls. Cite evidence IDs.`
      return `Use REA to capture the behavior of "${v.target}" while answering: ${v.question}. ` +
        `Start from prepare_bounded_process_capture, run capture-process with a bounded scenario, then inspect the captured files, registry and network effects. Cite evidence IDs.`
    },
  },
  {
    id: 'agentenv', icon: '▦', title: 'Build an AgentEnv',
    sub: 'Turn a live app or capture into a runnable environment',
    fields: [
      { key: 'mode', label: 'Mode', type: 'select', options: ['Build bundle', 'Serve bundle', 'Compare manifests', 'Export desktop app'] },
      { key: 'source', label: 'URL, HAR, capture or manifest', type: 'text', required: true, placeholder: 'https://app.example.com  ·  D:\\captures\\app.har  ·  agentenv\\manifest.json' },
      { key: 'task', label: 'Agent task', type: 'text', required: true, placeholder: 'reproduce the checkout flow offline' },
      { key: 'outDir', label: 'Output folder', type: 'text', required: true },
    ],
    defaults: { outDir: 'agentenv' },
    prompt: (v) => {
      if (v.mode === 'Serve bundle') return `Serve the AgentEnv bundle from "${v.source}" with environment-serve, then report the local endpoint, ` +
        `which tools answer from captured state, which replay, and which writes are withheld. Task context: ${v.task}. Cite evidence IDs.`
      if (v.mode === 'Compare manifests') return `Compare the AgentEnv manifest "${v.source}" against the live behavior for this task: ${v.task}. ` +
        `Run environment-compare and report every divergence between captured and live responses, ranked by impact. Cite evidence IDs.`
      if (v.mode === 'Export desktop app') return `Export the desktop application capture "${v.source}" with export-desktop-application into "${v.outDir}". ` +
        `Then use inspect-desktop-application-state and describe-desktop-application-task to summarize what the exported environment can reproduce. Task: ${v.task}. Cite evidence IDs.`
      return `Build an AgentEnv bundle from "${v.source}" for this task: ${v.task}. ` +
        `Use analyze-web-bundle for a live origin or environment-build for a HAR/capture, then environment-export into "${v.outDir}". ` +
        `Report the manifest, which tools are answered from captured state, which replay, and which writes are withheld. Cite evidence IDs.`
    },
  },
  {
    id: 'decompile-all', icon: '⛏', title: 'Decompile everything',
    sub: 'Write every function to a directory',
    fields: [
      { key: 'target', label: 'Target file', type: 'file', required: true },
      { key: 'outDir', label: 'Output folder', type: 'text', required: true },
    ],
    defaults: { outDir: 'decompiled' },
    prompt: (v) => `Use REA on "${v.target}" and run decompile-all into "${v.outDir}". Then summarize the function inventory: ` +
      `count by module, largest and most-called functions, and the interesting clusters (crypto, network, parsing, persistence). Cite evidence IDs.`,
  },
  {
    id: 'extract', icon: '⇩', title: 'Extract an artifact',
    sub: 'Safe extraction with provenance',
    fields: [
      { key: 'target', label: 'Archive, installer or image', type: 'file', required: true },
      { key: 'outDir', label: 'Output folder', type: 'text', required: true },
    ],
    defaults: { outDir: 'extracted' },
    prompt: (v) => `Use REA to extract the artifact "${v.target}" into "${v.outDir}" with extract-artifact. ` +
      `Report every extracted file with size and provenance, flag executables and scripts, and identify the interesting components to analyze next. Cite evidence IDs.`,
  },
  {
    id: 'audit', icon: '⚑', title: 'Audit release exposure',
    sub: 'What a shipped artifact leaks',
    fields: [{ key: 'target', label: 'Shipped artifact', type: 'file', required: true, hint: 'Also checks sibling .pdb, .dSYM, .debug and .map files' }],
    prompt: (v) => `Run audit-release-exposure on "${v.target}". Report what static analysis recovers: symbols, debug companions, source maps, ` +
      `strings, embedded URLs and credentials-adjacent material. Rank the exposure and recommend concrete hardening steps. Cite evidence IDs.`,
  },
  {
    id: 'network', icon: '≋', title: 'Network capture',
    sub: 'Flows, endpoints, protocols and secrets in a pcap',
    fields: [
      { key: 'target', label: 'Capture file', type: 'file', required: true, hint: '.pcap, .pcapng or a capture produced by REA' },
      { key: 'goal', label: 'Focus', type: 'text', placeholder: 'C2 beaconing · credentials · TLS SNI · update check' },
    ],
    prompt: (v) => `Use REA on the packet capture "${v.target}". Run inspect_packet_capture and inspect_pcap_capture, then inspect_packet_fields ` +
      `on the most interesting conversations. Summarize hosts, ports, protocols, request/response shapes, cleartext credentials or tokens, and any ` +
      `beaconing or update traffic.` + (v.goal ? ` Focus on: ${v.goal}.` : '') +
      ` Point out which recovered strings or endpoints should be traced back into the code. Cite evidence IDs.`,
  },
  {
    id: 'diff', icon: '⇋', title: 'Compare captures or artifacts',
    sub: 'What changed between two runs or two builds',
    fields: [
      { key: 'a', label: 'Left artifact or capture', type: 'file', required: true },
      { key: 'b', label: 'Right artifact or capture', type: 'file', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: ['Artifacts', 'Process captures', 'Web captures', 'Bundles'] },
      { key: 'goal', label: 'Focus', type: 'text', placeholder: 'new endpoints · permission changes · added persistence' },
    ],
    prompt: (v) => {
      const tool = { Artifacts: 'compare_artifacts', 'Process captures': 'compare_process_captures', 'Web captures': 'compare_web_captures', Bundles: 'compare_bundles' }[v.kind] || 'compare_artifacts'
      return `Use REA to compare "${v.a}" and "${v.b}" with ${tool}, then run find_changed_behavior to explain what changed. ` +
        `Group the differences into added, removed and modified behavior, and rank them by security impact.` +
        (v.goal ? ` Focus on: ${v.goal}.` : '') + ` Cite evidence IDs for both sides.`
    },
  },
  {
    id: 'reconstruct', icon: '⚖', title: 'Reconstruction ledger',
    sub: 'Track obligations, coverage and residual unknowns',
    fields: [
      { key: 'target', label: 'Target artifact', type: 'file', required: true },
      { key: 'out', label: 'Ledger output file', type: 'text', required: true, hint: 'Absolute path for the generated ledger page' },
    ],
    defaults: { out: 'reconstruction-ledger.md' },
    prompt: (v) => `Use REA on "${v.target}" to build a reconstruction obligation ledger: run build_reconstruction_obligation_ledger and write the result to "${v.out}", ` +
      `then evaluate_reconstruction_coverage. List every unknown with list_unknowns, record or update the ones this pass resolves, and state exactly what ` +
      `remains unverified. Do not claim coverage that the evidence does not support. Cite evidence IDs.`,
  },
  {
    id: 'annotate', icon: '✍', title: 'Annotate & map addresses',
    sub: 'Rename, comment, bookmark and convert addresses',
    fields: [
      { key: 'target', label: 'Target file', type: 'file', required: true },
      { key: 'address', label: 'Address or procedure', type: 'text', required: true, placeholder: '0x1400012a0  ·  sub_1400012A0  ·  entry' },
      { key: 'name', label: 'New name', type: 'text', placeholder: 'decrypt_config' },
      { key: 'note', label: 'Comment', type: 'area', placeholder: 'What this code does, and why it matters' },
    ],
    prompt: (v) => `Use REA on "${v.target}" at "${v.address}". First run address_name, inspect_address_context and address_to_file_offset so the mapping is explicit. ` +
      (v.name ? `Rename it to "${v.name}" with annotate_native_function or set_address_name. ` : '') +
      (v.note ? `Add the comment: ${v.note}. ` : '') +
      `Set a bookmark for the location, then return the refreshed annotation state and the address-to-file-offset mapping. Cite evidence IDs.`,
  },
  {
    id: 'jeb', icon: '◫', title: 'JEB decompile',
    sub: 'Open a JEB project and decompile a unit',
    fields: [
      { key: 'target', label: 'APK, DEX, JAR or JEB project', type: 'file', required: true },
      { key: 'item', label: 'Class, method or field', type: 'text', required: true, placeholder: 'com.example.app.LoginManager  ·  Lcom/example/Login;->check' },
      { key: 'kind', label: 'Unit kind', type: 'select', options: ['Class', 'Method', 'Field'] },
    ],
    prompt: (v) => `Use REA with JEB on "${v.target}". Run inspect_jeb_client, open_jeb_project and list_jeb_units to locate "${v.item}", ` +
      `then decompile_jeb_item for the ${v.kind.toLowerCase()}. Explain the decompiled logic, its callers and the data it handles. Cite evidence IDs.`,
  },
]

const WORKFLOW_META = {
  investigate_feature: { icon: '◎', title: 'Investigate a feature' },
  compare_application_versions: { icon: '≒', title: 'Compare app versions' },
  verify_reconstruction: { icon: '✓', title: 'Verify a reconstruction' },
  trace_crash: { icon: '⚡', title: 'Trace a crash' },
  audit_residual_unknowns: { icon: '?', title: 'Audit unknown residuals' },
  prepare_bounded_process_capture: { icon: '◉', title: 'Prepare a process capture' },
}

/* ------------------------------------------------------------------ state */

const state = {
  workspace: 'D:\\REA',
  sessionID: null,
  sessionTitle: null,
  model: null,
  agent: null,
  modelLabel: '',
  messages: new Map(), // messageID -> { info, parts: Map }
  order: [],
  permissions: new Map(),
  evidence: new Map(),
  activity: new Map(),
  targets: new Map(),
  openTools: new Set(),
  running: false,
  card: null,
  step: 1,
  dirty: new Set(),
  raf: 0,
  nearBottom: true,
  workflows: [],
  workflowCards: [],
  caps: null,
  commands: [],
  catalog: null,
  tool: null,
  reaVersion: null,
  sessions: [],
  editingSession: null,
  confirmDelete: null,
  attachments: [],
  renderToken: 0,
  rendering: false,
}

/* ---------------------------------------------------------------- helpers */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toast(msg, ms = 2600) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.hidden = true }, ms)
}

function timeLabel(ts) {
  if (!ts) return ''
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

function shortPath(p, keep = 42) {
  if (!p) return ''
  return p.length > keep ? '…' + p.slice(-keep) : p
}

function baseName(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function humanize(s) {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/* -------------------------------------------------------- markdown (lite) */

const EVIDENCE_RE = /\bev_[a-f0-9]{64}\b/gi

function md(src) {
  const fences = []
  let s = String(src ?? '')

  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
    fences.push('<pre><code>' + escapeHtml(code.replace(/\r?\n$/, '')) + '</code></pre>')
    return '\u0000F' + (fences.length - 1) + '\u0000'
  })
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
    fences.push('<pre><code>' + escapeHtml(code.replace(/\r?\n$/, '')) + '</code></pre>')
    return '\u0000F' + (fences.length - 1) + '\u0000'
  })

  s = escapeHtml(s)

  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  s = s.replace(EVIDENCE_RE, (m) => `<span class="ev" data-ev="${m}">${m}</span>`)

  const lines = s.split(/\r?\n/)
  const out = []
  let para = []
  let list = null

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = [] }
  }
  const flushList = () => {
    if (list) { out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + i + '</li>').join('') + '</' + list.tag + '>'); list = null }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\u0000F(\d+)\u0000$/)

    if (fence) { flushPara(); flushList(); out.push(fences[Number(fence[1])]); continue }

    if (!line.trim()) { flushPara(); flushList(); continue }

    if (/^\|/.test(line) && /^\|[\s:|-]+\|?$/.test(lines[i + 1] || '')) {
      flushPara(); flushList()
      const head = line.split('|').slice(1, -1).map((c) => c.trim())
      const rows = []
      i += 2
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()))
        i++
      }
      i--
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>')
      continue
    }

    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) { flushPara(); flushList(); out.push('<h3>' + h[1] + '</h3>'); continue }

    const hr = line.match(/^---+$/)
    if (hr) { flushPara(); flushList(); out.push('<hr />'); continue }

    const bq = line.match(/^&gt;\s?(.*)$/)
    if (bq) { flushPara(); flushList(); out.push('<blockquote>' + bq[1] + '</blockquote>'); continue }

    const ul = line.match(/^[-*]\s+(.*)$/)
    if (ul) {
      flushPara()
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] } }
      list.items.push(ul[1]); continue
    }

    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (ol) {
      flushPara()
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] } }
      list.items.push(ol[1]); continue
    }

    flushList()
    para.push(line.trim())
  }

  flushPara()
  flushList()
  return out.join('')
}

/* --------------------------------------------------------------- evidence */

function collectEvidence(text, source) {
  if (!text) return
  const found = String(text).match(EVIDENCE_RE)
  if (!found) return
  let changed = false
  for (const id of found) {
    if (!state.evidence.has(id)) { state.evidence.set(id, { source, time: Date.now() }); changed = true }
  }
  if (changed) renderEvidence()
  try { window.cloneRecordEvidence?.(Array.from(new Set(found)), source, text) } catch { }
}

function renderEvidence() {
  const list = $('#evidenceList')
  const items = Array.from(state.evidence.entries())
  $('#evidenceEmpty').hidden = items.length > 0
  $('#evidenceCount').textContent = items.length + (items.length === 1 ? ' record' : ' records')
  list.innerHTML = items.map(([id, meta]) =>
    `<div class="ev-item" data-ev="${id}" title="Click to copy">${id}<span class="ev-src">${escapeHtml(meta.source || 'assistant')} · ${timeLabel(meta.time)}</span></div>`
  ).join('')
}

/* --------------------------------------------------------------- activity */

function touchActivity(part) {
  const st = part.state || {}
  const key = part.callID || part.id
  const prev = state.activity.get(key) || { name: part.tool, title: '', status: 'pending', start: Date.now(), end: null }
  prev.name = part.tool || prev.name
  prev.title = st.title || prev.title
  prev.status = st.status || prev.status
  if (prev.status === 'running' && !prev.start) prev.start = Date.now()
  if (prev.status === 'completed' || prev.status === 'error') prev.end = Date.now()
  state.activity.set(key, prev)
  renderActivity()
}

function renderActivity() {
  const list = $('#activityList')
  const items = Array.from(state.activity.values())
  $('#activityEmpty').hidden = items.length > 0
  list.innerHTML = items.slice(-80).map((a) => {
    const dur = a.end && a.start ? Math.max(0, a.end - a.start) : null
    const label = dur == null ? (a.status === 'running' ? 'running' : '') : (dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's')
    return `<div class="act ${a.status}"><span class="act-dot"></span><span class="act-name">${escapeHtml(a.name)}</span>` +
      `<span class="act-time">${label}</span></div>`
  }).join('')
}

/* ---------------------------------------------------------------- targets */

const TARGET_KEYS = ['path', 'target_path', 'targetPath', 'binary_path', 'executable', 'apk_path', 'source', 'file', 'document', 'image_path', 'capture']

function looksLikePath(v) {
  return typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || (v.startsWith('/') && !v.startsWith('//')))
}

function trackTarget(part) {
  const name = String(part.tool || '')
  const st = part.state || {}
  const input = st.input
  if (!input || typeof input !== 'object') return
  const closing = st.status === 'completed' && /close|cleanup|release|detach/i.test(name)
  const refs = TARGET_KEYS.map((k) => input[k]).filter((v) => typeof v === 'string' && v)
  let changed = false

  if (closing) {
    let removed = false
    for (const [p] of state.targets) {
      if (refs.some((v) => v === p || baseName(v) === baseName(p))) {
        state.targets.delete(p)
        removed = true
        changed = true
      }
    }
    if (!removed && /close.?all|cleanup/i.test(name) && state.targets.size) {
      state.targets.clear()
      changed = true
    }
  } else {
    for (const v of refs) {
      if (looksLikePath(v) && !state.targets.has(v)) {
        state.targets.set(v, { tool: part.tool || 'rea', time: Date.now() })
        changed = true
      }
    }
  }
  if (changed) renderTargets()
}

function renderTargets() {
  const box = $('#targetsBox')
  const items = Array.from(state.targets.entries())
  const pending = state.caps?.cleanup_pending
  let html = ''
  if (pending) html += '<div class="rail-note err">REA reports cleanup_pending — close targets before exiting.</div>'
  if (!items.length) {
    html += '<div class="panel-empty" id="targetsEmpty">No targets opened in this session yet.</div>'
  } else {
    html += items.map(([p, meta]) =>
      `<div class="target-item" data-path="${escapeHtml(p)}" title="${escapeHtml(p)} — click to copy">` +
      `<span class="target-main"><span class="target-name">${escapeHtml(baseName(p))}</span>` +
      `<span class="target-path">${escapeHtml(shortPath(p, 46))}</span></span>` +
      `<button class="target-x" data-close="${escapeHtml(p)}" title="Ask the agent to close this target">✕</button></div>`
    ).join('')
  }
  box.innerHTML = html
}

/* ------------------------------------------------------------- transcript */

function ensureMessage(id) {
  if (!state.messages.has(id)) {
    state.messages.set(id, { info: null, parts: new Map() })
    state.order.push(id)
  }
  return state.messages.get(id)
}

function scheduleRender(id) {
  state.dirty.add(id)
  if (state.raf) return
  state.raf = requestAnimationFrame(() => {
    state.raf = 0
    const ids = Array.from(state.dirty)
    state.dirty.clear()
    for (const mid of ids) renderMessage(mid)
    updateEmpty()
    if (state.nearBottom) scrollToBottom()
  })
}

function scrollToBottom() {
  const t = $('#transcript')
  t.scrollTop = t.scrollHeight
}

function updateEmpty() {
  const has = state.order.length > 0 || state.permissions.size > 0
  $('#emptyState').hidden = has
}

function renderMessage(mid) {
  const msg = state.messages.get(mid)
  if (!msg) return
  const role = msg.info?.role || 'assistant'
  const list = $('#msgList')
  let el = list.querySelector(`[data-mid="${CSS.escape(mid)}"]`)
  if (!el) {
    el = document.createElement('div')
    el.className = 'msg msg-' + role
    el.dataset.mid = mid
    list.appendChild(el)
  }
  el.className = 'msg msg-' + role

  const created = msg.info?.time?.created
  const head = `<div class="msg-head"><span class="msg-role">${role === 'user' ? 'You' : 'Agent'}</span>` +
    (created ? `<span class="msg-time">${timeLabel(created)}</span>` : '') + `</div>`

  let body = ''
  for (const part of msg.parts.values()) {
    if (part.type === 'text') {
      if (part.synthetic || part.ignored) continue
      body += md(part.text)
      collectEvidence(part.text, 'assistant')
    } else if (part.type === 'reasoning') {
      body += `<details class="reasoning"><summary>Reasoning</summary>${md(part.text || '')}</details>`
    } else if (part.type === 'tool') {
      body += renderTool(part)
    } else if (part.type === 'file') {
      body += `<div class="tool"><div class="tool-head"><span class="tool-name">file</span><span class="tool-title">${escapeHtml(part.filename || part.url || '')}</span></div></div>`
    } else if (part.type === 'retry') {
      body += `<div class="err-banner">Retrying: ${escapeHtml(part.error?.message || 'provider error')}</div>`
    }
  }

  if (!body.trim()) body = '<p class="msg-time">…</p>'
  el.innerHTML = head + `<div class="msg-body">${body}</div>`

  el.querySelectorAll('.ev').forEach((n) => {
    n.title = 'Click to copy this evidence ID'
    n.addEventListener('click', () => copyText(n.dataset.ev))
  })
  el.querySelectorAll('.tool-head').forEach((n) => {
    n.addEventListener('click', () => {
      const card = n.parentElement
      card.classList.toggle('open')
      const pid = card.dataset.pid
      if (card.classList.contains('open')) state.openTools.add(pid)
      else state.openTools.delete(pid)
    })
  })
}

function renderTool(part) {
  const st = part.state || {}
  const status = st.status || 'pending'
  const title = st.title || (st.input ? Object.values(st.input).filter((v) => typeof v === 'string')[0] : '') || ''
  const open = state.openTools.has(part.id)

  let bodyHtml = ''
  if (st.input && Object.keys(st.input).length) {
    bodyHtml += `<div class="tool-label">input</div><pre>${escapeHtml(JSON.stringify(st.input, null, 2))}</pre>`
  }
  if (status === 'completed' && st.output) {
    bodyHtml += `<div class="tool-label">output</div><pre>${escapeHtml(st.output)}</pre>`
    collectEvidence(st.output, part.tool)
  }
  if (status === 'error') {
    bodyHtml += `<div class="tool-label">error</div><pre>${escapeHtml(st.error || '')}</pre>`
  }

  return `<div class="tool ${open ? 'open' : ''}" data-pid="${escapeHtml(part.id)}">` +
    `<div class="tool-head">` +
    (status === 'running' ? '<span class="tool-spin"></span>' : '') +
    `<span class="tool-name">${escapeHtml(part.tool)}</span>` +
    `<span class="tool-title">${escapeHtml(title)}</span>` +
    `<span class="tool-state ${status}">${status}</span>` +
    `</div><div class="tool-body">${bodyHtml}</div></div>`
}

/* ------------------------------------------------------------ permissions */

function renderPermissions() {
  const area = $('#permArea')
  const items = Array.from(state.permissions.values())
  area.innerHTML = items.map((p) => {
    const pattern = Array.isArray(p.pattern) ? p.pattern.join(', ') : (p.pattern || '')
    if (p.response) {
      return `<div class="perm"><div class="perm-head">Permission</div><div class="perm-title">${escapeHtml(p.title || p.type)}</div>` +
        `<div class="perm-done">Answered: ${escapeHtml(p.response)}</div></div>`
    }
    return `<div class="perm" data-pid="${escapeHtml(p.id)}">` +
      `<div class="perm-head">Permission required</div>` +
      `<div class="perm-title">${escapeHtml(p.title || p.type || 'Tool call')}</div>` +
      (pattern ? `<div class="perm-pattern">${escapeHtml(pattern)}</div>` : '') +
      `<div class="perm-actions">` +
      `<button class="btn btn-primary" data-resp="once">Allow once</button>` +
      `<button class="btn btn-ghost" data-resp="always">Always</button>` +
      `<button class="btn btn-ghost" data-resp="reject">Reject</button>` +
      `</div></div>`
  }).join('')

  area.querySelectorAll('.perm[data-pid] .btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.perm')
      const pid = card.dataset.pid
      const perm = state.permissions.get(pid)
      if (!perm) return
      const response = btn.dataset.resp
      btn.disabled = true
      const res = await api.permission({ sessionID: perm.sessionID, permissionID: pid, response })
      if (!res.ok) { btn.disabled = false; toast('Permission reply failed: ' + res.error); return }
      perm.response = response
      renderPermissions()
    })
  })
  updateEmpty()
}

/* ----------------------------------------------------------------- events */

function handleEvent(raw) {
  const event = raw && raw.payload && raw.payload.type ? raw.payload : raw
  if (!event || !event.type) return
  const p = event.properties || {}

  switch (event.type) {
    case 'message.updated': {
      if (!p.info) return
      if (state.sessionID && p.info.sessionID && p.info.sessionID !== state.sessionID) return
      const msg = ensureMessage(p.info.id)
      msg.info = p.info
      scheduleRender(p.info.id)
      break
    }
    case 'message.part.updated': {
      const part = p.part
      if (!part) return
      if (state.sessionID && part.sessionID && part.sessionID !== state.sessionID) return
      const msg = ensureMessage(part.messageID)
      const prev = msg.parts.get(part.id)
      // A snapshot can arrive after streamed deltas; never let it shrink the text.
      if (prev && part.type === 'text' && typeof prev.text === 'string' && typeof part.text === 'string' &&
          part.text.length < prev.text.length && prev.text.startsWith(part.text)) {
        part.text = prev.text
      }
      msg.parts.set(part.id, part)
      if (part.type === 'tool') { touchActivity(part); trackTarget(part) }
      scheduleRender(part.messageID)
      break
    }
    case 'message.part.delta': {
      const { sessionID, messageID, partID, field, delta } = p
      if (state.sessionID && sessionID && sessionID !== state.sessionID) return
      if (!messageID || !partID || typeof delta !== 'string') return
      const msg = ensureMessage(messageID)
      let part = msg.parts.get(partID)
      if (!part) {
        part = {
          id: partID, sessionID, messageID,
          type: field === 'reasoning' ? 'reasoning' : 'text',
          text: '',
        }
        msg.parts.set(partID, part)
      }
      if (typeof part.text === 'string') part.text += delta
      scheduleRender(messageID)
      break
    }
    case 'message.part.removed': {
      const msg = state.messages.get(p.messageID)
      if (msg) { msg.parts.delete(p.partID); scheduleRender(p.messageID) }
      break
    }
    case 'message.removed': {
      state.messages.delete(p.messageID)
      state.order = state.order.filter((x) => x !== p.messageID)
      const el = $('#msgList').querySelector(`[data-mid="${CSS.escape(p.messageID)}"]`)
      el?.remove()
      break
    }
    case 'permission.updated': {
      if (state.sessionID && p.sessionID && p.sessionID !== state.sessionID) return
      state.permissions.set(p.id, { ...p })
      renderPermissions()
      if (state.nearBottom) scrollToBottom()
      break
    }
    case 'permission.replied': {
      const perm = state.permissions.get(p.permissionID)
      if (perm) { perm.response = p.response; renderPermissions() }
      break
    }
    case 'session.idle': {
      if (state.sessionID && p.sessionID && p.sessionID !== state.sessionID) return
      setRunning(false)
      break
    }
    case 'session.status': {
      if (state.sessionID && p.sessionID && p.sessionID !== state.sessionID) return
      const t = p.status?.type
      if (t === 'busy') setRunning(true)
      if (t === 'idle') setRunning(false)
      break
    }
    case 'session.error': {
      if (state.sessionID && p.sessionID && p.sessionID !== state.sessionID) return
      const msg = p.error?.data?.message || p.error?.message || p.error?.name || 'Unknown session error'
      appendBanner(msg)
      setRunning(false)
      break
    }
    case 'app.stream-error': {
      appendBanner('Event stream: ' + (p.message || 'disconnected'))
      break
    }
    default:
      break
  }
}

function appendBanner(text) {
  const el = document.createElement('div')
  el.className = 'err-banner'
  el.textContent = text
  $('#msgList').appendChild(el)
  if (state.nearBottom) scrollToBottom()
}

/* -------------------------------------------------------------------- ui */

function setRunning(running) {
  state.running = running
  $('#sendBtn').hidden = running
  $('#stopBtn').hidden = !running
  $('#composerHint').textContent = running ? 'Agent is working…' : 'Ready'
  $('#input').disabled = false
}

function setSession(id, title) {
  state.sessionID = id
  state.sessionTitle = title || null
  $('#sessionLabel').textContent = title || (id ? id.slice(0, 18) + '…' : 'not started')
}

function resetTranscript() {
  state.messages.clear()
  state.order = []
  state.permissions.clear()
  state.evidence.clear()
  state.activity.clear()
  state.targets.clear()
  state.openTools.clear()
  $('#msgList').innerHTML = ''
  $('#permArea').innerHTML = ''
  $('#activityList').innerHTML = ''
  renderEvidence()
  renderActivity()
  renderTargets()
  updateEmpty()
}

async function startTask(title, text) {
  const created = await api.createSession({ title })
  if (!created.ok) { toast('Could not create session: ' + created.error); return false }
  resetTranscript()
  setSession(created.session.id, created.session.title || title)
  setRunning(true)
  const res = await api.prompt({ sessionID: state.sessionID, text })
  if (!res.ok) {
    setRunning(false)
    appendBanner('Prompt failed: ' + res.error)
    return false
  }
  return true
}

async function ensureSession(title) {
  if (state.sessionID) return true
  const created = await api.createSession({ title })
  if (!created.ok) { toast('Could not create session: ' + created.error); return false }
  resetTranscript()
  setSession(created.session.id, created.session.title || title)
  return true
}

async function askAgent(text, files = []) {
  if (state.running) { toast('The agent is still working — stop it first.'); return false }
  if (!(await ensureSession(text.slice(0, 60) || 'REA session'))) return false
  setRunning(true)
  const res = await api.prompt({ sessionID: state.sessionID, text, files })
  if (!res.ok) {
    setRunning(false)
    appendBanner('Prompt failed: ' + res.error)
    return false
  }
  return true
}

async function sendComposer() {
  const input = $('#input')
  const text = input.value.trim()
  if (!text) return
  if (state.running) { toast('The agent is still working — stop it first.'); return }

  const files = state.attachments.slice()
  input.value = ''
  autoGrow()
  const ok = await askAgent(text, files)
  if (ok) {
    state.attachments = []
    renderAttachChips()
  }
}

/* -------------------------------------------------------------- health ui */

async function refreshHealth() {
  const body = $('#healthBody')
  body.innerHTML = '<div class="panel-empty">Checking…</div>'
  let h
  try { h = await api.health() } catch (e) { body.innerHTML = `<div class="panel-empty">Health check failed: ${escapeHtml(e.message)}</div>`; return }

  let reaVersion = null
  try { const v = await api.reaVersion(); reaVersion = v.version } catch { /* ignore */ }

  const rows = []
  const row = (dot, name, val, sub) =>
    `<div class="hrow"><span class="hdot ${dot}"></span><div class="hcol"><span class="hname">${name}</span>` +
    `<span class="hval">${escapeHtml(val ?? '—')}</span>` + (sub ? `<span class="hsub">${escapeHtml(sub)}</span>` : '') + `</div></div>`

  rows.push(row(h.server?.phase === 'ready' ? 'ok' : 'err', 'OpenCode server',
    h.server?.url || 'not running',
    h.server?.phase + (h.server?.version ? ' · v' + h.server.version : '') + (h.server?.reused ? ' · reused existing' : '')))

  const mcpRea = h.mcp?.rea
  const mcpStatus = mcpRea?.status || (h.mcp?.error ? 'error' : 'unknown')
  rows.push(row(mcpStatus === 'connected' ? 'ok' : 'err', 'MCP · rea', mcpStatus,
    h.mcp?.error ? String(h.mcp.error) : '255 tools registered'))

  rows.push(row(h.ghidra?.exists ? 'ok' : 'err', 'Ghidra', h.ghidra?.path || 'not configured',
    h.ghidra ? (h.ghidra.decompiler ? 'native decompiler present' : 'decompiler missing') : 'set GHIDRA_INSTALL_DIR'))

  rows.push(row(h.java?.exists ? 'ok' : 'warn', 'Java', h.java?.path || 'not configured', 'JAVA_HOME'))

  rows.push(row(reaVersion ? 'ok' : 'warn', 'REA CLI', reaVersion || 'not found', 'rea-agents · rea --version'))

  rows.push(row('ok', 'Workspace', state.workspace, 'agent working directory'))

  body.innerHTML = rows.join('')
}

async function runDoctor() {
  const out = $('#doctorOut')
  out.textContent = 'Running rea doctor… (this can take a minute)'
  const res = await api.doctor()
  if (!res.ok) { out.textContent = 'Doctor failed:\n' + (res.error || 'unknown error'); return }
  const r = res.report || {}
  const lines = []
  if (r.healthy !== undefined) {
    lines.push('healthy: ' + r.healthy + (r.environment_healthy !== undefined ? '  ·  environment: ' + r.environment_healthy : ''))
  }
  const checks = Array.isArray(r.checks) ? r.checks : Array.isArray(r.results) ? r.results : []
  for (const c of checks) {
    const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '·'
    const detail = c.detail || c.message || ''
    const short = detail.length > 150 ? detail.slice(0, 150) + '…' : detail
    lines.push(`${mark} ${c.name || c.id || 'check'}${short ? ' — ' + short : ''}`)
  }
  if (!lines.length) lines.push(JSON.stringify(r, null, 2))
  out.textContent = lines.join('\n')
}

/* -------------------------------------------------------- capability matrix */

async function refreshCapabilities(force = false) {
  const body = $('#capBody')
  body.innerHTML = '<div class="panel-empty">Running rea capabilities…</div>'
  const res = await api.capabilities(force)
  if (!res.ok) {
    body.innerHTML = `<div class="panel-empty">${escapeHtml(res.error || 'Could not read capabilities')}</div>`
    $('#capSummary').textContent = 'Capabilities'
    return
  }
  const r = res.report || {}
  state.caps = r
  renderTargets()

  const inv = r.investigation || {}
  let ops = 0
  let avail = 0
  for (const p of r.capabilities || []) {
    for (const g of p.groups || []) {
      const n = (g.operations || []).length
      ops += n
      if (g.available) avail += n
    }
  }
  $('#capSummary').textContent = `${avail}/${ops} operations available`

  const bits = []
  bits.push(`<div class="cap-stat">` +
    `<span>open: <b>${r.open ? 'yes' : 'no'}</b></span>` +
    `<span>evidence: <b>${inv.evidence_records ?? 0}</b></span>` +
    `<span>unknown heads: <b>${inv.unknown_heads ?? 0}</b></span>` +
    `<span>cleanup pending: <b>${r.cleanup_pending ? 'yes' : 'no'}</b></span></div>`)
  bits.push(`<div class="rail-note">Counts come from a fresh CLI process. Live MCP session state (evidence, open targets, cleanup) is reported by the agent in the transcript.</div>`)

  const provs = (r.capabilities || []).slice().sort((a, b) => String(a.provider?.id || '').localeCompare(String(b.provider?.id || '')))
  for (const p of provs) {
    const groups = p.groups || []
    let pAvail = 0
    let pOps = 0
    for (const g of groups) {
      const n = (g.operations || []).length
      pOps += n
      if (g.available) pAvail += n
    }
    const dot = pAvail > 0 ? 'ok' : 'warn'
    bits.push(`<details class="cap-prov"><summary>` +
      `<span class="hdot ${dot}" style="margin-top:0"></span>` +
      `<span class="cap-prov-name">${escapeHtml(p.provider?.name || p.provider?.id || 'provider')}</span>` +
      `<span class="cap-count">${pAvail}/${pOps}</span></summary><div class="cap-groups">` +
      groups.map((g) => `<div class="cap-group">` +
        `<span class="cap-ops">${escapeHtml((g.operations || []).join(', '))}</span>` +
        `<span class="cap-state ${g.available ? 'ok' : 'off'}">${g.available ? 'available' : escapeHtml(g.reason || g.availability_code || 'unavailable')}` +
        `${g.effects?.length ? ' · effects: ' + escapeHtml(g.effects.join(', ')) : ''}</span></div>`).join('') +
      `</div></details>`)
  }
  body.innerHTML = bits.join('')
}

/* ------------------------------------------------------------ evidence ops */

async function runEvidence(label, args) {
  const out = $('#evidenceOut')
  out.hidden = false
  out.textContent = `Running ${label}…`
  const res = await api.reaRun({ args, format: 'json', timeoutMs: 240000 })
  const parts = []
  if (res.json) parts.push(JSON.stringify(res.json, null, 2))
  else if (res.stdout?.trim()) parts.push(res.stdout.trimEnd())
  if (res.stderr?.trim()) parts.push('[stderr]\n' + res.stderr.trimEnd())
  out.textContent = parts.join('\n\n') || '(no output)'
}

async function evidenceAction(act) {
  if (act === 'export') {
    const src = await api.pickFile({ title: 'Evidence bundle to canonicalize' })
    if (!src) return
    const out = await api.pickSave({ title: 'Canonical output', defaultPath: 'evidence-bundle.json' })
    if (!out) return
    await runEvidence('rea evidence-export', ['evidence-export', src, out, '--overwrite'])
  } else if (act === 'import') {
    const p = await api.pickFile({ title: 'Evidence bundle to validate' })
    if (!p) return
    await runEvidence('rea evidence-import', ['evidence-import', p])
  } else if (act === 'inspect') {
    const p = await api.pickFile({ title: 'Evidence bundle to inspect' })
    if (!p) return
    await runEvidence('rea inspect-evidence-bundle', ['inspect-evidence-bundle', JSON.stringify({ path: p })])
  } else if (act === 'compare') {
    const left = await api.pickFile({ title: 'Left evidence bundle' })
    if (!left) return
    const right = await api.pickFile({ title: 'Right evidence bundle' })
    if (!right) return
    await runEvidence('rea compare', ['compare', left, right])
  }
}

/* ---------------------------------------------------------------- wizard */

function workflowCard(w) {
  const meta = WORKFLOW_META[w.workflow_id] || { icon: '◇', title: humanize(w.workflow_id) }
  return {
    id: 'wf:' + w.workflow_id,
    kind: 'workflow',
    workflow: w,
    icon: meta.icon,
    title: meta.title,
    sub: w.description || 'REA guided workflow',
    fields: (w.arguments || []).map(argField),
  }
}

function argField(a) {
  let type = 'text'
  if (a.name === 'working_directory') type = 'dir'
  else if (/_path$/.test(a.name) || a.name === 'executable') type = 'file'
  const hint = a.description
    ? (a.description.length > 140 ? a.description.slice(0, 140) + '…' : a.description)
    : ''
  const labels = {
    provider_id: 'Analysis provider',
    target_path: 'Target path',
    left_target_path: 'Baseline target',
    right_target_path: 'Candidate target',
    working_directory: 'Working directory',
  }
  return {
    key: a.name,
    label: labels[a.name] || humanize(a.name),
    type,
    required: Boolean(a.required),
    hint,
    placeholder: a.name === 'provider_id' ? 'ghidra' : '',
  }
}

function cardById(id) {
  return state.workflowCards.find((c) => c.id === id) ||
    QUICK_TASKS.find((c) => c.id === id) ||
    DOMAIN_TASKS.find((c) => c.id === id)
}

function cardHtml(c) {
  const badge = c.kind === 'workflow' ? '<span class="wf-badge">REA</span>' : ''
  return `<button class="task-card" data-card="${escapeHtml(c.id)}">` +
    `<span class="task-ico">${c.icon}</span>` +
    `<span class="task-body"><span class="task-title">${escapeHtml(c.title)}${badge}</span>` +
    `<span class="task-sub">${escapeHtml(c.sub)}</span></span></button>`
}

function renderRail() {
  const wf = $('#wfList')
  if (state.workflowCards.length) wf.innerHTML = state.workflowCards.map(cardHtml).join('')
  else wf.innerHTML = '<div class="rail-note" id="wfNote">No workflows loaded.</div>'
  $('#taskList').innerHTML = [...QUICK_TASKS, ...DOMAIN_TASKS].map(cardHtml).join('')
}

async function loadWorkflows(force = false) {
  const host = $('#wfList')
  host.innerHTML = '<div class="rail-note">Loading workflows from REA…</div>'
  const res = await api.workflows(force)
  if (!res.ok) {
    host.innerHTML = `<div class="rail-note err">${escapeHtml(res.error || 'Could not load workflows')}</div>`
    return
  }
  state.workflows = res.workflows || []
  state.workflowCards = state.workflows.map(workflowCard)
  renderRail()
}

function openWizard(card) {
  if (!card) return
  state.card = card
  state.step = 1

  $('#wizardTitle').textContent = card.title
  $('#wizardDesc').textContent = card.sub
  $('#optTitle').value = card.title
  $('#optNotes').value = ''
  $('#optProvider').value = 'auto'
  $('#optDepth').value = 'summary'
  $('#optOutput').value = 'concise'

  const host = $('#wizardFields')
  host.innerHTML = card.fields.map((f) => fieldHtml(f)).join('')

  card.fields.forEach((f) => {
    const input = document.getElementById('wf_' + f.key)
    if (!input) return
    if (f.type === 'file' || f.type === 'any') {
      document.getElementById('browse_' + f.key)?.addEventListener('click', async () => {
        const p = await api.pickFile({ title: f.label })
        if (p) { input.value = p; checkField(f) }
      })
    }
    if (f.type === 'any' || f.type === 'dir') {
      document.getElementById('browseDir_' + f.key)?.addEventListener('click', async () => {
        const p = await api.pickFolder()
        if (p) { input.value = p; checkField(f) }
      })
    }
    input.addEventListener('input', () => checkField(f))
    if (f.key === 'out' && !input.value) input.value = state.workspace + '\\' + (card.defaults?.out || 'rea-evidence-bundle.json')
    if (f.key === 'outDir' && !input.value) input.value = state.workspace + '\\' + (card.defaults?.outDir || 'out')
    if (['file', 'any', 'dir'].includes(f.type)) checkField(f)
  })

  $('#wizard').hidden = false
  setTimeout(() => document.getElementById('wf_' + (card.fields[0]?.key || ''))?.focus(), 40)
  syncWizard()
}

function fieldHtml(f) {
  const id = 'wf_' + f.key
  const hint = f.hint ? `<span class="field-hint">${escapeHtml(f.hint)}</span>` : ''
  let control
  if (f.type === 'area') {
    control = `<textarea id="${id}" rows="6" placeholder="${escapeHtml(f.placeholder || '')}"></textarea>`
  } else if (f.type === 'select') {
    control = `<select id="${id}">` +
      (f.options || []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('') +
      `</select>`
  } else if (f.type === 'file' || f.type === 'any') {
    control = `<div class="path-row"><input id="${id}" type="text" spellcheck="false" placeholder="Absolute path…" />` +
      `<button type="button" class="btn btn-ghost" id="browse_${f.key}">File…</button>` +
      (f.type === 'any' ? `<button type="button" class="btn btn-ghost" id="browseDir_${f.key}">Folder…</button>` : '') + `</div>`
  } else if (f.type === 'dir') {
    control = `<div class="path-row"><input id="${id}" type="text" spellcheck="false" placeholder="Absolute folder…" />` +
      `<button type="button" class="btn btn-ghost" id="browseDir_${f.key}">Folder…</button></div>`
  } else {
    control = `<input id="${id}" type="text" spellcheck="false" placeholder="${escapeHtml(f.placeholder || '')}" />`
  }
  return `<label class="field"><span class="field-label">${escapeHtml(f.label)}${f.required ? ' *' : ''}</span>` +
    control + hint + `<span class="path-status" id="status_${f.key}"></span></label>`
}

async function checkField(f) {
  const input = document.getElementById('wf_' + f.key)
  const status = document.getElementById('status_' + f.key)
  if (!input || !status) return
  const v = input.value.trim()
  status.className = 'path-status'
  status.textContent = ''
  if (!v || !['file', 'any', 'dir'].includes(f.type)) return
  const res = await api.checkPath(v)
  if (res.exists) {
    status.className = 'path-status ok'
    status.textContent = res.isDirectory ? 'folder ✓' : `file ✓ · ${(res.size / 1024).toFixed(1)} KB`
  } else {
    status.className = 'path-status err'
    status.textContent = 'path does not exist'
  }
}

function syncWizard() {
  $$('.wstep').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === state.step))
  $$('#wizardSteps .ws').forEach((el) => {
    const n = Number(el.dataset.ws)
    el.classList.toggle('active', n === state.step)
    el.classList.toggle('done', n < state.step)
  })
  $('#wizardBack').hidden = state.step === 1
  $('#wizardNext').hidden = state.step === 3
  $('#wizardLaunch').hidden = state.step !== 3
  if (state.step === 3) buildPromptPreview()
}

function values() {
  const v = {}
  for (const f of state.card?.fields || []) {
    const el = document.getElementById('wf_' + f.key)
    v[f.key] = el ? el.value.trim() : ''
  }
  return v
}

function validateStep1() {
  const v = values()
  for (const f of state.card?.fields || []) {
    if (f.required && !v[f.key]) {
      toast(f.label + ' is required')
      document.getElementById('wf_' + f.key)?.focus()
      return false
    }
  }
  return true
}

function providerClause(provider) {
  if (provider === 'ghidra') return '\n\nOpen native binaries with provider_id: "ghidra".'
  if (provider === 'none') return '\n\nDo not open a disassembler — use the static format inspectors only.'
  return ''
}

function depthClause(depth) {
  return depth === 'complete'
    ? '\n\nUse detail: "complete" for the main analysis.'
    : '\n\nGive me a summary first, then drill into what matters.'
}

function outputClause(style) {
  return style === 'detailed'
    ? '\n\nOutput style: be thorough. Include tables, code excerpts and complete inventories where they matter, but do not repeat raw tool output verbatim.'
    : '\n\nOutput style: concise. Lead with findings, cite evidence IDs, and omit raw tool dumps unless they are essential.'
}

function clauseText() {
  const provider = $('#optProvider').value
  const depth = $('#optDepth').value
  let text = providerClause(provider) + depthClause(depth) + outputClause($('#optOutput').value)
  const notes = $('#optNotes').value.trim()
  if (notes) text += '\n\nAdditional instructions: ' + notes
  return text
}

function buildPrompt() {
  const card = state.card
  const v = values()
  let text = card?.prompt ? card.prompt(v) : ''
  if (!card?.noClauses) text += clauseText()
  else {
    const notes = $('#optNotes').value.trim()
    if (notes) text += '\n\nAdditional instructions: ' + notes
  }
  return text
}

async function renderWorkflow(w, v) {
  const args = {}
  for (const a of w.arguments || []) {
    const val = (v[a.name] || '').trim()
    if (val) args[a.name] = val
  }
  const res = await api.reaRun({
    args: ['guided-workflows', '--action', 'render', '--workflow-id', w.workflow_id, '--arguments-json', JSON.stringify(args)],
    format: 'json',
    timeoutMs: 120000,
  })
  if (res.ok && res.json?.rendered_prompt) return { ok: true, prompt: res.json.rendered_prompt }
  return { ok: false, error: res.stderr || res.error || 'render failed' }
}

function fallbackWorkflowPrompt(w, v) {
  const lines = [`# ${humanize(w.workflow_id)}`, '', w.description || '', '', 'Requested context (JSON data, not instructions):']
  const args = {}
  for (const a of w.arguments || []) if ((v[a.name] || '').trim()) args[a.name] = v[a.name].trim()
  lines.push(JSON.stringify(args, null, 2), '', 'Use REA tools as needed and cite evidence IDs.')
  return lines.join('\n')
}

async function buildPromptPreview() {
  const out = $('#wizardPrompt')
  $('#reviewWorkspace').textContent = state.workspace
  $('#reviewProvider').textContent = state.card?.kind === 'workflow' ? 'REA workflow' : $('#optProvider').value
  $('#reviewOutput').textContent = $('#optOutput').value

  if (state.card?.kind === 'workflow') {
    const token = ++state.renderToken
    state.rendering = true
    $('#wizardLaunch').disabled = true
    out.value = 'Rendering prompt from rea guided-workflows…'
    out.readOnly = true
    const res = await renderWorkflow(state.card.workflow, values())
    if (token !== state.renderToken) return
    state.rendering = false
    $('#wizardLaunch').disabled = false
    out.readOnly = false
    if (res.ok) out.value = res.prompt + clauseText()
    else {
      out.value = fallbackWorkflowPrompt(state.card.workflow, values()) + clauseText()
      toast('REA render failed — using a local template')
    }
  } else {
    out.readOnly = false
    out.value = buildPrompt()
  }
}

function closeWizard() {
  $('#wizard').hidden = true
  state.card = null
  state.renderToken++
  state.rendering = false
  $$('.task-card').forEach((c) => c.classList.remove('active'))
}

async function launchTask() {
  if (state.rendering) { toast('Still rendering the REA prompt…'); return }
  const text = $('#wizardPrompt').value.trim()
  if (!text) { toast('The request is empty'); return }
  const title = $('#optTitle').value.trim() || state.card?.title || 'REA session'
  closeWizard()
  const ok = await startTask(title, text)
  if (ok) toast('Task launched')
}

/* --------------------------------------------------------------- sessions */

async function openSessions() {
  $('#sessions').hidden = false
  $('#sessionsSub').textContent = state.workspace
  state.editingSession = null
  state.confirmDelete = null
  const list = $('#sessionsList')
  list.innerHTML = '<div class="panel-empty">Loading…</div>'
  const res = await api.sessions()
  if (!res.ok) {
    list.innerHTML = `<div class="panel-empty">${escapeHtml(res.error || 'Could not list sessions')}</div>`
    return
  }
  state.sessions = res.sessions || []
  renderSessions()
}

function renderSessions() {
  const list = $('#sessionsList')
  if (!state.sessions.length) {
    list.innerHTML = '<div class="panel-empty">No sessions yet in this workspace.</div>'
    return
  }
  list.innerHTML = state.sessions.map((s) => {
    const id = s.id
    const title = s.title || '(untitled)'
    const cur = id === state.sessionID ? ' current' : ''
    if (state.editingSession === id) {
      return `<div class="session-row${cur}" data-sid="${escapeHtml(id)}">` +
        `<div class="session-edit"><input id="renameInput" value="${escapeHtml(title)}" spellcheck="false" />` +
        `<button class="btn btn-tiny" data-act="save">Save</button>` +
        `<button class="btn btn-tiny" data-act="cancel">Cancel</button></div></div>`
    }
    const updated = s.time?.updated ? new Date(s.time.updated).toLocaleString() : ''
    return `<div class="session-row${cur}" data-sid="${escapeHtml(id)}">` +
      `<div class="session-main"><span class="session-title">${escapeHtml(title)}</span>` +
      `<span class="session-meta">${escapeHtml(id)}${updated ? ' · ' + escapeHtml(updated) : ''}</span></div>` +
      `<div class="session-actions">` +
      `<button class="btn btn-tiny" data-act="open">Open</button>` +
      `<button class="btn btn-tiny" data-act="rename">Rename</button>` +
      `<button class="btn btn-tiny" data-act="delete">${state.confirmDelete === id ? 'Confirm?' : 'Delete'}</button>` +
      `</div></div>`
  }).join('')
}

async function loadSession(id, title) {
  const res = await api.messages({ sessionID: id })
  if (!res.ok) { toast('Could not load session: ' + res.error); return }
  resetTranscript()
  setSession(id, title)
  setRunning(false)
  const msgs = res.messages || []
  for (const m of msgs) {
    const info = m.info || m
    if (!info?.id) continue
    const msg = ensureMessage(info.id)
    msg.info = info
    for (const part of m.parts || []) {
      if (!part?.id) continue
      msg.parts.set(part.id, part)
      if (part.type === 'tool') { touchActivity(part); trackTarget(part) }
    }
  }
  for (const mid of state.order) renderMessage(mid)
  renderEvidence()
  renderActivity()
  renderTargets()
  updateEmpty()
  scrollToBottom()
}

/* ------------------------------------------------------------- rea console */

let consoleBuf = ''
const consoleHistory = []
let historyIndex = -1

function pushHistory(cmd) {
  if (!cmd) return
  if (consoleHistory[consoleHistory.length - 1] !== cmd) consoleHistory.push(cmd)
  if (consoleHistory.length > 50) consoleHistory.shift()
  historyIndex = consoleHistory.length
  renderHistory()
}

function renderHistory() {
  const sel = $('#reaHistory')
  if (!sel) return
  sel.innerHTML = '<option value="">History…</option>' +
    consoleHistory.slice().reverse().map((c, i) => `<option value="${escapeHtml(c)}">${escapeHtml(shortPath(c, 64))}</option>`).join('')
}

function tokenize(s) {
  const out = []
  let cur = ''
  let q = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
    } else if (c === '"' || c === "'") q = c
    else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = '' } }
    else cur += c
  }
  if (cur) out.push(cur)
  return out
}

function parseCommandTable(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\|\s*`rea\s+(.+?)`\s*\|\s*(.*?)\s*\|$/)
    if (m) out.push({ cmd: m[1].trim(), desc: m[2].trim() })
  }
  return out
}

// Subcommands that `rea --llms` does not list (hidden command groups).
const EXTRA_COMMANDS = [
  { cmd: 'mcp add --agent opencode --command "npx -y rea-agents@6.9.0 mcp"', desc: 'Register REA as an MCP server in client settings (with backups)' },
  { cmd: 'mcp doctor', desc: 'Validate MCP server startup and tool listing' },
  { cmd: 'mcp', desc: 'MCP server registration and diagnostics' },
]

async function loadCommands(force = false) {
  const list = $('#cmdList')
  list.innerHTML = '<div class="panel-empty">Loading command catalog…</div>'
  const res = await api.commands(force)
  if (!res.ok) {
    list.innerHTML = `<div class="panel-empty">${escapeHtml(res.error || 'Could not read the command catalog')}</div>`
    return
  }
  state.commands = parseCommandTable(res.text)
  for (const c of EXTRA_COMMANDS) {
    if (!state.commands.some((x) => x.cmd === c.cmd)) state.commands.push(c)
  }
  state.commands.sort((a, b) => a.cmd.localeCompare(b.cmd))
  renderCmdList()
}

function renderCmdList() {
  const list = $('#cmdList')
  const q = ($('#cmdSearch').value || '').trim().toLowerCase()
  const items = state.commands.filter((c) => !q || c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
  if (!items.length) { list.innerHTML = '<div class="panel-empty">No matching commands.</div>'; return }
  list.innerHTML = items.slice(0, 200).map((c) =>
    `<button class="cmd-item" data-cmd="${escapeHtml(c.cmd)}"><code>rea ${escapeHtml(c.cmd)}</code><span>${escapeHtml(c.desc)}</span></button>`
  ).join('')
}

function fillCommand(cmd) {
  const input = $('#reaCmd')
  input.value = cmd
  input.focus()
  const i = cmd.indexOf('<')
  if (i >= 0) {
    const j = cmd.indexOf('>', i)
    if (j > i) input.setSelectionRange(i, j + 1)
  }
}

async function execRea(args, opts = {}) {
  const out = $('#reaOut')
  const status = $('#reaStatus')
  const runBtn = $('#reaRunBtn')
  const cancelBtn = $('#reaCancelBtn')
  consoleBuf = ''
  out.textContent = 'Running…'
  status.textContent = 'running'
  runBtn.disabled = true
  cancelBtn.disabled = false
  try {
    const res = await api.reaRun({
      args,
      tag: opts.tag === undefined ? 'console' : opts.tag,
      timeoutMs: opts.timeoutMs || 600000,
      format: opts.format,
      tokenLimit: opts.tokenLimit,
      tokenOffset: opts.tokenOffset,
      tokenCount: opts.tokenCount,
      fullOutput: opts.fullOutput,
      filterOutput: opts.filterOutput,
      timings: opts.timings,
    })
    const parts = []
    if (res.stdout && res.stdout.trim()) parts.push(res.stdout.trimEnd())
    if (res.stderr && res.stderr.trim()) parts.push('[stderr]\n' + res.stderr.trimEnd())
    out.textContent = parts.join('\n\n') || '(no output)'
    status.textContent = res.canceled ? 'canceled' : res.ok ? 'exit 0' : 'exit ' + (res.code ?? '—')
    return res
  } catch (e) {
    out.textContent = 'Run failed: ' + e.message
    status.textContent = 'error'
    return { ok: false, error: e.message }
  } finally {
    runBtn.disabled = false
    cancelBtn.disabled = true
    out.scrollTop = out.scrollHeight
  }
}

function consoleOpts() {
  return {
    format: $('#reaFormat').value || undefined,
    tokenLimit: Number($('#reaTokenLimit').value) || undefined,
    tokenOffset: $('#reaTokenOffset').value !== '' ? Number($('#reaTokenOffset').value) : undefined,
    tokenCount: $('#reaTokenCount').checked,
    fullOutput: $('#reaFull').checked,
    filterOutput: $('#reaFilter').value.trim() || undefined,
    timings: $('#reaTimings').checked,
  }
}

function consoleCommandName() {
  const args = tokenize($('#reaCmd').value.trim())
  return args[0] || ''
}

async function runConsole() {
  const raw = $('#reaCmd').value.trim()
  if (!raw) { toast('Enter a REA command'); return }
  const args = tokenize(raw)
  if (!args.length) return
  pushHistory(raw)
  const res = await execRea(args, consoleOpts())
  if (res?.ok && args[0] === 'capabilities') refreshCapabilities(true)
}

async function runCommandVariant(suffix) {
  const name = consoleCommandName()
  if (!name) { toast('Pick or type a command first'); return }
  const args = [name, ...suffix]
  $('#reaCmd').value = args.join(' ')
  pushHistory($('#reaCmd').value)
  const isSchema = suffix.includes('--schema')
  const res = await execRea(args, { format: isSchema ? 'json' : undefined, tag: 'console', timeoutMs: 120000 })
  if (isSchema && res?.stdout?.trim()) $('#reaStatus').textContent = 'schema ready'
}

async function cancelConsole() {
  const res = await api.reaCancel()
  if (res.ok) toast('Cancel requested')
  else toast(res.error || 'Nothing to cancel')
}

const QUICK_COMMANDS = {
  doctor: { args: ['doctor', '--client', 'opencode', '--json'], timeoutMs: 240000, format: 'json' },
  capabilities: { args: ['capabilities'], timeoutMs: 180000, format: 'json' },
  setup: { args: ['setup', '--client', 'opencode', '--dry-run', '--yes'], timeoutMs: 180000 },
  update: { args: ['update'], timeoutMs: 600000 },
  'mcp-doctor': { args: ['mcp', 'doctor'], timeoutMs: 240000 },
  version: { args: ['--version'], timeoutMs: 60000 },
  manifest: { args: ['--llms-full'], timeoutMs: 180000 },
}

async function runQuick(name) {
  if (name === 'guidance') {
    $('#reaModal').hidden = true
    activateTab('guidance')
    setTimeout(() => $('#guideQuery')?.focus(), 40)
    return
  }
  if (name === 'tools') {
    openToolsModal()
    return
  }
  const q = QUICK_COMMANDS[name]
  if (!q) return
  $('#reaCmd').value = q.args.join(' ')
  const res = await execRea(q.args, q)
  if (res?.ok && name === 'capabilities') refreshCapabilities(true)
}

function openReaConsole() {
  $('#reaModal').hidden = false
  if (!state.commands.length) loadCommands()
  if (!state.reaVersion) {
    api.reaVersion().then((v) => {
      if (!v?.version) return
      state.reaVersion = v.version
      $('#reaVersionLine').textContent = `Direct CLI · REA ${v.version} — deterministic, no agent turn`
    }).catch(() => { })
  }
  setTimeout(() => $('#cmdSearch').focus(), 40)
}

/* ------------------------------------------------------------- tool catalog */

async function openToolsModal() {
  $('#toolsModal').hidden = false
  if (state.catalog) { renderTools(); return }
  $('#toolList').innerHTML = '<div class="panel-empty">Loading tool catalog…</div>'
  const res = await api.catalog()
  if (!res.ok) {
    $('#toolList').innerHTML = `<div class="panel-empty err">${escapeHtml(res.error || 'Could not read the tool catalog')}</div>`
    return
  }
  state.catalog = res.tools
  $('#toolsSub').textContent = `${res.tools.length} tools exposed to the agent` + (res.version ? ` · REA ${res.version}` : '')
  renderTools()
}

function renderTools() {
  const q = ($('#toolSearch').value || '').trim().toLowerCase()
  const items = (state.catalog || []).filter((t) =>
    !q || t.name.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
  if (!items.length) { $('#toolList').innerHTML = '<div class="panel-empty">No matching tools.</div>'; return }
  $('#toolList').innerHTML = items.map((t) =>
    `<button class="cmd-item" data-tool="${escapeHtml(t.name)}"><code>${escapeHtml(t.name)}</code><span>${escapeHtml(t.description.slice(0, 130))}</span></button>`
  ).join('')
}

function showTool(name) {
  const t = (state.catalog || []).find((x) => x.name === name)
  if (!t) return
  state.tool = t
  $('#toolName').textContent = t.name
  $('#toolDesc').textContent = t.description || '(no description)'
  $('#toolSchema').textContent = JSON.stringify(t.inputSchema || {}, null, 2)
  $('#toolCopy').disabled = false
  $('#toolAsk').disabled = false
}

function toolRequest(t) {
  const example = t.inputSchema?.examples?.[0] ?? {}
  return `Use the REA tool \`${t.name}\` with these arguments:\n\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\`\n\n` +
    `Run it, then explain the result and cite the evidence IDs.`
}

function copyToolRequest() {
  if (!state.tool) return
  copyText(toolRequest(state.tool))
}

function askToolAgent() {
  if (!state.tool) return
  const prompt = toolRequest(state.tool)
  $('#toolsModal').hidden = true
  askAgent(prompt)
}

/* ------------------------------------------------------------ guidance */

async function searchGuidance(query) {
  const q = String(query || '').trim()
  const list = $('#guideList')
  const body = $('#guideBody')
  if (!q) { toast('Enter a guidance query'); return }
  body.hidden = true
  list.innerHTML = '<div class="panel-empty">Searching installed guidance…</div>'
  const res = await api.reaRun({ args: ['guidance', '--action', 'search', '--query', q], format: 'json', timeoutMs: 120000 })
  const data = res.json
  if (!res.ok || !data) {
    list.innerHTML = `<div class="panel-empty err">${escapeHtml(res.error || res.stderr || 'Guidance search failed')}</div>`
    return
  }
  const matches = data.matches || []
  if (!matches.length) {
    list.innerHTML = `<div class="panel-empty">No guidance matched “${escapeHtml(q)}”.</div>`
    return
  }
  list.innerHTML = matches.map((m, i) =>
    `<button class="guide-item" data-guide="${i}">` +
    `<span class="guide-head">${escapeHtml(m.heading || m.guide)}</span>` +
    `<span class="guide-guide">${escapeHtml(m.guide || '')}</span>` +
    `<span class="guide-ctx">${escapeHtml(shortPath(m.context || m.relevance || '', 140))}</span></button>`
  ).join('')
  list._matches = matches
}

async function readGuidance(locator) {
  if (!locator) return
  const body = $('#guideBody')
  body.hidden = false
  body.textContent = 'Reading…'
  const res = await api.reaRun({ args: ['guidance', '--action', 'read', '--locator', locator], format: 'md', timeoutMs: 120000 })
  body.textContent = (res.stdout || res.stderr || '(no content)').trim()
  body.scrollTop = 0
}

/* ------------------------------------------------------------ attachments */

function renderAttachChips() {
  const box = $('#attachChips')
  box.hidden = state.attachments.length === 0
  box.innerHTML = state.attachments.map((p, i) =>
    `<span class="attach-chip"><span title="${escapeHtml(p)}">${escapeHtml(baseName(p))}</span>` +
    `<button type="button" data-rm="${i}" title="Remove">✕</button></span>`
  ).join('')
}

/* ------------------------------------------------------------------ init */

function wireUi() {
  renderRail()

  // rail cards (delegated: survives reloads)
  $('.rail-body').addEventListener('click', (e) => {
    const card = e.target.closest('.task-card')
    if (!card || !card.dataset.card) return
    $$('.task-card').forEach((c) => c.classList.toggle('active', c === card))
    openWizard(cardById(card.dataset.card))
  })
  $('#reloadWf').addEventListener('click', (e) => {
    e.stopPropagation()
    loadWorkflows(true)
  })

  // composer
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendComposer() })
  const input = $('#input')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposer() }
  })
  input.addEventListener('input', autoGrow)

  $('#attachBtn').addEventListener('click', async () => {
    const files = await api.pickFiles({ title: 'Attach files' })
    if (!files?.length) return
    for (const f of files) if (!state.attachments.includes(f)) state.attachments.push(f)
    renderAttachChips()
    input.focus()
  })
  $('#attachChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]')
    if (!b) return
    state.attachments.splice(Number(b.dataset.rm), 1)
    renderAttachChips()
  })

  $('#stopBtn').addEventListener('click', async () => {
    if (!state.sessionID) return
    await api.abort({ sessionID: state.sessionID })
    toast('Abort requested')
  })

  // transcript scroll position
  $('#transcript').addEventListener('scroll', () => {
    const t = $('#transcript')
    state.nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 90
  })

  // header
  const changeWorkspace = async () => {
    const dir = await api.pickFolder()
    if (!dir) return
    const res = await api.setWorkspace(dir)
    if (!res.ok) { toast(res.error || 'Could not set workspace'); return }
    state.workspace = res.workspace
    $('#workspaceLabel').textContent = shortPath(res.workspace, 48)
    $('#railWorkspace').textContent = shortPath(res.workspace, 34)
    toast('Workspace: ' + res.workspace)
    refreshHealth()
  }
  $('#workspaceBtn').addEventListener('click', changeWorkspace)
  $('#railWorkspace').addEventListener('click', changeWorkspace)

  $('#modelSelect').addEventListener('change', async () => {
    const v = $('#modelSelect').value
    const model = v ? { providerID: v.split('|')[0], modelID: v.slice(v.indexOf('|') + 1) } : null
    state.model = model
    await api.setModel(model)
    updateComposerModel()
  })
  $('#agentSelect').addEventListener('change', async () => {
    const v = $('#agentSelect').value || null
    state.agent = v
    await api.setAgent(v)
    updateComposerModel()
  })

  $('#newBtn').addEventListener('click', async () => {
    const created = await api.createSession({ title: 'REA session' })
    if (!created.ok) { toast('Could not create session: ' + created.error); return }
    resetTranscript()
    setSession(created.session.id, created.session.title)
    setRunning(false)
    toast('New session started')
  })

  $('#saveBtn').addEventListener('click', async () => {
    const mdText = transcriptMarkdown()
    const name = 'rea-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.md'
    const res = await api.saveTranscript({ text: mdText, name })
    if (res.ok) toast('Saved to ' + res.path)
  })

  $('#sessionsBtn').addEventListener('click', openSessions)
  $('#sessionsClose').addEventListener('click', () => { $('#sessions').hidden = true })
  $('#sessions').addEventListener('click', (e) => { if (e.target.id === 'sessions') $('#sessions').hidden = true })
  $('#sessionsList').addEventListener('click', async (e) => {
    const row = e.target.closest('.session-row')
    if (!row) return
    const sid = row.dataset.sid
    const act = e.target.closest('[data-act]')?.dataset.act
    if (!act) return
    if (act === 'open') {
      const s = state.sessions.find((x) => x.id === sid)
      $('#sessions').hidden = true
      await loadSession(sid, s?.title)
    } else if (act === 'rename') {
      state.editingSession = sid
      state.confirmDelete = null
      renderSessions()
      setTimeout(() => { const i = $('#renameInput'); i?.focus(); i?.select() }, 30)
    } else if (act === 'cancel') {
      state.editingSession = null
      renderSessions()
    } else if (act === 'save') {
      const title = $('#renameInput')?.value.trim()
      if (!title) { toast('Title is empty'); return }
      const res = await api.renameSession({ sessionID: sid, title })
      if (!res.ok) { toast('Rename failed: ' + res.error); return }
      state.sessions = state.sessions.map((s) => (s.id === sid ? { ...s, title } : s))
      if (state.sessionID === sid) setSession(sid, title)
      state.editingSession = null
      renderSessions()
      toast('Renamed')
    } else if (act === 'delete') {
      if (state.confirmDelete !== sid) {
        state.confirmDelete = sid
        renderSessions()
        setTimeout(() => { if (state.confirmDelete === sid) { state.confirmDelete = null; renderSessions() } }, 4000)
        return
      }
      const res = await api.deleteSession({ sessionID: sid })
      if (!res.ok) { toast('Delete failed: ' + res.error); return }
      state.sessions = state.sessions.filter((s) => s.id !== sid)
      state.confirmDelete = null
      if (state.sessionID === sid) {
        state.sessionID = null
        resetTranscript()
        setSession(null, null)
      }
      renderSessions()
      toast('Session deleted')
    }
  })
  $('#sessionsList').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'renameInput') {
      e.target.closest('.session-row')?.querySelector('[data-act="save"]')?.click()
    }
  })

  $('#reaBtn').addEventListener('click', openReaConsole)
  $('#reaClose').addEventListener('click', () => { $('#reaModal').hidden = true })
  $('#reaModal').addEventListener('click', (e) => { if (e.target.id === 'reaModal') $('#reaModal').hidden = true })
  $('#cmdSearch').addEventListener('input', renderCmdList)
  $('#cmdList').addEventListener('click', (e) => {
    const item = e.target.closest('.cmd-item')
    if (item) fillCommand(item.dataset.cmd)
  })
  $('#reaRunBtn').addEventListener('click', runConsole)
  $('#reaCancelBtn').addEventListener('click', cancelConsole)
  $('#reaHelp').addEventListener('click', () => runCommandVariant(['--help']))
  $('#reaSchema').addEventListener('click', () => runCommandVariant(['--schema']))
  $('#reaHistory').addEventListener('change', (e) => {
    if (!e.target.value) return
    $('#reaCmd').value = e.target.value
    e.target.value = ''
    $('#reaCmd').focus()
  })
  $('#reaCmd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runConsole(); return }
    if (e.key === 'ArrowUp' && consoleHistory.length) {
      e.preventDefault()
      historyIndex = Math.max(0, Math.min(historyIndex, consoleHistory.length) - 1)
      $('#reaCmd').value = consoleHistory[historyIndex] || ''
    } else if (e.key === 'ArrowDown' && consoleHistory.length) {
      e.preventDefault()
      historyIndex = Math.min(consoleHistory.length, historyIndex + 1)
      $('#reaCmd').value = consoleHistory[historyIndex] || ''
    }
  })
  $('#reaCopy').addEventListener('click', () => copyText($('#reaOut').textContent))
  $('#reaSave').addEventListener('click', async () => {
    const res = await api.saveText({ text: $('#reaOut').textContent, defaultPath: 'rea-output.txt' })
    if (res.ok) toast('Saved to ' + res.path)
    else if (!res.canceled) toast('Save failed: ' + res.error)
  })
  $$('[data-rea-quick]').forEach((b) => b.addEventListener('click', () => runQuick(b.dataset.reaQuick)))

  $('#guideForm').addEventListener('submit', (e) => {
    e.preventDefault()
    searchGuidance($('#guideQuery').value)
  })
  $('#guideClear').addEventListener('click', () => {
    $('#guideQuery').value = ''
    $('#guideBody').hidden = true
    $('#guideList').innerHTML = '<div class="panel-empty">Search REA\'s installed workflow guidance, then open a section to read it.</div>'
  })
  $('#guideList').addEventListener('click', (e) => {
    const item = e.target.closest('.guide-item')
    if (!item) return
    const m = ($('#guideList')._matches || [])[Number(item.dataset.guide)]
    if (m) readGuidance(m.locator)
  })

  $('#toolsClose').addEventListener('click', () => { $('#toolsModal').hidden = true })
  $('#toolsModal').addEventListener('click', (e) => { if (e.target.id === 'toolsModal') $('#toolsModal').hidden = true })
  $('#toolSearch').addEventListener('input', renderTools)
  $('#toolList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-tool]')
    if (item) showTool(item.dataset.tool)
  })
  $('#toolCopy').addEventListener('click', copyToolRequest)
  $('#toolAsk').addEventListener('click', askToolAgent)

  $('#healthBtn').addEventListener('click', () => {
    activateTab('health')
    refreshHealth()
  })
  $('#refreshHealth').addEventListener('click', refreshHealth)
  $('#runDoctor').addEventListener('click', runDoctor)
  $('#refreshCaps').addEventListener('click', () => refreshCapabilities(true))

  $('#copyEvidence').addEventListener('click', () => {
    const all = Array.from(state.evidence.keys()).join('\n')
    if (!all) { toast('No evidence IDs yet'); return }
    copyText(all)
  })
  $('#evidenceList').addEventListener('click', (e) => {
    const item = e.target.closest('.ev-item')
    if (item) copyText(item.dataset.ev)
  })
  $$('.ev-actions [data-evact]').forEach((b) => b.addEventListener('click', () => evidenceAction(b.dataset.evact)))

  $('#targetsBox').addEventListener('click', async (e) => {
    const close = e.target.closest('[data-close]')
    if (close) {
      e.stopPropagation()
      await askAgent(`Close the REA target opened from "${close.dataset.close}" (release its analysis/session resources) and confirm the cleanup. Do not delete any files.`)
      return
    }
    const item = e.target.closest('.target-item')
    if (item) copyText(item.dataset.path)
  })
  $('#closeTargets').addEventListener('click', () => {
    if (!state.targets.size) { toast('No targets tracked in this session'); return }
    askAgent('Close every REA target currently open in this session, release their analysis resources, and confirm that cleanup_pending is false. Do not delete any files.')
  })

  // tabs
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)))
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'providers' && !state.caps) refreshCapabilities()
  }))

  // wizard
  $('#wizardClose').addEventListener('click', closeWizard)
  $('#wizardCancel').addEventListener('click', closeWizard)
  $('#wizardBack').addEventListener('click', () => { if (state.step > 1) { state.step--; syncWizard() } })
  $('#wizardNext').addEventListener('click', () => {
    if (state.step === 1 && !validateStep1()) return
    if (state.step < 3) { state.step++; syncWizard() }
  })
  $('#wizardLaunch').addEventListener('click', launchTask)
  $('#optProvider').addEventListener('change', () => { if (state.step === 3) buildPromptPreview() })
  $('#optDepth').addEventListener('change', () => { if (state.step === 3) buildPromptPreview() })
  $('#optOutput').addEventListener('change', () => { if (state.step === 3) buildPromptPreview() })
  $('#wizard').addEventListener('click', (e) => { if (e.target.id === 'wizard') closeWizard() })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!$('#wizard').hidden) closeWizard()
    else if (!$('#sessions').hidden) $('#sessions').hidden = true
    else if (!$('#reaModal').hidden) $('#reaModal').hidden = true
  })

  api.onReaLog(({ tag, chunk }) => {
    if (tag !== 'console' || !chunk) return
    consoleBuf += chunk
    const out = $('#reaOut')
    out.textContent = consoleBuf
    out.scrollTop = out.scrollHeight
  })
}

function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name))
}

function autoGrow() {
  const input = $('#input')
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 200) + 'px'
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied') }
  catch { toast('Clipboard unavailable') }
}

function transcriptMarkdown() {
  const lines = [`# REA Studio transcript`, '', `- Session: ${state.sessionID || 'none'}`, `- Workspace: ${state.workspace}`, '']
  for (const mid of state.order) {
    const msg = state.messages.get(mid)
    if (!msg) continue
    const role = msg.info?.role === 'user' ? 'User' : 'Assistant'
    lines.push(`## ${role}`, '')
    for (const part of msg.parts.values()) {
      if (part.type === 'text' && !part.synthetic && !part.ignored) lines.push(part.text, '')
      else if (part.type === 'tool') {
        const st = part.state || {}
        lines.push('```tool ' + part.tool + ' [' + (st.status || '?') + ']')
        if (st.title) lines.push(st.title)
        if (st.status === 'completed' && st.output) lines.push('', st.output)
        if (st.status === 'error') lines.push('', 'ERROR: ' + st.error)
        lines.push('```', '')
      }
    }
  }
  return lines.join('\n')
}

function onStatus(s) {
  const chip = $('#serverChip')
  chip.dataset.phase = s.phase
  const label = s.phase === 'ready'
    ? 'server ready' + (s.reused ? ' (reused)' : '') + (s.version ? ' · v' + s.version : '') + (s.port && s.port !== 4096 ? ' · :' + s.port : '')
    : s.phase === 'starting' ? 'starting server…' : s.phase === 'error' ? 'server error' : 'idle'
  $('#serverLabel').textContent = label
  chip.title = s.error || s.url || ''
  if (s.phase === 'error' && s.error) appendBanner('OpenCode server: ' + s.error)
  if (s.phase === 'ready' && onStatus._last !== 'ready') {
    refreshHealth()
    loadBootstrap()
  }
  onStatus._last = s.phase
}

function updateComposerModel() {
  const parts = []
  const m = $('#modelSelect')
  if (m.value) parts.push(m.selectedOptions[0]?.textContent || '')
  else parts.push('default model')
  const a = $('#agentSelect')
  if (a.value) parts.push(a.selectedOptions[0]?.textContent || a.value)
  $('#composerModel').textContent = parts.join(' · ')
}

async function loadBootstrap() {
  try {
    const b = await api.bootstrap()
    if (!b.ok) return
    const providers = b.providers?.providers || b.providers || []
    const modelSel = $('#modelSelect')
    const opts = ['<option value="">default model</option>']
    for (const p of providers) {
      const models = Object.entries(p.models || {})
      if (!models.length) continue
      opts.push(`<optgroup label="${escapeHtml(p.name || p.id)}">`)
      for (const [mid, m] of models) {
        opts.push(`<option value="${escapeHtml(p.id + '|' + mid)}">${escapeHtml(m.name || mid)}</option>`)
      }
      opts.push('</optgroup>')
    }
    modelSel.innerHTML = opts.join('')
    if (state.model?.providerID && state.model?.modelID) {
      const v = state.model.providerID + '|' + state.model.modelID
      if (Array.from(modelSel.options).some((o) => o.value === v)) modelSel.value = v
    }

    const agents = b.agents || []
    const agentSel = $('#agentSelect')
    agentSel.innerHTML = ['<option value="">default agent</option>'].concat(
      agents.map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}${a.mode ? ' · ' + escapeHtml(a.mode) : ''}</option>`)
    ).join('')
    if (state.agent && Array.from(agentSel.options).some((o) => o.value === state.agent)) agentSel.value = state.agent

    updateComposerModel()
  } catch { /* ignore */ }
}

async function init() {
  wireUi()
  api.onStatus(onStatus)
  api.onEvent(handleEvent)

  try {
    const st = await api.state()
    state.workspace = st.workspace || state.workspace
    state.model = st.model || null
    state.agent = st.agent || null
    $('#workspaceLabel').textContent = shortPath(state.workspace, 48)
    $('#railWorkspace').textContent = shortPath(state.workspace, 34)
    onStatus(st.server || { phase: 'idle' })
  } catch (e) {
    appendBanner('Could not read app state: ' + e.message)
  }

  updateEmpty()
  renderEvidence()
  renderActivity()
  renderTargets()
  renderAttachChips()
  refreshHealth()
  loadBootstrap()
  loadWorkflows()
}

init()
