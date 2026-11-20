/* IDA Free companion.
 *
 * IDA Free has no IDAPython, no idalib and no -S switch, so it cannot be
 * scripted or attached to REA's IDA provider. This panel launches the GUI on a
 * target for hands-on cross-checking, and accepts a registration file for the
 * official Hex-Rays IDA MCP so an IDA Home/Pro install becomes agent-usable.
 */

const idaState = { status: null, busy: false }

const IDA_EDITION_LABEL = {
  free: 'IDA Free',
  home: 'IDA Home',
  pro: 'IDA Pro',
  classroom: 'IDA Classroom',
  unknown: 'IDA',
}

const IDA_SETUP_SNIPPET = `{
  "mcpServers": {
    "ida-pro-mcp": {
      "command": "uvx",
      "args": ["ida-mcp", "stdio", "--agent=rea"],
      "mode": "attached"
    }
  }
}`

async function loadIdaStatus(force = false) {
  if (idaState.status && !force) return idaState.status
  try {
    const r = await api.idaStatus()
    if (r) idaState.status = r
  } catch (e) {
    idaState.status = { ok: false, error: e.message }
  }
  return idaState.status
}

function idaEditionLabel(s) {
  return IDA_EDITION_LABEL[s?.edition] || 'IDA'
}

function idaFlag(ok, yes, no) {
  return `<span class="ida-flag ${ok ? 'ok' : 'no'}">${escapeHtml(ok ? yes : no)}</span>`
}

function idaCardHtml(s) {
  if (!s || s.ok === false) {
    return `<div class="ida-card"><div class="panel-empty">${escapeHtml(
      s?.error || 'Could not read IDA status.',
    )}</div></div>`
  }
  if (!s.path) {
    return `<div class="ida-card">
      <div class="ida-head">
        <span class="hdot err" style="margin-top:0"></span>
        <span class="ida-name">IDA</span>
        <span class="ida-edition">not found</span>
        <span class="ida-actions"><button class="btn btn-tiny" id="idaPick">Choose ida.exe</button></span>
      </div>
      <div class="ida-note">No IDA executable was found. Pick one if IDA is installed somewhere unusual.</div>
    </div>`
  }

  const a = s.automation || {}
  const mcp = s.mcp || {}
  const bridge = Boolean(mcp.valid)
  const dot = bridge ? 'ok' : a.script ? 'warn' : 'warn'
  const source =
    s.source === 'settings'
      ? 'chosen'
      : s.stale
        ? 'detected (saved path missing)'
        : 'detected'

  const bridgeLine = mcp.path
    ? `<span class="ida-mcp-path">${escapeHtml(mcp.path)}</span>
       <span class="ida-flag ${bridge ? 'ok' : 'no'}">${escapeHtml(
         bridge ? `${mcp.transport} / ${mcp.mode}` : mcp.error || 'invalid registration',
       )}</span>
       <button class="btn btn-tiny" id="idaClearMcp" title="Stop passing this registration to REA">Clear</button>`
    : `<span class="ida-flag no">not configured</span>
       <button class="btn btn-tiny" id="idaPickMcp" title="Choose a JSON file containing an IDA MCP registration">Set registration…</button>
       <button class="btn btn-tiny" id="idaCopySetup" title="Copy the manual registration JSON and setup steps">Copy setup</button>`

  const note = a.script
    ? 'REA can call this IDA through the registration above once it is valid and the IDA MCP server is running.'
    : `<b>${escapeHtml(idaEditionLabel(s))}</b> cannot be scripted or attached to an agent: it has no
       <code>-S</code> script switch, no IDAPython and no idalib. Use it here for hands-on
       cross-checking while Ghidra performs the agent-driven analysis. Installing IDA Home or Pro
       (9.4+) alongside it activates the bridge below.`

  return `<div class="ida-card">
    <div class="ida-head">
      <span class="hdot ${dot}" style="margin-top:0"></span>
      <span class="ida-name">IDA</span>
      <span class="ida-edition">${escapeHtml(idaEditionLabel(s))}</span>
      <span class="ida-actions">
        <button class="btn btn-tiny" id="idaOpenTarget" title="Open the current clone target, or pick a file, in the IDA GUI">Open target</button>
        <button class="btn btn-tiny" id="idaPick" title="Choose the IDA executable">Choose ida.exe</button>
      </span>
    </div>
    <div class="ida-path">${escapeHtml(s.path)}<span class="ida-source">${escapeHtml(source)}</span></div>
    <div class="ida-grid">
      <span>Script (-S)</span>${idaFlag(a.script, 'available', 'unavailable')}
      <span>IDAPython</span>${idaFlag(a.python, 'installed', 'not installed')}
      <span>idalib</span>${idaFlag(a.idalib, 'installed', 'not installed')}
      <span>MCP plugin</span>${idaFlag(a.mcpPlugin, 'installed', 'not installed')}
    </div>
    <div class="ida-note">${note}</div>
    <div class="ida-mcp"><span class="ida-mcp-label">Agent bridge</span>${bridgeLine}</div>
  </div>`
}

function wireIdaCard() {
  $('#idaOpenTarget')?.addEventListener('click', () => openTargetInIda())
  $('#idaPick')?.addEventListener('click', chooseIdaExe)
  $('#idaPickMcp')?.addEventListener('click', chooseIdaRegistration)
  $('#idaClearMcp')?.addEventListener('click', clearIdaRegistration)
  $('#idaCopySetup')?.addEventListener('click', copyIdaSetup)
}

async function openTargetInIda(explicitTarget) {
  const target =
    explicitTarget ||
    cloneState?.detail?.target?.path ||
    cloneState?.target?.path ||
    (await api.pickFile({
      title: 'Open in IDA',
      filters: [
        { name: 'Binaries', extensions: ['exe', 'dll', 'sys', 'so', 'elf', 'dylib', 'bin', 'apk'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }))
  if (!target) return
  const r = await api.idaOpen({ target })
  if (!r?.ok) return toast('IDA: ' + (r?.error || 'could not launch'))
  toast('Opening ' + target.split(/[\\/]/).pop() + ' in ' + idaEditionLabel(idaState.status))
}

async function chooseIdaExe() {
  const picked = await api.pickFile({
    title: 'Choose the IDA executable',
    filters: [{ name: 'IDA', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }],
  })
  if (!picked) return
  const r = await api.idaSetPath({ idaPath: picked })
  if (r?.ok === false) return toast('IDA: ' + (r?.error || 'could not save'))
  idaState.status = r
  renderIdaCard()
  toast('IDA executable set')
}

async function chooseIdaRegistration() {
  const picked = await api.pickFile({
    title: 'Choose the IDA MCP registration JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
  })
  if (!picked) return
  const r = await api.idaSetMcpConfig({ file: picked })
  if (r?.ok === false) return toast('IDA bridge: ' + (r?.error || 'rejected'))
  await loadIdaStatus(true)
  renderIdaCard()
  toast('IDA bridge registration saved')
}

async function clearIdaRegistration() {
  await api.idaSetMcpConfig({ file: null })
  await loadIdaStatus(true)
  renderIdaCard()
}

async function copyIdaSetup() {
  const text =
    'Hex-Rays IDA MCP (requires IDA Home/Pro/Classroom 9.4+ with idalib; IDA Free is not supported)\n\n' +
    '1. Install uv and IDA 9.4+ Home/Pro.\n' +
    '2. Run: uvx ida-hcli mcp install\n' +
    '   (or use this manual registration)\n\n' +
    IDA_SETUP_SNIPPET +
    '\n\n3. Save it as ida-mcp.json and point REA_IDA_MCP_CONFIG at it, e.g.\n' +
    '   setx REA_IDA_MCP_CONFIG "%USERPROFILE%\\.config\\opencode\\ida-mcp.json"\n' +
    '   Also add it to mcp.rea.environment in opencode.jsonc so the agent sees it.\n'
  await copyText(text)
  toast('IDA MCP setup copied')
}

function renderIdaCard() {
  const slot = $('#idaCard')
  if (!slot) return
  slot.innerHTML = idaCardHtml(idaState.status)
  wireIdaCard()
}

async function refreshIdaCard() {
  await loadIdaStatus(true)
  renderIdaCard()
}
