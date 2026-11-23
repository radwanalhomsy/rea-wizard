/* Clone projects panel — durable, disk-backed clone workspaces.
 *
 * Loaded after app.js as a classic script, so it shares the global helpers
 * ($, $$, escapeHtml, toast) declared there.
 */

const cloneState = {
  projects: [],
  stages: [],
  root: null,
  current: null, // slug
  detail: null,
  creating: false,
  target: null,
  busy: false,
  armed: false,
  seenCalls: new Set(),
  artifacts: [],
  fidelity: null,
  facts: [],
  uiMap: null,
  guiTree: null,
  guiManifest: null,
  guiBusy: false,
  persistence: null,
  inventory: null,
  formats: [],
  protocol: null,
  ir: null,
  irValidation: null,
  irBusy: false,
  oracle: null,
  oracleBusy: false,
  repair: null,
  repairBusy: false,
  gaps: null,
  gapsBusy: false,
  recipes: null,
  recipesBusy: false,
  fingerprint: null,
  fingerprintBusy: false,
  exploreBusy: false,
  formatsBusy: false,
  protocolBusy: false,
  scoreBusy: false,
  factsBusy: false,
  uiBusy: false,
  artifactsBusy: false,
  language: 'typescript',
  generating: null, // 'spec' | 'scaffold' while a run is in flight
  autoTarget: null,
  autoBusy: false,
  autoReport: null,
  autoProgress: new Map(),
}

const RECORDABLE = /^(capture_|observe_web_session$)/

const CLONE_STATUS_LABEL = {
  pending: 'Not started',
  active: 'In progress',
  complete: 'Complete',
  blocked: 'Blocked',
}

function ago(iso) {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'unknown'
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h ago'
  const d = Math.round(h / 24)
  return d + 'd ago'
}

function bytes(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

async function loadClone(force = false) {
  if (cloneState.busy && !force) return
  cloneState.busy = true
  try {
    const res = await api.cloneList()
    if (!res?.ok) throw new Error(res?.error || 'clone:list failed')
    cloneState.projects = res.projects || []
    cloneState.stages = res.stages || []
    cloneState.root = res.root
    if (cloneState.current && !cloneState.projects.some((p) => p.slug === cloneState.current)) {
      cloneState.current = null
      cloneState.detail = null
    }
    renderCloneList()
    if (cloneState.current) await openClone(cloneState.current, true)
    else renderCloneDetail()
  } catch (e) {
    toast('Clone projects: ' + e.message)
  } finally {
    cloneState.busy = false
  }
}

function renderCloneList() {
  const list = $('#cloneList')
  const empty = $('#cloneEmpty')
  if (!list) return
  const projects = cloneState.projects
  empty.hidden = projects.length > 0 || cloneState.creating
  $('#cloneCount').textContent =
    projects.length + (projects.length === 1 ? ' project' : ' projects')

  const createCard = cloneState.creating
    ? `<div class="clone-card" id="cloneCreateCard">
         <div class="clone-card-top"><span class="clone-card-name">New clone project</span></div>
         <div class="fields" style="margin-top:8px;gap:6px">
           <input id="cloneNewName" placeholder="Project name (e.g. Acme Notes)" style="height:28px;background:var(--bg-4);border:1px solid var(--line);border-radius:6px;color:var(--text);font-size:12px;padding:0 8px" />
           <div style="display:flex;gap:6px">
             <button class="btn btn-tiny" id="clonePickTarget">Choose target…</button>
             <span id="cloneTargetLabel" style="font-size:10.5px;color:var(--text-faint);align-self:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">No target</span>
           </div>
           <div style="display:flex;gap:6px">
             <button class="btn btn-tiny" id="cloneCreateGo">Create</button>
             <button class="btn btn-tiny" id="cloneCreateCancel">Cancel</button>
           </div>
         </div>
       </div>`
    : ''

  list.innerHTML =
    createCard +
    projects
      .map((p) => {
        const pips = cloneState.stages
          .map((s) => {
            const st = p.stages?.[s.id]?.status || 'pending'
            return `<span class="clone-pip ${escapeHtml(st)}" title="${escapeHtml(s.title + ': ' + (CLONE_STATUS_LABEL[st] || st))}"></span>`
          })
          .join('')
        const active = p.slug === cloneState.current ? ' active' : ''
        const bits = []
        if (p.target?.kind) bits.push(escapeHtml(p.target.kind))
        if (p.target?.size) bits.push(bytes(p.target.size))
        if (p.blockingUnknowns) bits.push(`${p.blockingUnknowns} blocking`)
        else if (p.openUnknowns) bits.push(`${p.openUnknowns} open`)
        bits.push(`${p.stageSummary.done}/${p.stageSummary.total} stages`)
        bits.push(ago(p.updatedAt))
        return `<div class="clone-card${active}" data-slug="${escapeHtml(p.slug)}">
          <div class="clone-card-top">
            <span class="clone-card-name">${escapeHtml(p.name)}</span>
            <span class="clone-card-sub">${escapeHtml(p.slug)}</span>
          </div>
          <div class="clone-card-sub">${bits.join(' · ')}</div>
          <div class="clone-pips">${pips}</div>
        </div>`
      })
      .join('')
  renderClonePickers()
}

async function openClone(slug, keepScroll = false) {
  try {
    const [res, arts, score, facts, uiMap, gui, persistence, inventory, formats, protocol, ir, irValidation, oracle, repair, gaps, recipes, fingerprint] = await Promise.all([
      api.cloneGet({ slug }),
      api.cloneArtifacts({ slug }),
      api.fidelityGet({ slug }),
      api.factsList({ slug }),
      api.uimapGet({ slug }),
      api.guiGet({ slug }),
      api.artifactsGet({ slug }),
      api.exploreGet({ slug }),
      api.formatsList({ slug }),
      api.protocolGet({ slug }),
      api.irGet({ slug }),
      api.irValidate({ slug }),
      api.oracleList({ slug }),
      api.repairGet({ slug }),
      api.gapsGet({ slug }),
      api.recipesGet({ slug }),
      api.fingerprintGet({ slug }),
    ])
    if (!res?.ok || !res.project) throw new Error(res?.error || 'project not found')
    cloneState.current = slug
    cloneState.detail = res.project
    cloneState.artifacts = arts?.ok ? arts.artifacts || [] : []
    cloneState.fidelity = score?.ok ? score.score : null
    cloneState.facts = facts?.ok ? facts.facts || [] : []
    cloneState.uiMap = uiMap?.ok ? uiMap.map : null
    cloneState.guiTree = gui?.ok ? gui.tree : null
    cloneState.guiManifest = gui?.ok ? gui.manifest : null
    cloneState.persistence = persistence?.ok ? persistence.diff : null
    cloneState.inventory = inventory?.ok ? inventory.inventory : null
    cloneState.formats = formats?.ok ? formats.formats || [] : []
    cloneState.protocol = protocol?.ok ? protocol.protocol : null
    cloneState.ir = ir?.ok ? ir.ir : null
    cloneState.irValidation = irValidation?.ok ? irValidation : null
    cloneState.oracle = oracle?.ok ? oracle : null
    cloneState.repair = repair?.ok ? repair : null
    cloneState.gaps = gaps?.ok ? gaps : null
    cloneState.recipes = recipes?.ok ? recipes : null
    cloneState.fingerprint = fingerprint?.ok ? fingerprint : null
    renderCloneList()
    renderCloneDetail(keepScroll)
  } catch (e) {
    toast('Open project: ' + e.message)
  }
}

/* --------------------------------------------------------- shared rendering */

function projectPickerOptions() {
  const projects = cloneState.projects || []
  if (!projects.length) return '<option value="">No projects</option>'
  return (
    '<option value="">Select project...</option>' +
    projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p.slug)}"${
            p.slug === cloneState.current ? ' selected' : ''
          }>${escapeHtml(p.name)}</option>`,
      )
      .join('')
  )
}

function renderClonePickers() {
  const has = (cloneState.projects || []).length > 0
  $$('.clone-project-pick').forEach((sel) => {
    sel.innerHTML = projectPickerOptions()
    sel.disabled = !has
  })
}

function emptyProjectNote(tool) {
  const any = (cloneState.projects || []).length > 0
  return any
    ? `<div class="clone-empty-note">Select a clone project above to use the ${tool}.</div>`
    : '<div class="clone-empty-note">No clone projects yet. Create one in the <b>Clone</b> tab first.</div>'
}

function targetLineHtml(p) {
  const target = p.target
  if (!target) return 'No target recorded yet.'
  const hash = target.sha256 ? 'sha256 ' + target.sha256.slice(0, 16) + '...' : 'not hashed'
  return `${escapeHtml(target.path)}<br><span style="color:var(--text-faint)">${hash} | ${bytes(
    target.size,
  )} | ${escapeHtml(target.kind || 'kind unknown')}</span>`
}

function stageBoardHtml(p) {
  return (p.stageBoard || [])
    .map((s, i) => {
      const status = s.status || 'pending'
      const gate = s.gate || { allowed: true, blockers: [] }
      const gateHtml = !gate.allowed
        ? `<div class="clone-stage-gate">${gate.blockers.length} blocking unknown(s) keep this stage open.</div>`
        : ''
      const completeBtn =
        status === 'complete'
          ? `<button class="btn btn-tiny" data-stage-act="reopen" data-stage="${s.id}">Reopen</button>`
          : `<button class="btn btn-tiny" data-stage-act="complete" data-stage="${s.id}" ${
              gate.allowed ? '' : 'disabled title="Resolve blocking unknowns first"'
            }>Complete</button>`
      const startBtn =
        status === 'pending'
          ? `<button class="btn btn-tiny" data-stage-act="start" data-stage="${s.id}">Start</button>`
          : ''
      const blockBtn =
        status === 'blocked'
          ? `<button class="btn btn-tiny" data-stage-act="start" data-stage="${s.id}">Unblock</button>`
          : `<button class="btn btn-tiny" data-stage-act="blocked" data-stage="${s.id}">Block</button>`
      return `<div class="clone-stage ${status}">
        <div class="clone-stage-top">
          <span class="clone-stage-num">${status === 'complete' ? '&#10003;' : i + 1}</span>
          <span class="clone-stage-title">${escapeHtml(s.title)}</span>
          <span class="clone-stage-goal">${escapeHtml(s.goal)}</span>
        </div>
        <div class="clone-stage-detail">${escapeHtml(s.detail)}${s.note ? ' - ' + escapeHtml(s.note) : ''}</div>
        <div class="clone-stage-actions">
          ${startBtn}${completeBtn}${blockBtn}
          <button class="btn btn-tiny" data-stage-act="ask" data-stage="${s.id}" title="Ask the agent to work this stage">Ask agent</button>
        </div>
        ${gateHtml}
      </div>`
    })
    .join('')
}

function unknownListHtml(p) {
  const unknowns = (p.unknowns || []).slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
    return String(b.createdAt).localeCompare(String(a.createdAt))
  })
  if (!unknowns.length) {
    return '<div class="clone-empty-note">No open questions recorded. Every unresolved finding belongs here so a stage cannot quietly "finish".</div>'
  }
  return unknowns
    .map((u) => {
      const cls = [
        'clone-unknown',
        u.status === 'closed' ? 'closed' : '',
        u.blocking && u.status === 'open' ? 'blocking' : '',
      ]
        .filter(Boolean)
        .join(' ')
      const act =
        u.status === 'open'
          ? `<button class="btn btn-tiny" data-un-act="close" data-un="${u.id}" title="Resolve this unknown">Resolve</button>`
          : `<button class="btn btn-tiny" data-un-act="reopen" data-un="${u.id}" title="Reopen">Reopen</button>`
      return `<div class="${cls}">
        <div class="clone-unknown-body">
          <div class="clone-unknown-q">${escapeHtml(u.question)}</div>
          <div class="clone-unknown-meta">${escapeHtml(u.stage || 'any stage')} - ${
            u.blocking ? 'blocking' : 'non-blocking'
          }${u.evidence ? ' - ' + escapeHtml(u.evidence) : ''}${
            u.resolution ? ' - ' + escapeHtml(u.resolution) : ''
          } - ${ago(u.createdAt)}</div>
        </div>
        <div class="clone-unknown-actions">
          ${act}
          <button class="btn btn-tiny" data-un-act="toggle-block" data-un="${u.id}" title="Toggle blocking">${
            u.blocking ? 'Unblock' : 'Block'
          }</button>
          <button class="btn btn-tiny" data-un-act="delete" data-un="${u.id}" title="Remove">&#10005;</button>
        </div>
      </div>`
    })
    .join('')
}

function evidenceListHtml(p) {
  const evidence = (p.evidence || []).slice(-8).reverse()
  if (!evidence.length) {
    return '<div class="clone-empty-note">Evidence IDs found in agent answers are recorded here automatically while this project is selected.</div>'
  }
  return evidence
    .map(
      (e) =>
        `<div class="clone-unknown"><div class="clone-unknown-body"><div class="clone-unknown-q">${escapeHtml(
          e.id,
        )}</div><div class="clone-unknown-meta">${escapeHtml(e.stage || 'unassigned')} - ${escapeHtml(
          e.source || 'agent',
        )} - ${ago(e.capturedAt)}${e.file ? ' - snapshot saved' : ''}</div></div></div>`,
    )
    .join('')
}

function activityListHtml(p) {
  const log = (p.log || []).slice(-6).reverse()
  if (!log.length) return '<div class="clone-empty-note">No activity recorded yet.</div>'
  return log
    .map(
      (l) =>
        `<div class="clone-empty-note">${ago(l.at)} - ${escapeHtml(l.event)} - ${escapeHtml(l.detail || '')}</div>`,
    )
    .join('')
}

function parityBadge(c) {
  if (!c.parity) return ''
  const dims = (c.parity.dims || []).map((d) => `${d.name}: ${d.status} (${d.detail || ''})`).join('\n')
  return `<span class="clone-parity ${escapeHtml(c.parity.status)}" title="${escapeHtml(
    [c.parity.note, dims].filter(Boolean).join('\n') || c.parity.status,
  )}">${escapeHtml(c.parity.status)}</span>`
}

function caseListHtml(p, opts = {}) {
  const cases = (p.cases || []).slice().sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))
  if (!cases.length) {
    return `<div class="clone-empty-note">${opts.empty || 'No journeys recorded.'}</div>`
  }
  const parityMode = opts.mode === 'parity'
  return cases
    .map((c) => {
      const dims = (c.parity?.dims || [])
        .map(
          (d) =>
            `${escapeHtml(d.name)}: ${escapeHtml(d.status)}${
              d.detail ? ' - ' + escapeHtml(d.detail) : ''
            }`,
        )
        .join('<br>')
      const isOracle = String(c.provider || '').startsWith('oracle_')
      const replayBtn = isOracle ? '' : `<button class="btn btn-tiny" data-case-act="replay" data-case="${c.id}" title="Re-run the exact recorded request and diff it against the original">Replay</button>`
      const actions = parityMode
        ? `${replayBtn}
           <button class="btn btn-tiny" data-case-act="json" data-case="${c.id}" title="Show the recorded case file">JSON</button>
           <button class="btn btn-tiny" data-case-act="copy" data-case="${c.id}" title="Copy the replay request">Copy</button>`
        : `${replayBtn}
           <button class="btn btn-tiny" data-case-act="json" data-case="${c.id}" title="Show the recorded case file">JSON</button>
           <button class="btn btn-tiny" data-case-act="copy" data-case="${c.id}" title="Copy the replay request">Copy</button>
           <button class="btn btn-tiny" data-case-act="delete" data-case="${c.id}" title="Delete this journey">&#10005;</button>`
      return `<div class="clone-case" data-case="${c.id}">
        <div class="clone-case-body">
          <div class="clone-case-title"><span class="clone-case-kind">${escapeHtml(c.kind)}</span>${escapeHtml(
            c.title,
          )}${parityBadge(c)}</div>
          <div class="clone-case-meta">${escapeHtml(c.provider)} - ${
            c.steps?.length || 0
          } steps${c.parity ? ' - checked ' + ago(c.parity.at) : ''} - recorded ${ago(c.recordedAt)}</div>
          ${parityMode && dims ? `<div class="clone-case-dims">${dims}</div>` : ''}
        </div>
        <div class="clone-case-actions">${actions}</div>
      </div>`
    })
    .join('')
}

function paritySummaryHtml(p) {
  const cases = p.cases || []
  const n = (s) => cases.filter((c) => c.parity?.status === s).length
  const unchecked = cases.filter((c) => !c.parity).length
  const stats = [
    ['match', n('match')],
    ['changed', n('changed')],
    ['error', n('error')],
    ['unavailable', n('unavailable')],
    ['unchecked', unchecked],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<span class="clone-parity-stat ${k}">${k} ${v}</span>`)
    .join('')
  return stats ? `<div class="clone-parity-summary">${stats}</div>` : ''
}

function artifactListHtml() {
  const artifacts = cloneState.artifacts || []
  if (!artifacts.length) {
    return '<div class="clone-empty-note">Nothing generated yet. <b>Compile spec</b> writes features, contracts, state machines, tests and reports; <b>Scaffold</b> writes a code skeleton with explicit TODOs.</div>'
  }
  return artifacts
    .map(
      (a) => `<button class="clone-artifact" data-artifact="${escapeHtml(a.path)}" title="${escapeHtml(
        a.path,
      )}"><span class="clone-artifact-area">${escapeHtml(a.area || 'file')}</span><span class="clone-artifact-path">${escapeHtml(
        a.path,
      )}</span><span class="clone-artifact-size">${bytes(a.bytes)}</span></button>`,
    )
    .join('')
}

/* ---------------------------------------------------------- clone project */

function renderCloneProjectDetail() {
  const box = $('#cloneDetail')
  if (!box) return
  const p = cloneState.detail
  if (!p) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  const complete = (p.stageBoard || []).filter((s) => s.status === 'complete').length
  const openUnknowns = (p.unknowns || []).filter((u) => u.status === 'open').length
  box.innerHTML = `
    <div class="clone-detail-head">
      <span class="clone-detail-title">${escapeHtml(p.name)}</span>
      <span class="clone-head-actions">
        <button class="btn btn-tiny" id="cloneOpenIda" ${p.target ? '' : 'disabled'} title="Open the target in the IDA GUI">IDA</button>
        <button class="btn btn-tiny" id="cloneOpenFolder" title="Show the project folder">Folder</button>
        <button class="btn btn-tiny" id="cloneDelete" title="Delete this project folder">Delete</button>
      </span>
    </div>
    <div class="clone-target">${targetLineHtml(p)}</div>
    <div class="clone-empty-note">Journeys live in <b>Recorder</b>, replay diffs in <b>Parity</b>, and generated files in <b>Spec</b>.</div>
    <div class="clone-section-head"><span>Stages</span><span style="font-size:10px">${complete}/6 done</span></div>
    <div>${stageBoardHtml(p)}</div>
    <div class="clone-section-head"><span>Unknowns</span><span style="font-size:10px">${openUnknowns} open</span></div>
    <div class="clone-unknowns">${unknownListHtml(p)}</div>
    <div class="clone-unknown-form">
      <input id="cloneUnknownInput" placeholder="What is still unknown about this target?" />
      <button class="btn btn-tiny" id="cloneUnknownAdd">Add</button>
    </div>
    <div class="clone-section-head"><span>Evidence</span><span style="font-size:10px">${(p.evidence || []).length} total</span></div>
    <div class="clone-unknowns">${evidenceListHtml(p)}</div>
    <div class="clone-section-head"><span>Recent activity</span></div>
    <div class="clone-unknowns">${activityListHtml(p)}</div>
  `
  wireCloneProjectDetail(p)
}

function wireCloneProjectDetail(p) {
  $('#cloneOpenFolder')?.addEventListener('click', () => api.reveal(p.paths?.dir || cloneState.root))
  $('#cloneOpenIda')?.addEventListener('click', () => openTargetInIda(p.target?.path))
  $('#cloneDelete')?.addEventListener('click', async () => {
    if (!confirm(`Delete clone project "${p.name}" and everything in its folder?`)) return
    const res = await api.cloneDelete({ slug: p.slug })
    if (!res?.ok) return toast('Delete failed: ' + (res?.error || 'unknown'))
    cloneState.current = null
    cloneState.detail = null
    await loadClone(true)
    renderCloneDetail()
    toast('Project deleted')
  })

  $('#cloneUnknownAdd')?.addEventListener('click', addUnknownFromInput)
  $('#cloneUnknownInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addUnknownFromInput()
    }
  })

  $$('#cloneDetail [data-stage-act]').forEach((btn) => {
    btn.addEventListener('click', () => stageAction(btn.dataset.stage, btn.dataset.stageAct))
  })
  $$('#cloneDetail [data-un-act]').forEach((btn) => {
    btn.addEventListener('click', () => unknownAction(btn.dataset.un, btn.dataset.unAct))
  })
}

/* --------------------------------------------------------------- recorder */

function renderRecorderDetail() {
  const box = $('#cloneRecorder')
  if (!box) return
  const p = cloneState.detail
  if (!p) {
    box.innerHTML = emptyProjectNote('recorder')
    return
  }
  const count = (p.cases || []).length
  box.innerHTML = `
    <div class="clone-recorder-head">
      <button class="btn btn-tiny${cloneState.armed ? ' clone-armed' : ''}" id="cloneArm" title="Record capture tool calls into this project">${
        cloneState.armed ? 'Stop recording' : 'Record'
      }</button>
      <span class="clone-recorder-state">${
        cloneState.armed ? 'Armed - capture calls are saved to this project' : 'Not recording'
      }</span>
    </div>
    <div class="clone-empty-note">Arm <b>Record</b>, then have the agent run a <code>capture_*</code> or <code>observe_web_session</code> tool. The exact request is stored so it can be replayed in the <b>Parity</b> tab.</div>
    <div class="clone-section-head"><span>Guided journeys</span></div>
    <div class="clone-guide-row">
      <button class="btn btn-tiny" data-guide="browser">Browser journey</button>
      <button class="btn btn-tiny" data-guide="electron">Electron journey</button>
      <button class="btn btn-tiny" data-guide="native">Native UI journey</button>
      <button class="btn btn-tiny" data-guide="process">Process journey</button>
    </div>
    <div class="clone-section-head"><span>Recorded journeys</span><span style="font-size:10px">${count} recorded</span></div>
    <div class="clone-cases">${caseListHtml(p, {
      empty:
        'No journeys recorded yet. Arm Record and ask the agent to capture one user action end to end.',
    })}</div>
  `
  wireRecorderDetail(p)
}

function wireRecorderDetail(p) {
  $('#cloneArm')?.addEventListener('click', toggleArmed)
  $$('#cloneRecorder [data-guide]').forEach((btn) =>
    btn.addEventListener('click', () => guideJourney(btn.dataset.guide)),
  )
  $$('#cloneRecorder [data-case-act]').forEach((btn) =>
    btn.addEventListener('click', () => caseAction(btn.dataset.case, btn.dataset.caseAct, p, btn)),
  )
}

/* ----------------------------------------------------------------- parity */

function renderParityDetail() {
  const box = $('#cloneParity')
  if (!box) return
  const p = cloneState.detail
  if (!p) {
    box.innerHTML = emptyProjectNote('parity')
    return
  }
  const cases = (p.cases || []).length
  const report = (cloneState.artifacts || []).find((a) => /reports[\\/]parity\.md$/i.test(a.path))
  box.innerHTML = `
    ${paritySummaryHtml(p)}
    <div class="clone-empty-note">Replay re-runs the exact recorded request through the REA CLI and diffs steps, exit code, unknowns and record shape. Volatile timing and evidence IDs are ignored.</div>
    <div class="clone-section-head">
      <span>Journeys</span>
      <span style="display:flex;gap:4px;align-items:center">
        <span style="font-size:10px">${cases} recorded</span>
        ${report ? `<button class="btn btn-tiny" data-artifact="${escapeHtml(report.path)}">Open report</button>` : ''}
      </span>
    </div>
    <div class="clone-cases">${caseListHtml(p, {
      mode: 'parity',
      empty: 'Nothing to replay yet. Record a journey in the Recorder tab first.',
    })}</div>
  `
  wireParityDetail(p)
}

function wireParityDetail(p) {
  $$('#cloneParity [data-case-act]').forEach((btn) =>
    btn.addEventListener('click', () => caseAction(btn.dataset.case, btn.dataset.caseAct, p, btn)),
  )
  $$('#cloneParity [data-artifact]').forEach((btn) =>
    btn.addEventListener('click', () => openArtifact(btn.dataset.artifact)),
  )
}

/* ------------------------------------------------------------------- spec */

function renderSpecDetail() {
  const box = $('#cloneSpec')
  if (!box) return
  const p = cloneState.detail
  if (!p) {
    box.innerHTML = emptyProjectNote('spec')
    return
  }
  const artifacts = cloneState.artifacts || []
  const generating = cloneState.generating
  box.innerHTML = `
    <div class="clone-empty-note">Compile the spec from evidence and recorded journeys, then scaffold a runnable skeleton. Both are deterministic: regenerating produces byte-identical files, and unfinished behaviour is written as explicit <code>TODO(case_...)</code> stubs.</div>
    <div class="clone-deliverable-actions">
      <button class="btn btn-tiny" id="cloneCompile" ${
        generating ? 'disabled' : ''
      }>${generating === 'spec' ? 'Compiling...' : 'Compile spec'}</button>
      <select id="cloneLang" class="clone-lang" title="Scaffold language" ${generating ? 'disabled' : ''}>
        <option value="typescript"${cloneState.language === 'typescript' ? ' selected' : ''}>TypeScript</option>
        <option value="python"${cloneState.language === 'python' ? ' selected' : ''}>Python</option>
      </select>
      <button class="btn btn-tiny" id="cloneScaffold" ${
        generating ? 'disabled' : ''
      }>${generating === 'scaffold' ? 'Scaffolding...' : 'Scaffold'}</button>
    </div>
    <div class="clone-section-head"><span>Generated files</span><span style="font-size:10px">${artifacts.length} files</span></div>
    <div class="clone-artifacts">${artifactListHtml()}</div>
  `
  wireSpecDetail(p)
}

function wireSpecDetail(p) {
  $('#cloneCompile')?.addEventListener('click', () => generate('spec'))
  $('#cloneScaffold')?.addEventListener('click', () => generate('scaffold'))
  $('#cloneLang')?.addEventListener('change', (e) => {
    cloneState.language = e.target.value
  })
  $$('#cloneSpec [data-artifact]').forEach((btn) =>
    btn.addEventListener('click', () => openArtifact(btn.dataset.artifact)),
  )
}

/* --------------------------------------------------------------- fidelity */

function renderScoreDetail() {
  const box = $('#cloneScore')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('fidelity scorecard')
    return
  }
  const s = cloneState.fidelity
  if (!s) {
    box.innerHTML = `
      <div class="clone-empty-note">Nothing measured yet. The scorecard uses the project's target,
      evidence, journeys, UI map, artifact diffs and protocol captures as denominators.
      Unmeasured dimensions score zero — never "ok".</div>
      <button class="btn btn-tiny" id="cloneScoreCompute" ${cloneState.scoreBusy ? 'disabled' : ''}>
        ${cloneState.scoreBusy ? 'Computing...' : 'Compute fidelity'}
      </button>`
    wireScoreDetail()
    return
  }
  const pct = (n) => (n * 100).toFixed(1) + '%'
  const report = (cloneState.artifacts || []).find((a) => /reports[\\/]fidelity\.md$/i.test(a.path))
  box.innerHTML = `
    <div class="clone-fidelity-top">
      <div class="clone-fidelity-num">${pct(s.score)}</div>
      <div class="clone-fidelity-meta">
        <div><b>${escapeHtml(s.tier.id)}</b> ${escapeHtml(s.tier.label)}</div>
        <div style="color:var(--text-faint)">measured ${pct(s.measuredWeight)} of rubric · ${s.blockers.length} blockers</div>
      </div>
      <button class="btn btn-tiny" id="cloneScoreCompute" ${cloneState.scoreBusy ? 'disabled' : ''}>
        ${cloneState.scoreBusy ? '...' : 'Recompute'}
      </button>
    </div>
    <div class="clone-fidelity-bar"><span style="width:${(s.score * 100).toFixed(1)}%"></span></div>
    <div class="clone-section-head"><span>Dimensions</span>
      ${report ? `<button class="btn btn-tiny" data-artifact="${escapeHtml(report.path)}">Open report</button>` : ''}
    </div>
    <div class="clone-fidelity-dims">${s.dimensions.map((d) => `
      <div class="clone-fidelity-dim">
        <div class="clone-fidelity-dim-head">
          <span>${escapeHtml(d.label)}</span>
          <span class="${d.measured ? '' : 'clone-dim-off'}">${d.measured ? pct(d.score) : 'unmeasured'}</span>
        </div>
        <div class="clone-fidelity-dim-bar"><span style="width:${(d.score * 100).toFixed(1)}%"></span></div>
        <div class="clone-fidelity-dim-sub">${escapeHtml(d.detail)} · weight ${pct(d.weight)} · ${d.blockers.length} blockers</div>
      </div>`).join('')}
    </div>
    <div class="clone-section-head"><span>Biggest gains</span></div>
    <div class="clone-gains">${s.improvements.length
      ? s.improvements.map((i) => `<div class="clone-gain"><b>+${pct(i.gain)}</b><span>${escapeHtml(i.label)} — ${escapeHtml(i.action)}</span></div>`).join('')
      : '<div class="clone-empty-note">No ranked gaps.</div>'}</div>`
  wireScoreDetail()
}

function wireScoreDetail() {
  $('#cloneScoreCompute')?.addEventListener('click', async () => {
    if (!cloneState.current || cloneState.scoreBusy) return
    cloneState.scoreBusy = true
    renderScoreDetail()
    try {
      const r = await api.fidelityCompute({ slug: cloneState.current })
      if (!r?.ok) throw new Error(r?.error || 'fidelity failed')
      cloneState.fidelity = r.score
      cloneState.scoreBusy = false
      await loadClone(true)
      renderScoreDetail()
    } catch (e) {
      toast('Fidelity: ' + e.message)
      cloneState.scoreBusy = false
      renderScoreDetail()
    }
  })
  $$('#cloneScore [data-artifact]').forEach((btn) =>
    btn.addEventListener('click', () => openArtifact(btn.dataset.artifact)),
  )
}

/* ------------------------------------------------------------------ facts */

function renderFactsDetail() {
  const box = $('#cloneFacts')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('fact ledger')
    return
  }
  const facts = cloneState.facts || []
  const promoted = facts.filter((f) => f.promoted).length
  const conflicts = facts.filter((f) => f.conflict).length
  box.innerHTML = `
    <div class="clone-empty-note">Every claim names the evidence or case that produced it. A claim seen from
    two independent sources becomes a rule; conflicting values open a blocking unknown.</div>
    <div class="clone-deliverable-actions">
      <button class="btn btn-tiny" id="cloneFactsExtract" ${cloneState.factsBusy ? 'disabled' : ''}>
        ${cloneState.factsBusy ? 'Extracting...' : 'Extract facts'}
      </button>
      <span style="font-size:10px;color:var(--text-faint)">${facts.length} facts · ${promoted} rules · ${conflicts} conflicts</span>
    </div>
    <div class="clone-section-head"><span>Ledger</span><input id="cloneFactsFilter" class="clone-lang" placeholder="Filter claims" style="width:120px" /></div>
    <div class="clone-facts-list">${facts.length ? facts.map((f) => `
      <div class="clone-fact${f.conflict ? ' conflict' : ''}${f.promoted ? ' promoted' : ''}" data-claim="${escapeHtml(f.claim)}">
        <div class="clone-fact-head"><span class="clone-fact-id">${escapeHtml(f.id)}</span>
          <span class="clone-fact-kind">${escapeHtml(f.kind)}</span>
          <span class="clone-fact-conf">${f.confidence}${f.promoted ? ' rule' : ''}${f.conflict ? ' conflict' : ''}</span></div>
        <div class="clone-fact-claim">${escapeHtml(f.claim)}</div>
        <div class="clone-fact-value">${escapeHtml(shortText(f.value))}</div>
        <div class="clone-fact-src">${escapeHtml([...f.sources, ...f.evidence, ...f.cases].join(' · ') || 'no citations')}</div>
      </div>`).join('') : '<div class="clone-empty-note">No facts yet. Record evidence, journeys or a UI map, then extract.</div>'}</div>`
  wireFactsDetail()
}

function shortText(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 180 ? text.slice(0, 177) + '…' : text
}

function wireFactsDetail() {
  $('#cloneFactsExtract')?.addEventListener('click', async () => {
    if (!cloneState.current || cloneState.factsBusy) return
    cloneState.factsBusy = true
    renderFactsDetail()
    try {
      const r = await api.factsExtract({ slug: cloneState.current })
      if (!r?.ok) throw new Error(r?.error || 'facts extraction failed')
      cloneState.facts = r.facts || []
      if (r.conflicts) toast(`${r.conflicts} conflicting claims opened as unknowns`)
      cloneState.factsBusy = false
      await loadClone(true)
      renderFactsDetail()
    } catch (e) {
      toast('Facts: ' + e.message)
      cloneState.factsBusy = false
      renderFactsDetail()
    }
  })
  $('#cloneFactsFilter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase()
    $$('#cloneFacts .clone-fact').forEach((el) => {
      el.hidden = q ? !el.dataset.claim.toLowerCase().includes(q) : false
    })
  })
}

/* --------------------------------------------------------------- UI map */

function renderUiMapTool() {
  const box = $('#cloneUiMap')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('UI map')
    return
  }
  const p = cloneState.detail
  const map = cloneState.uiMap
  const controls = map?.controls || []
  box.innerHTML = `
    <div class="clone-empty-note">Enumerates the Windows accessibility tree of a target window. Attach to a
    running PID or window title, or launch the clone target. The result gives the scorecard a real UI denominator.</div>
    <div class="clone-capture-form">
      <label>Target<input id="uimapTarget" value="${escapeHtml(p.target?.path || '')}" placeholder="path to executable" /></label>
      <label>PID<input id="uimapPid" type="number" min="0" value="" placeholder="running process" /></label>
      <label>Window title<input id="uimapTitle" value="" placeholder="partial title" /></label>
      <label>Wait (s)<input id="uimapSeconds" type="number" min="1" max="30" value="5" /></label>
      <label class="clone-check"><input id="uimapClose" type="checkbox" /> Close after capture</label>
      <button class="btn btn-tiny" id="uimapCapture" ${cloneState.uiBusy ? 'disabled' : ''}>
        ${cloneState.uiBusy ? 'Capturing...' : 'Capture UI map'}
      </button>
    </div>
    ${map ? `
      <div class="clone-capture-summary">${escapeHtml(map.title || 'window')} · ${controls.length} controls · ${escapeHtml(map.source || '')}</div>
      <div class="clone-section-head"><span>Controls</span></div>
      <div class="clone-control-list">${controls.length ? controls.slice(0, 400).map((c) => `
        <div class="clone-control"><span class="clone-control-type">${escapeHtml(c.type || '')}</span>
          <span class="clone-control-name">${escapeHtml(c.label || c.name || '')}</span>
          <span class="clone-control-parent">${escapeHtml(c.parent || '')}</span></div>`).join('')
        : '<div class="clone-empty-note">No controls were exposed by this window.</div>'}</div>`
      : '<div class="clone-empty-note">No UI map captured for this project yet.</div>'}`
  wireUiMapTool()
}

function wireUiMapTool() {
  $('#uimapCapture')?.addEventListener('click', async () => {
    if (!cloneState.current || cloneState.uiBusy) return
    cloneState.uiBusy = true
    renderUiMapTool()
    try {
      const r = await api.uimapCapture({
        slug: cloneState.current,
        target: $('#uimapTarget')?.value?.trim() || null,
        pid: Number($('#uimapPid')?.value) || 0,
        windowTitle: $('#uimapTitle')?.value?.trim() || '',
        seconds: Number($('#uimapSeconds')?.value) || 5,
        closeAfter: Boolean($('#uimapClose')?.checked),
      })
      if (!r?.ok) throw new Error(r?.error || 'UI map capture failed')
      cloneState.uiMap = (await api.uimapGet({ slug: cloneState.current })).map
      cloneState.uiBusy = false
      await loadClone(true)
      renderUiMapTool()
      toast(`UI map: ${r.controls} controls`)
    } catch (e) {
      cloneState.uiBusy = false
      renderUiMapTool()
      toast('UI map: ' + e.message)
    }
  })
}

/* -------------------------------------------------------------- GUI cloner */

function renderGuiTool() {
  const box = $('#cloneGui')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('GUI cloner')
    return
  }
  const p = cloneState.detail
  const tree = cloneState.guiTree
  const manifest = cloneState.guiManifest
  const counts = tree?.summary || null
  const verification = manifest?.verification || null
  const surfaces = tree?.surfaces || []
  box.innerHTML = `
    <div class="clone-empty-note">Opens the real accessibility tree, expands menus, submenus, tabs and tree nodes,
    then writes a deterministic browser clone under <code>clone/gui/</code>. Only controls actually exposed by
    UI Automation become nodes.</div>
    <div class="clone-capture-form">
      <label>Target<input id="guiTarget" value="${escapeHtml(p.target?.path || '')}" placeholder="path to executable" /></label>
      <label>PID<input id="guiPid" type="number" min="0" value="" placeholder="running process" /></label>
      <label>Window title<input id="guiTitle" value="" placeholder="partial title" /></label>
      <label>Wait (s)<input id="guiSeconds" type="number" min="1" max="30" value="5" /></label>
      <label>Max nodes<input id="guiMax" type="number" min="100" max="12000" value="4000" /></label>
      <label>Depth<input id="guiDepth" type="number" min="1" max="20" value="12" /></label>
      <label class="clone-check"><input id="guiClose" type="checkbox" /> Close after capture</label>
      <button class="btn btn-tiny" id="guiCapture" ${cloneState.guiBusy ? 'disabled' : ''}>
        ${cloneState.guiBusy ? 'Reading GUI...' : 'Capture full GUI'}
      </button>
    </div>
    ${tree ? `
      <div class="clone-capture-summary">${escapeHtml(tree.title || 'window')} · ${tree.nodes?.length || 0} nodes ·
        ${surfaces.length} surfaces · ${escapeHtml(tree.evidence || '')}</div>
      <div class="clone-section-head"><span>Measured surface</span></div>
      <div class="clone-capture-summary">
        ${counts?.windows || 0} windows · ${counts?.menuSurfaces || 0} menus ·
        ${counts?.submenus || 0} submenu nodes · ${counts?.tabSurfaces || 0} tab surfaces ·
        ${counts?.treeItems || 0} tree items
      </div>
      <div class="clone-recorder-head" style="margin-top:8px">
        <button class="btn btn-tiny" id="guiGenerate" ${cloneState.guiBusy ? 'disabled' : ''}>Generate GUI clone</button>
        <button class="btn btn-tiny" id="guiVerify" ${cloneState.guiBusy ? 'disabled' : ''}>Verify</button>
        <button class="btn btn-tiny" id="guiOpen" ${cloneState.guiBusy ? 'disabled' : ''}>Open clone</button>
      </div>
      ${verification ? `<div class="clone-capture-summary">Verification: ${escapeHtml(String(verification.completeness ?? 0))} ·
        ${verification.renderedNodes || 0}/${verification.totalNodes || 0} nodes represented</div>` : ''}
      <div class="clone-section-head"><span>Surfaces</span></div>
      <div class="clone-control-list">${surfaces.slice(0, 200).map((s) => `
        <div class="clone-control"><span class="clone-control-type">${escapeHtml(s.split(':')[0] || 'surface')}</span>
          <span class="clone-control-name">${escapeHtml(s)}</span></div>`).join('')}</div>
      <div class="clone-section-head"><span>Captured nodes</span></div>
      <div class="clone-control-list">${(tree.nodes || []).slice(0, 300).map((n) => `
        <div class="clone-control"><span class="clone-control-type">${escapeHtml(n.type || '')}</span>
          <span class="clone-control-name">${escapeHtml(n.label || n.name || '')}</span>
          <span class="clone-control-parent">${escapeHtml(n.surface || '')}</span></div>`).join('')}</div>`
      : '<div class="clone-empty-note">No deep GUI tree captured for this project yet.</div>'}`
  wireGuiTool()
}

function guiBusyRun(fn) {
  if (!cloneState.current || cloneState.guiBusy) return
  cloneState.guiBusy = true
  renderGuiTool()
  return Promise.resolve()
    .then(fn)
    .then(async (r) => {
      if (r && r.ok === false) throw new Error(r.error || 'GUI operation failed')
      cloneState.guiBusy = false
      await openClone(cloneState.current, true)
      renderGuiTool()
      return r
    })
    .catch((e) => {
      cloneState.guiBusy = false
      renderGuiTool()
      toast('GUI cloner: ' + e.message)
      return null
    })
}

function wireGuiTool() {
  $('#guiCapture')?.addEventListener('click', () => guiBusyRun(async () => {
    const r = await api.guiCapture({
      slug: cloneState.current,
      target: $('#guiTarget')?.value?.trim() || null,
      pid: Number($('#guiPid')?.value) || 0,
      windowTitle: $('#guiTitle')?.value?.trim() || '',
      seconds: Number($('#guiSeconds')?.value) || 5,
      max: Number($('#guiMax')?.value) || 4000,
      depth: Number($('#guiDepth')?.value) || 12,
      closeAfter: Boolean($('#guiClose')?.checked),
    })
    toast(`GUI: ${r?.summary?.nodes || 0} nodes across ${r?.summary?.surfaces || 0} surfaces`)
    return r
  }))
  $('#guiGenerate')?.addEventListener('click', () => guiBusyRun(async () => {
    const r = await api.guiGenerate({ slug: cloneState.current })
    toast(`GUI clone: ${r?.verification?.renderedNodes || 0}/${r?.verification?.totalNodes || 0} nodes`)
    return r
  }))
  $('#guiVerify')?.addEventListener('click', () => guiBusyRun(async () => {
    const r = await api.guiVerify({ slug: cloneState.current })
    toast(`GUI verify: ${r?.detail || r?.status || 'done'}`)
    return r
  }))
  $('#guiOpen')?.addEventListener('click', () => guiBusyRun(async () => {
    const r = await api.guiOpen({ slug: cloneState.current })
    return r
  }))
}

/* ------------------------------------------------------------- artifacts */

function renderArtifactsTool() {
  const box = $('#cloneArtifactsTool')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('artifact diff')
    return
  }
  const p = cloneState.detail
  const diff = cloneState.persistence
  const artifacts = diff?.artifacts || []
  const c = diff?.counts || { files: 0, registry: 0, processes: 0 }
  box.innerHTML = `
    <div class="clone-empty-note">Snapshot the machine, run the target, snapshot again, and diff. Changed files,
    registry keys and processes become citable evidence and a persistence model for the spec.</div>
    <div class="clone-capture-form">
      <label>Target<input id="artTarget" value="${escapeHtml(p.target?.path || '')}" placeholder="path to executable" /></label>
      <label>Wait (s)<input id="artSeconds" type="number" min="1" max="60" value="6" /></label>
      <label class="clone-check"><input id="artClose" type="checkbox" checked /> Close after capture</label>
      <button class="btn btn-tiny" id="artCapture" ${cloneState.artifactsBusy ? 'disabled' : ''}>
        ${cloneState.artifactsBusy ? 'Capturing...' : 'Run & diff'}
      </button>
    </div>
    ${diff ? `
      <div class="clone-capture-summary">${c.files} files · ${c.registry} registry · ${c.processes} processes</div>
      <div class="clone-section-head"><span>Changes</span></div>
      <div class="clone-control-list">${artifacts.length ? artifacts.slice(0, 400).map((a) => `
        <div class="clone-control"><span class="clone-control-type">${escapeHtml(a.kind || '')}</span>
          <span class="clone-control-name">${escapeHtml(a.operation || '')}</span>
          <span class="clone-control-parent">${escapeHtml(a.path || '')}</span></div>`).join('')
        : '<div class="clone-empty-note">No changes observed. Try a longer wait or a target that writes to disk.</div>'}</div>`
      : '<div class="clone-empty-note">No artifact diff captured for this project yet.</div>'}`
  wireArtifactsTool()
}

function wireArtifactsTool() {
  $('#artCapture')?.addEventListener('click', async () => {
    if (!cloneState.current || cloneState.artifactsBusy) return
    cloneState.artifactsBusy = true
    renderArtifactsTool()
    try {
      const r = await api.artifactsCapture({
        slug: cloneState.current,
        target: $('#artTarget')?.value?.trim(),
        seconds: Number($('#artSeconds')?.value) || 6,
        closeAfter: Boolean($('#artClose')?.checked),
      })
      if (!r?.ok) throw new Error(r?.error || 'Artifact capture failed')
      cloneState.persistence = (await api.artifactsGet({ slug: cloneState.current })).diff
      cloneState.artifactsBusy = false
      await loadClone(true)
      renderArtifactsTool()
      toast(`Artifacts: ${r.artifacts} changes`)
    } catch (e) {
      cloneState.artifactsBusy = false
      renderArtifactsTool()
      toast('Artifacts: ' + e.message)
    }
  })
}

/* -------------------------------------------------------------- explore */

function renderExploreTool() {
  const box = $('#cloneExplore')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('target exploration')
    return
  }
  const p = cloneState.detail
  const inv = cloneState.inventory
  const pe = inv?.pe
  box.innerHTML = `
    <div class="clone-empty-note">Offline analysis of the target binary. Computes the canonical SHA-256, parses PE
    headers, sections, imports and exports, and extracts bounded strings — no network or Ghidra required.</div>
    <div class="clone-capture-form">
      <label>Target<input id="exploreTarget" value="${escapeHtml(inv?.file?.path || p.target?.path || '')}" placeholder="path to executable" /></label>
      <button class="btn btn-tiny" id="exploreRun" ${cloneState.exploreBusy ? 'disabled' : ''}>
        ${cloneState.exploreBusy ? 'Analyzing...' : 'Analyze target'}
      </button>
    </div>
    ${inv ? `
      <div class="clone-inv-grid">
        <div><span>SHA-256</span><code>${escapeHtml((inv.file.sha256 || 'none').slice(0, 32))}…</code></div>
        <div><span>Size</span><code>${Number(inv.file.size || 0).toLocaleString()} B</code></div>
        <div><span>Format</span><code>${escapeHtml(pe ? `${pe.format} ${pe.arch} ${pe.bits}-bit` : inv.file.kind || 'unknown')}</code></div>
        <div><span>Entry</span><code>${escapeHtml(pe ? `${pe.imageBase}+${pe.entryPointRva}` : '—')}</code></div>
        <div><span>Sections</span><code>${inv.stats.sectionCount}</code></div>
        <div><span>Imports</span><code>${inv.stats.importCount}</code></div>
        <div><span>Exports</span><code>${inv.stats.exportCount}</code></div>
        <div><span>Strings</span><code>${inv.strings.length}</code></div>
      </div>
      ${inv.parseError ? `<div class="clone-inv-error">${escapeHtml(inv.parseError)}</div>` : ''}
      <div class="clone-section-head"><span>Sections</span></div>
      <div class="clone-control-list">${(pe?.sections || []).map((s) => `
        <div class="clone-control"><span class="clone-control-type">0x${s.virtualAddress.toString(16)}</span>
          <span class="clone-control-name">${escapeHtml(s.name)}</span>
          <span class="clone-control-parent">raw 0x${s.rawSize.toString(16)} · VA 0x${s.virtualSize.toString(16)}</span></div>`).join('')}</div>
      <div class="clone-section-head"><span>Imports</span></div>
      <div class="clone-control-list">${(pe?.imports || []).slice(0, 200).map((i) => `
        <div class="clone-control"><span class="clone-control-type">DLL</span>
          <span class="clone-control-name">${escapeHtml(i.dll || '?')}</span>
          <span class="clone-control-parent">${i.count} symbols</span></div>`).join('') || '<div class="clone-empty-note">No imports parsed.</div>'}</div>
      <div class="clone-section-head"><span>Notable strings</span></div>
      <div class="clone-control-list">${inv.strings.slice(0, 120).map((s) => `
        <div class="clone-control"><span class="clone-control-type">${escapeHtml(s.offset)}</span>
          <span class="clone-control-name">${escapeHtml(s.value)}</span>
          <span class="clone-control-parent"></span></div>`).join('')}</div>`
      : '<div class="clone-empty-note">No inventory yet. Click <b>Analyze target</b> to explore it.</div>'}`
  wireExploreTool()
}

function wireExploreTool() {
  $('#exploreRun')?.addEventListener('click', async () => {
    if (!cloneState.current || cloneState.exploreBusy) return
    const targetPath = $('#exploreTarget')?.value?.trim() || null
    cloneState.exploreBusy = true
    renderExploreTool()
    try {
      const r = await api.exploreRun({ slug: cloneState.current, targetPath })
      if (!r?.ok) throw new Error(r?.error || 'exploration failed')
      cloneState.inventory = (await api.exploreGet({ slug: cloneState.current })).inventory
      cloneState.exploreBusy = false
      await loadClone(true)
      renderExploreTool()
      toast(`Explored ${r.file.sha256 ? r.file.sha256.slice(0, 12) : 'target'}`)
    } catch (e) {
      cloneState.exploreBusy = false
      renderExploreTool()
      toast('Explore: ' + e.message)
    }
  })
}

/* -------------------------------------------------------------- formats */

function renderFormatsTool() {
  const box = $('#cloneFormats')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('format inference')
    return
  }
  const formats = cloneState.formats || []
  box.innerHTML = `
    <div class="clone-empty-note">Infer data layouts from files observed in the artifact diff. Known magic gets named
    fields; unknown bytes stay unknown with observed offsets and strings instead of a guessed schema.</div>
    <div class="clone-deliverable-actions">
      <button class="btn btn-tiny" id="fmtFromArtifacts" ${cloneState.formatsBusy ? 'disabled' : ''}>
        ${cloneState.formatsBusy ? 'Inferring...' : 'Infer from artifacts'}
      </button>
      <span style="font-size:10px;color:var(--text-faint)">${formats.length} skeleton(s)</span>
    </div>
    <div class="clone-capture-form">
      <label>File path<input id="fmtPath" placeholder="absolute path to a sample file" /></label>
      <label>Label<input id="fmtLabel" placeholder="optional name" /></label>
      <button class="btn btn-tiny" id="fmtInfer" ${cloneState.formatsBusy ? 'disabled' : ''}>Infer file</button>
    </div>
    <div class="clone-facts-list">${formats.length ? formats.map((f) => `
      <div class="clone-fact">
        <div class="clone-fact-head"><span class="clone-fact-id">${escapeHtml(f.name)}</span>
          <span class="clone-fact-kind">${escapeHtml(f.label)}</span>
          <span class="clone-fact-conf">${f.confidence}</span></div>
        <div class="clone-fact-claim">${escapeHtml(f.magic || 'no magic')} · entropy ${f.entropy} · ${f.fields.length} fields</div>
        <div class="clone-fact-value">${escapeHtml((f.strings || []).slice(0, 4).map((s) => s.value).join(' · '))}</div>
        <div class="clone-fact-src">${escapeHtml(f.source?.path || '')}</div>
      </div>`).join('') : '<div class="clone-empty-note">No format skeletons yet.</div>'}</div>`
  wireFormatsTool()
}

function wireFormatsTool() {
  const run = async (fn) => {
    if (!cloneState.current || cloneState.formatsBusy) return
    cloneState.formatsBusy = true
    renderFormatsTool()
    try {
      const r = await fn()
      if (!r?.ok) throw new Error(r?.error || 'format inference failed')
      cloneState.formats = (await api.formatsList({ slug: cloneState.current })).formats || []
      cloneState.formatsBusy = false
      await loadClone(true)
      renderFormatsTool()
      toast(`Formats: ${r.formats?.length ?? 1} skeleton(s)`)
    } catch (e) {
      cloneState.formatsBusy = false
      renderFormatsTool()
      toast('Formats: ' + e.message)
    }
  }
  $('#fmtFromArtifacts')?.addEventListener('click', () => run(() => api.formatsFromArtifacts({ slug: cloneState.current })))
  $('#fmtInfer')?.addEventListener('click', () => {
    const filePath = $('#fmtPath')?.value?.trim()
    if (!filePath) { toast('Formats: enter a file path'); return }
    run(() => api.formatsInfer({ slug: cloneState.current, path: filePath, label: $('#fmtLabel')?.value?.trim() || null }))
  })
}

/* ------------------------------------------------------------- protocol */

function renderProtocolTool() {
  const box = $('#cloneProtocol')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('protocol capture')
    return
  }
  const p = cloneState.detail
  const proto = cloneState.protocol
  const endpoints = proto?.endpoints || []
  box.innerHTML = `
    <div class="clone-empty-note">Discover network endpoints while the target runs. netstat works for any TCP
    program; the loopback proxy logs HTTP clients that honour proxy settings; HAR imports fold in traffic captured elsewhere.</div>
    <div class="clone-capture-form">
      <label>Target<input id="protoTarget" value="${escapeHtml(p.target?.path || '')}" placeholder="path to executable" /></label>
      <label>PID<input id="protoPid" type="number" min="0" value="" placeholder="running process" /></label>
      <label>Seconds<input id="protoSeconds" type="number" min="1" max="120" value="8" /></label>
      <button class="btn btn-tiny" id="protoNetstat" ${cloneState.protocolBusy ? 'disabled' : ''}>
        ${cloneState.protocolBusy ? 'Watching...' : 'Watch endpoints'}
      </button>
    </div>
    <div class="clone-capture-form">
      <label>Proxy port<input id="protoPort" type="number" min="1" max="65535" value="8899" /></label>
      <button class="btn btn-tiny" id="protoProxy" ${cloneState.protocolBusy ? 'disabled' : ''}>Run proxy</button>
    </div>
    <div class="clone-capture-form">
      <label>HAR file<input id="protoHar" placeholder="absolute path to .har" /></label>
      <button class="btn btn-tiny" id="protoHarGo" ${cloneState.protocolBusy ? 'disabled' : ''}>Import HAR</button>
    </div>
    ${proto ? `
      <div class="clone-capture-summary">${endpoints.length} endpoint(s) · ${(proto.sources || []).join(', ')}</div>
      <div class="clone-control-list">${endpoints.length ? endpoints.slice(0, 300).map((e) => `
        <div class="clone-control"><span class="clone-control-type">${escapeHtml(e.method || e.protocol || 'tcp')}</span>
          <span class="clone-control-name">${escapeHtml(`${e.host || ''}${e.port ? ':' + e.port : ''}${e.path || ''}`)}</span>
          <span class="clone-control-parent">${escapeHtml(String(e.status ?? e.state ?? ''))}</span></div>`).join('')
        : '<div class="clone-empty-note">No endpoints observed.</div>'}</div>
      <div class="clone-section-head"><span>Limitations</span></div>
      <div class="clone-empty-note">${(proto.limitations || []).map((l) => escapeHtml(l)).join('<br>') || 'None recorded.'}</div>`
      : '<div class="clone-empty-note">No protocol capture yet.</div>'}`
  wireProtocolTool()
}

function wireProtocolTool() {
  const run = async (fn) => {
    if (!cloneState.current || cloneState.protocolBusy) return
    cloneState.protocolBusy = true
    renderProtocolTool()
    try {
      const r = await fn()
      if (!r?.ok) throw new Error(r?.error || 'protocol capture failed')
      cloneState.protocol = (await api.protocolGet({ slug: cloneState.current })).protocol
      cloneState.protocolBusy = false
      await loadClone(true)
      renderProtocolTool()
      toast(`Protocol: ${r.endpoints ?? 0} endpoint(s)`)
    } catch (e) {
      cloneState.protocolBusy = false
      renderProtocolTool()
      toast('Protocol: ' + e.message)
    }
  }
  $('#protoNetstat')?.addEventListener('click', () => run(() => api.protocolNetstat({
    slug: cloneState.current,
    target: $('#protoTarget')?.value?.trim() || null,
    pid: Number($('#protoPid')?.value) || 0,
    seconds: Number($('#protoSeconds')?.value) || 8,
  })))
  $('#protoProxy')?.addEventListener('click', () => run(() => api.protocolProxy({
    slug: cloneState.current,
    target: $('#protoTarget')?.value?.trim() || null,
    port: Number($('#protoPort')?.value) || 8899,
    seconds: Number($('#protoSeconds')?.value) || 8,
  })))
  $('#protoHarGo')?.addEventListener('click', () => {
    const filePath = $('#protoHar')?.value?.trim()
    if (!filePath) { toast('Protocol: enter a HAR path'); return }
    run(() => api.protocolHar({ slug: cloneState.current, path: filePath }))
  })
}

/* ----------------------------------------------------------------- IR */

function renderIRTool() {
  const box = $('#cloneIR')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('Clone IR')
    return
  }
  const ir = cloneState.ir
  const v = cloneState.irValidation
  box.innerHTML = `
    <div class="clone-empty-note">A single reconstruction contract compiled from every observation. Each node keeps
    its evidence and case citations, so generated code and tests never claim more than what was actually seen.</div>
    <div class="clone-deliverable-actions">
      <button class="btn btn-tiny" id="irCompile" ${cloneState.irBusy ? 'disabled' : ''}>
        ${cloneState.irBusy ? 'Compiling...' : 'Compile IR'}
      </button>
      ${ir ? `<span style="font-size:10px;color:var(--text-faint)">${ir.summary.cited}/${ir.summary.nodes} cited nodes</span>` : ''}
    </div>
    ${ir ? `
      <div class="clone-inv-grid">
        <div><span>Target</span><code>${escapeHtml((ir.target.sha256 || ir.target.path || '—').slice(0, 14))}</code></div>
        <div><span>Controls</span><code>${ir.summary.controls}</code></div>
        <div><span>Journeys</span><code>${ir.summary.journeys}</code></div>
        <div><span>Actions</span><code>${ir.summary.actions}</code></div>
        <div><span>Artifacts</span><code>${ir.summary.artifacts}</code></div>
        <div><span>Formats</span><code>${ir.summary.formats}</code></div>
        <div><span>Endpoints</span><code>${ir.summary.endpoints}</code></div>
        <div><span>Cited</span><code>${ir.summary.cited}/${ir.summary.nodes}</code></div>
      </div>
      <div class="clone-section-head"><span>Reconstruction readiness</span></div>
      <div class="clone-ir-status ${v?.readyForScaffold ? 'ready' : 'not-ready'}">
        ${v?.readyForScaffold ? 'Ready to scaffold' : 'Not ready to scaffold'}
      </div>
      ${(v?.errors || []).map((e) => `<div class="clone-ir-error">${escapeHtml(e)}</div>`).join('')}
      ${(v?.warnings || []).map((w) => `<div class="clone-ir-warn">${escapeHtml(w)}</div>`).join('')}
      <div class="clone-section-head"><span>Open unknowns</span></div>
      <div class="clone-control-list">${ir.unknowns.length
        ? ir.unknowns.map((u) => `<div class="clone-control"><span class="clone-control-type">${u.blocking ? 'BLOCK' : 'open'}</span>
          <span class="clone-control-name">${escapeHtml(u.question)}</span><span class="clone-control-parent">${escapeHtml(u.stage || '')}</span></div>`).join('')
        : '<div class="clone-empty-note">No open unknowns.</div>'}</div>`
      : '<div class="clone-empty-note">No IR compiled yet. Click <b>Compile IR</b>.</div>'}`
  wireIRTool()
}

function wireIRTool() {
  $('#irCompile')?.addEventListener('click', async () => {
    if (!cloneState.current || cloneState.irBusy) return
    cloneState.irBusy = true
    renderIRTool()
    try {
      const r = await api.irCompile({ slug: cloneState.current })
      if (!r?.ok) throw new Error(r?.error || 'IR compile failed')
      cloneState.ir = r.ir
      cloneState.irValidation = await api.irValidate({ slug: cloneState.current })
      cloneState.irBusy = false
      await loadClone(true)
      renderIRTool()
      toast(`IR: ${r.ir.summary.nodes} nodes compiled`)
    } catch (e) {
      cloneState.irBusy = false
      renderIRTool()
      toast('Clone IR: ' + e.message)
    }
  })
}

/* --------------------------------------------------------- oracle / shadow */

function renderOracleTool() {
  const box = $('#cloneOracle')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('oracle capture')
    return
  }
  const p = cloneState.detail
  const oracleCases = (p.cases || []).filter((c) => c.provider === 'oracle_native_scenario')
  box.innerHTML = `
    <div class="clone-empty-note">Run the real target with a described input, then replay the same input against a clone
    (or the original again as a determinism self-check). Only observable outputs are compared: exit code, stdout,
    stderr, files and output shape.</div>
    <div class="clone-capture-form">
      <label>Target<input id="oracleTarget" value="${escapeHtml(p.target?.path || '')}" placeholder="path to executable" /></label>
      <label>Arguments<input id="oracleArgv" placeholder="e.g. --input sample.png --verbose" /></label>
      <label>Stdin<input id="oracleStdin" placeholder="optional stdin text" /></label>
      <label>Timeout (ms)<input id="oracleTimeout" type="number" min="100" value="20000" /></label>
      <button class="btn btn-tiny" id="oracleRecord" ${cloneState.oracleBusy ? 'disabled' : ''}>
        ${cloneState.oracleBusy ? 'Running...' : 'Record oracle'}
      </button>
    </div>
    <div class="clone-section-head"><span>Oracle cases (${oracleCases.length})</span></div>
    <div class="clone-control-list">${oracleCases.length ? oracleCases.slice().reverse().map((c) => {
      const changed = (c.parity?.dims || []).filter((d) => d.status === 'changed').map((d) => escapeHtml(d.name)).join(', ')
      return `<div class="clone-control">
        <span class="clone-control-type">${c.parity ? escapeHtml(c.parity.status) : 'unchecked'}</span>
        <span class="clone-control-name">${escapeHtml(c.title || c.id)}</span>
        <span class="clone-control-parent">${c.id}${changed ? ' · ' + changed : ''}</span>
        <span class="clone-control-actions">
          <button class="btn btn-tiny" data-oracle-act="self" data-case="${c.id}" title="Re-run the original to check determinism">Self-check</button>
          <button class="btn btn-tiny" data-oracle-act="shadow" data-case="${c.id}" title="Replay against the clone">Shadow</button>
          <button class="btn btn-tiny" data-oracle-act="raw" data-case="${c.id}" title="Show the raw capture">Raw</button>
        </span>
      </div>`
    }).join('') : '<div class="clone-empty-note">No oracle cases yet. Record one above.</div>'}</div>
    <div class="clone-capture-form">
      <label>Shadow executable<input id="oracleShadow" placeholder="path to clone executable (for Shadow)" /></label>
    </div>`
  wireOracleTool()
}

function wireOracleTool() {
  const busy = async (fn) => {
    if (!cloneState.current || cloneState.oracleBusy) return
    cloneState.oracleBusy = true
    renderOracleTool()
    try {
      const r = await fn()
      if (!r?.ok && r !== true) throw new Error(r?.error || 'oracle operation failed')
      cloneState.oracleBusy = false
      await openClone(cloneState.current, true)
      renderOracleTool()
      toast('Oracle: ' + (r?.parity?.status || r?.case?.id || 'done'))
    } catch (e) {
      cloneState.oracleBusy = false
      renderOracleTool()
      toast('Oracle: ' + e.message)
    }
  }
  $('#oracleRecord')?.addEventListener('click', () => {
    // Capture before busy() re-renders and destroys the form.
    const payload = {
      slug: cloneState.current,
      target: $('#oracleTarget')?.value?.trim() || null,
      argv: $('#oracleArgv')?.value?.trim() || '',
      stdin: $('#oracleStdin')?.value || '',
      timeoutMs: Number($('#oracleTimeout')?.value) || 20000,
    }
    busy(() => api.oracleRecord(payload))
  })
  for (const btn of document.querySelectorAll('#cloneOracle [data-oracle-act]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.case
      const act = btn.dataset.oracleAct
      if (act === 'self') {
        busy(() => api.oracleShadow({ slug: cloneState.current, caseId: id, selfCheck: true }))
      } else if (act === 'shadow') {
        const shadowPath = $('#oracleShadow')?.value?.trim()
        if (!shadowPath) { toast('Oracle: enter a shadow executable path'); return }
        busy(() => api.oracleShadow({ slug: cloneState.current, caseId: id, shadowPath }))
      } else if (act === 'raw') {
        busy(async () => {
          const r = await api.oracleGet({ slug: cloneState.current, caseId: id })
          copyText(JSON.stringify(r?.raw || {}, null, 2))
          return true
        })
      }
    })
  }
}

/* ------------------------------------------------------------------ repair */

function renderRepairTool() {
  const box = $('#cloneRepair')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('repair')
    return
  }
  const data = cloneState.repair || {}
  const plan = data.plan || null
  const summary = plan?.summary || { total: 0, planned: 0, verified: 0, blocked: 0 }
  const cases = plan?.cases || []
  box.innerHTML = `
    <div class="clone-empty-note">Repairs are transcript replays of oracle observations already proven deterministic by a
    self-check. They reproduce exit code, output and captured file effects for one exact input — not the target's
    general logic. Unproven cases become blocking unknowns instead of fake fixes.</div>
    <div class="clone-actions-row">
      <button class="btn btn-tiny" id="repairAnalyze" ${cloneState.repairBusy ? 'disabled' : ''}>
        ${cloneState.repairBusy ? 'Working...' : 'Analyze plan'}
      </button>
      <button class="btn btn-tiny" id="repairApply" ${cloneState.repairBusy ? 'disabled' : ''}>
        Apply repairs
      </button>
      <span class="clone-mini-note">${data.runner ? 'Runner: ' + escapeHtml(data.runner) : 'No runner written yet'}</span>
    </div>
    <div class="clone-section-head"><span>Plan (${summary.total})</span></div>
    <div class="clone-inv-grid">
      <div><strong>Planned</strong><span>${summary.planned}</span></div>
      <div><strong>Verified</strong><span>${summary.verified}</span></div>
      <div><strong>Blocked</strong><span>${summary.blocked}</span></div>
    </div>
    <div class="clone-control-list">${cases.length ? cases.map((c) => `
      <div class="clone-control">
        <span class="clone-control-type">${escapeHtml(c.status)}</span>
        <span class="clone-control-name">${escapeHtml(c.title || c.case)}</span>
        <span class="clone-control-parent">${c.case} · ${c.deterministic ? 'determinism proven' : 'unproven'} · ${(c.repairs || []).length} repairs${c.blockers?.length ? ' · ' + escapeHtml(c.blockers.join(' ')) : ''}</span>
        <span class="clone-control-actions">
          <button class="btn btn-tiny" data-repair-act="verify" data-case="${c.case}" title="Replay the repair and diff it against the oracle">Verify</button>
          <button class="btn btn-tiny" data-repair-act="json" data-case="${c.case}" title="Copy this case's repair plan">JSON</button>
        </span>
      </div>`).join('') : '<div class="clone-empty-note">No repair plan yet. Record an Oracle case and run a Shadow first.</div>'}</div>`
  wireRepairTool()
}

function wireRepairTool() {
  const busy = async (fn) => {
    if (!cloneState.current || cloneState.repairBusy) return
    cloneState.repairBusy = true
    renderRepairTool()
    try {
      const r = await fn()
      if (!r?.ok && r !== true) throw new Error(r?.error || 'repair operation failed')
      // A replay updates parity; refresh the plan so verified state is visible.
      if (r?.parity) await api.repairAnalyze({ slug: cloneState.current })
      cloneState.repairBusy = false
      await openClone(cloneState.current, true)
      renderRepairTool()
      toast('Repair: ' + (r?.parity?.status || r?.status || (r?.summary?.planned ?? 'done')))
    } catch (e) {
      cloneState.repairBusy = false
      renderRepairTool()
      toast('Repair: ' + e.message)
    }
  }
  $('#repairAnalyze')?.addEventListener('click', () => busy(() => api.repairAnalyze({ slug: cloneState.current })))
  $('#repairApply')?.addEventListener('click', () => busy(() => api.repairApply({ slug: cloneState.current })))
  for (const btn of document.querySelectorAll('#cloneRepair [data-repair-act]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.case
      if (btn.dataset.repairAct === 'verify') {
        busy(() => api.oracleShadow({ slug: cloneState.current, caseId: id, repairCase: true }))
      } else {
        const c = (cloneState.repair?.plan?.cases || []).find((x) => x.case === id)
        copyText(JSON.stringify(c || {}, null, 2))
      }
    })
  }
}

/* -------------------------------------------------------------- gap planner */

function renderGapsTool() {
  const box = $('#cloneGaps')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('gap planning')
    return
  }
  const data = cloneState.gaps || {}
  const plan = data.plan || null
  const summary = plan?.summary || { total: 0, blocking: 0, tier: null, measured: 0, byKind: {}, byTool: {} }
  const next = plan?.next || []
  const gaps = plan?.gaps || []
  box.innerHTML = `
    <div class="clone-empty-note">Every item below was produced by a measurement — a parity diff, an unmeasured
    fidelity dimension, a blocking unknown, an uncited IR node or an unimplemented stub. Only re-measuring closes one.</div>
    <div class="clone-actions-row">
      <button class="btn btn-tiny" id="gapsReplan" ${cloneState.gapsBusy ? 'disabled' : ''}>
        ${cloneState.gapsBusy ? 'Working...' : 'Re-plan gaps'}
      </button>
      <button class="btn btn-tiny" id="gapsCopy">Copy plan</button>
    </div>
    <div class="clone-inv-grid">
      <div><strong>Gaps</strong><span>${summary.total}</span></div>
      <div><strong>Blocking</strong><span>${summary.blocking}</span></div>
      <div><strong>Tier</strong><span>${escapeHtml(summary.tier || '—')}</span></div>
      <div><strong>Measured</strong><span>${Math.round((summary.measured || 0) * 100)}%</span></div>
    </div>
    <div class="clone-section-head"><span>Do next (${next.length})</span></div>
    <div class="clone-control-list">${next.length ? next.map((n) => `
      <div class="clone-control">
        <span class="clone-control-type">${n.rank}. ${escapeHtml(n.tool)}</span>
        <span class="clone-control-name">${escapeHtml(n.title)}</span>
        <span class="clone-control-parent">${escapeHtml(n.action)}</span>
        <span class="clone-control-actions">
          <button class="btn btn-tiny" data-gap-open="${escapeHtml(n.tool)}" title="Open the ${escapeHtml(n.tool)} tab">Open</button>
        </span>
      </div>`).join('') : '<div class="clone-empty-note">No gaps queued. Re-plan to measure the current state.</div>'}</div>
    <div class="clone-section-head"><span>All gaps (${gaps.length})</span></div>
    <div class="clone-control-list">${gaps.length ? gaps.map((g) => `
      <div class="clone-control">
        <span class="clone-control-type">${g.severity}${g.blocking ? ' !' : ''}</span>
        <span class="clone-control-name">${escapeHtml(g.title)}</span>
        <span class="clone-control-parent">${escapeHtml(g.kind)} · ${escapeHtml(g.tool)}${g.evidence?.length ? ' · ' + g.evidence.length + ' evidence' : ''}</span>
      </div>`).join('') : '<div class="clone-empty-note">Nothing measured yet.</div>'}</div>`
  wireGapsTool()
}

function wireGapsTool() {
  const busy = async (fn) => {
    if (!cloneState.current || cloneState.gapsBusy) return
    cloneState.gapsBusy = true
    renderGapsTool()
    try {
      const r = await fn()
      if (!r?.ok && r !== true) throw new Error(r?.error || 'gap planning failed')
      cloneState.gapsBusy = false
      await openClone(cloneState.current, true)
      renderGapsTool()
      toast('Gaps: ' + (r?.summary?.total ?? 'done'))
    } catch (e) {
      cloneState.gapsBusy = false
      renderGapsTool()
      toast('Gaps: ' + e.message)
    }
  }
  $('#gapsReplan')?.addEventListener('click', () => busy(() => api.gapsAnalyze({ slug: cloneState.current })))
  $('#gapsCopy')?.addEventListener('click', () => {
    const plan = cloneState.gaps?.plan || {}
    copyText(JSON.stringify({ summary: plan.summary, next: plan.next, gaps: plan.gaps }, null, 2))
  })
  for (const btn of document.querySelectorAll('#cloneGaps [data-gap-open]')) {
    btn.addEventListener('click', () => {
      const tab = document.querySelector(`.tab[data-tab="${btn.dataset.gapOpen}"]`)
      if (tab) tab.click()
      else toast('Gaps: no tab for ' + btn.dataset.gapOpen)
    })
  }
}

/* ------------------------------------------------------------- recipe store */

function renderRecipesTool() {
  const box = $('#cloneRecipes')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('recipes')
    return
  }
  const data = cloneState.recipes || {}
  const recipes = data.recipes || []
  const plan = data.plan || null
  const status = data.status || {}
  box.innerHTML = `
    <div class="clone-empty-note">A recipe records which tools, cases and evidence closed a measured gap. Applying one
    writes a pending plan on the target project — it never executes code and never claims the clone is done.</div>
    <div class="clone-capture-form">
      <label>Recipe name<input id="recipeName" placeholder="e.g. Deterministic console transcript replay" /></label>
      <label>Description<input id="recipeDesc" placeholder="What this procedure achieves" /></label>
      <label>Tags<input id="recipeTags" placeholder="console, transcript, parity" /></label>
      <button class="btn btn-tiny" id="recipeSave" ${cloneState.recipesBusy ? 'disabled' : ''}>
        ${cloneState.recipesBusy ? 'Working...' : 'Save from this project'}
      </button>
    </div>
    <div class="clone-actions-row">
      <button class="btn btn-tiny" id="recipeExport">Export JSON</button>
      <button class="btn btn-tiny" id="recipeImport">Import JSON</button>
      <span class="clone-mini-note">${status.applied ? `Plan ${escapeHtml(status.recipe || '')} · ${status.pending}/${status.steps} pending` : 'No recipe applied to this project'}</span>
    </div>
    <textarea id="recipeImportText" class="clone-import-text" rows="3" placeholder="Paste exported recipe JSON here, then click Import JSON"></textarea>
    <div class="clone-section-head"><span>Saved recipes (${recipes.length})</span></div>
    <div class="clone-control-list">${recipes.length ? recipes.map((r) => `
      <div class="clone-control">
        <span class="clone-control-type">${escapeHtml(r.tier || 'no tier')}</span>
        <span class="clone-control-name">${escapeHtml(r.name)}</span>
        <span class="clone-control-parent">${escapeHtml((r.tools || []).join(' → ') || 'no tools')} · ${r.cases || 0} cases · ${r.evidence || 0} evidence</span>
        <span class="clone-control-actions">
          <button class="btn btn-tiny" data-recipe-act="apply" data-id="${escapeHtml(r.id)}" title="Apply this recipe as a pending plan">Apply</button>
          <button class="btn btn-tiny" data-recipe-act="copy" data-id="${escapeHtml(r.id)}" title="Copy recipe JSON">JSON</button>
          <button class="btn btn-tiny" data-recipe-act="delete" data-id="${escapeHtml(r.id)}" title="Delete this recipe">&#10005;</button>
        </span>
      </div>`).join('') : '<div class="clone-empty-note">No recipes saved yet.</div>'}</div>
    ${plan ? `<div class="clone-section-head"><span>Applied plan (${(plan.steps || []).length} steps)</span></div>
    <div class="clone-control-list">${(plan.steps || []).map((s) => `
      <div class="clone-control">
        <span class="clone-control-type">${escapeHtml(s.status)}</span>
        <span class="clone-control-name">${s.index}. ${escapeHtml(s.tool)}</span>
        <span class="clone-control-parent">${escapeHtml(s.action)} · ${escapeHtml(s.verify)}</span>
      </div>`).join('')}</div>` : ''}`
  wireRecipesTool()
}

function wireRecipesTool() {
  const busy = async (fn) => {
    if (!cloneState.current || cloneState.recipesBusy) return
    const name = $('#recipeName')?.value?.trim()
    const description = $('#recipeDesc')?.value?.trim()
    const tags = $('#recipeTags')?.value?.trim()
    cloneState.recipesBusy = true
    renderRecipesTool()
    try {
      const r = await fn({ name, description, tags })
      if (!r?.ok && r !== true) throw new Error(r?.error || 'recipe operation failed')
      cloneState.recipesBusy = false
      await openClone(cloneState.current, true)
      renderRecipesTool()
      toast('Recipes: ' + (r?.recipe?.name || r?.status?.recipe || 'done'))
    } catch (e) {
      cloneState.recipesBusy = false
      renderRecipesTool()
      toast('Recipes: ' + e.message)
    }
  }
  $('#recipeSave')?.addEventListener('click', () => busy((fields) => api.recipesSave({
    slug: cloneState.current,
    name: fields.name || undefined,
    description: fields.description,
    tags: fields.tags ? fields.tags.split(/[,\s]+/).filter(Boolean) : [],
  })))
  $('#recipeExport')?.addEventListener('click', async () => {
    const r = await api.recipesExport()
    copyText(r?.text || '')
  })
  $('#recipeImport')?.addEventListener('click', async () => {
    const text = $('#recipeImportText')?.value || ''
    if (!text.trim()) { toast('Recipes: paste JSON first'); return }
    const r = await api.recipesImport({ text })
    toast(r?.ok ? `Recipes: imported ${r.imported}` : 'Recipes: ' + (r?.error || 'import failed'))
    if (r?.ok) await openClone(cloneState.current, true)
  })
  for (const btn of document.querySelectorAll('#cloneRecipes [data-recipe-act]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const act = btn.dataset.recipeAct
      if (act === 'apply') {
        busy(() => api.recipesApply({ slug: cloneState.current, id }))
      } else if (act === 'delete') {
        busy(() => api.recipesDelete({ id }))
      } else {
        const r = cloneState.recipes?.recipes?.find((x) => x.id === id)
        copyText(JSON.stringify(r || {}, null, 2))
      }
    })
  }
}

/* ------------------------------------------------ fingerprint / drift detector */

function renderFingerprintTool() {
  const box = $('#cloneFingerprint')
  if (!box) return
  if (!cloneState.detail) {
    box.innerHTML = emptyProjectNote('behavior fingerprinting')
    return
  }
  const data = cloneState.fingerprint || {}
  const fp = data.fingerprint || null
  const drift = data.drift || null
  const cases = drift?.cases || fp?.cases || []
  const tail = (drift?.target
    ? `<div class="clone-mini-note">Target: ${escapeHtml(drift.target.status)} · ${escapeHtml(drift.target.sha256?.slice(0, 12) || 'no hash')}</div>`
    : '') + (fp
      ? `<div class="clone-mini-note">Fingerprint source: ${escapeHtml(fp.honesty || '')}</div>`
      : '')
  box.innerHTML = `
    <div class="clone-empty-note">A fingerprint digests behaviour that was actually measured — exit codes, output,
    steps and file effects. Drift detection re-runs the original target with the same input and reports each changed
    dimension as match, changed, error or unavailable. It never repairs anything silently.</div>
    <div class="clone-actions-row">
      <button class="btn btn-tiny" id="fpBuild" ${cloneState.fingerprintBusy ? 'disabled' : ''}>
        ${cloneState.fingerprintBusy ? 'Working...' : 'Build fingerprint'}
      </button>
      <button class="btn btn-tiny" id="fpDrift" ${cloneState.fingerprintBusy ? 'disabled' : ''}>
        Check drift
      </button>
      <button class="btn btn-tiny" id="fpCopy">Copy JSON</button>
    </div>
    <div class="clone-inv-grid">
      <div><strong>Fingerprint</strong><span>${fp ? escapeHtml(fp.digest?.slice(0, 12) || '—') : '—'}</span></div>
      <div><strong>Cases</strong><span>${fp?.summary?.cases ?? 0}</span></div>
      <div><strong>Steps</strong><span>${fp?.summary?.steps ?? 0}</span></div>
      <div><strong>Drift</strong><span>${drift ? escapeHtml(drift.status) : 'unchecked'}</span></div>
      <div><strong>Changed</strong><span>${drift?.summary?.changed ?? 0}</span></div>
      <div><strong>Errors</strong><span>${drift?.summary?.error ?? 0}</span></div>
    </div>
    <div class="clone-section-head"><span>Cases (${cases.length})</span></div>
    <div class="clone-control-list">${cases.length ? cases.map((c) => `
      <div class="clone-control">
        <span class="clone-control-type">${escapeHtml(c.status || 'measured')}</span>
        <span class="clone-control-name">${escapeHtml(c.title || c.case)}</span>
        <span class="clone-control-parent">${escapeHtml(c.case)}${c.expectedDigest ? ' · ' + escapeHtml(c.expectedDigest.slice(0, 10)) : ''}${c.detail ? ' · ' + escapeHtml(c.detail) : ''}</span>
      </div>`).join('') : '<div class="clone-empty-note">No fingerprint yet. Record Oracle cases, then build one.</div>'}</div>
    ${tail}`
  wireFingerprintTool()
}

function wireFingerprintTool() {
  const busy = async (fn) => {
    if (!cloneState.current || cloneState.fingerprintBusy) return
    cloneState.fingerprintBusy = true
    renderFingerprintTool()
    try {
      const r = await fn()
      if (!r?.ok && r !== true) throw new Error(r?.error || 'fingerprint operation failed')
      cloneState.fingerprintBusy = false
      await openClone(cloneState.current, true)
      renderFingerprintTool()
      toast('Fingerprint: ' + (r?.status || r?.fingerprint?.digest?.slice(0, 12) || 'done'))
    } catch (e) {
      cloneState.fingerprintBusy = false
      renderFingerprintTool()
      toast('Fingerprint: ' + e.message)
    }
  }
  $('#fpBuild')?.addEventListener('click', () => busy(() => api.fingerprintBuild({ slug: cloneState.current })))
  $('#fpDrift')?.addEventListener('click', () => busy(() => api.fingerprintDrift({ slug: cloneState.current })))
  $('#fpCopy')?.addEventListener('click', () => {
    const d = cloneState.fingerprint || {}
    copyText(JSON.stringify({ fingerprint: d.fingerprint, drift: d.drift }, null, 2))
  })
}

function renderCloneDetail() {
  renderCloneProjectDetail()
  renderRecorderDetail()
  renderParityDetail()
  renderSpecDetail()
  renderScoreDetail()
  renderFactsDetail()
  renderUiMapTool()
  renderGuiTool()
  renderArtifactsTool()
  renderExploreTool()
  renderFormatsTool()
  renderProtocolTool()
  renderIRTool()
  renderOracleTool()
  renderRepairTool()
  renderGapsTool()
  renderRecipesTool()
  renderFingerprintTool()
  renderClonePickers()
}


async function generate(kind) {
  if (!cloneState.current || cloneState.generating) return
  cloneState.generating = kind
  renderCloneDetail(true)
  try {
    const res =
      kind === 'spec'
        ? await api.cloneCompileSpec({ slug: cloneState.current })
        : await api.cloneScaffold({ slug: cloneState.current, language: cloneState.language })
    if (!res?.ok) throw new Error(res?.error || kind + ' failed')
    const count = res.result?.written?.length ?? 0
    toast(
      kind === 'spec'
        ? `Spec compiled: ${count} file${count === 1 ? '' : 's'}`
        : `Scaffolded ${res.result?.language || cloneState.language}: ${count} file${count === 1 ? '' : 's'}`,
    )
  } catch (e) {
    toast((kind === 'spec' ? 'Compile spec failed: ' : 'Scaffold failed: ') + e.message)
  } finally {
    cloneState.generating = null
    await openClone(cloneState.current, true)
  }
}

async function openArtifact(file) {
  if (!file) return
  const res = await api.cloneOpenArtifact({ slug: cloneState.current, file })
  if (!res?.ok) toast('Open artifact failed: ' + (res?.error || 'unknown'))
}

async function caseAction(id, act, project, btn) {
  if (act === 'replay') {
    if (btn) {
      btn.disabled = true
      btn.textContent = 'Running…'
    }
    try {
      const res = await api.cloneReplayCase({ slug: cloneState.current, id })
      if (!res?.ok) throw new Error(res?.error || 'replay failed')
      if (res.cliOk) toast('Parity: ' + (res.parity?.status || 'unknown'))
      else toast('Replay failed: ' + (res.error || res.parity?.note || 'see case file'))
    } catch (e) {
      toast('Replay failed: ' + e.message)
    } finally {
      await openClone(cloneState.current, true)
      await loadClone(true)
    }
    return
  }
  if (act === 'delete') {
    if (!confirm('Delete this recorded journey?')) return
    const res = await api.cloneDeleteCase({ slug: cloneState.current, id })
    if (!res?.ok) return toast('Delete failed: ' + (res?.error || 'unknown'))
    await openClone(cloneState.current, true)
    await loadClone(true)
    return
  }
  const res = await api.cloneGetCase({ slug: cloneState.current, id })
  if (!res?.ok) return toast('Read case failed: ' + (res?.error || 'unknown'))
  if (act === 'copy') {
    const text = JSON.stringify(res.case.request ?? {}, null, 2)
    await copyText(text)
    return
  }
  const dir = project?.paths?.dir || cloneState.root
  api.reveal(dir + '\\cases\\' + id + '.json')
}

async function addUnknownFromInput() {
  const input = $('#cloneUnknownInput')
  const question = input?.value?.trim()
  if (!question) return
  const res = await api.cloneAddUnknown({ slug: cloneState.current, unknown: { question, blocking: true } })
  if (!res?.ok) return toast('Add unknown failed: ' + (res?.error || 'unknown'))
  input.value = ''
  await openClone(cloneState.current, true)
  await loadClone(true)
}

async function stageAction(stage, act) {
  const patch =
    act === 'complete'
      ? { status: 'complete' }
      : act === 'start'
        ? { status: 'active' }
        : act === 'blocked'
          ? { status: 'blocked' }
          : act === 'reopen'
            ? { status: 'active' }
            : null
  if (act === 'ask') {
    askAgentAboutStage(stage)
    return
  }
  const res = await api.cloneSetStage({ slug: cloneState.current, stage, patch })
  if (!res?.ok) return toast(res?.error || 'Stage update failed')
  await openClone(cloneState.current, true)
  await loadClone(true)
}

function askAgentAboutStage(stage) {
  const p = cloneState.detail
  if (!p) return
  const def = (p.stageBoard || []).find((s) => s.id === stage)
  const open = (p.unknowns || []).filter((u) => u.status === 'open' && (!u.stage || u.stage === stage))
  const text = [
    `Clone project: ${p.name} (${p.slug})`,
    p.target ? `Target: ${p.target.path}${p.target.sha256 ? ` (sha256 ${p.target.sha256})` : ''}` : 'Target: not set',
    `Stage: ${def?.title} — ${def?.goal}`,
    def?.detail ? `Stage scope: ${def.detail}` : '',
    open.length ? `Open unknowns to resolve:\n${open.map((u) => `- ${u.question}`).join('\n')}` : '',
    `Work only this stage. Record every unresolved question with the clone_add_unknown flow, and cite evidence IDs for each claim.`,
  ]
    .filter(Boolean)
    .join('\n\n')
  activateTab('activity')
  askAgent(text)
}

async function unknownAction(id, act) {
  let res
  if (act === 'delete') {
    res = await api.cloneRemoveUnknown({ slug: cloneState.current, id })
  } else {
    let patch =
      act === 'close'
        ? { status: 'closed' }
        : act === 'reopen'
          ? { status: 'open', resolution: '' }
          : null
    if (act === 'toggle-block') {
      const u = (cloneState.detail?.unknowns || []).find((x) => x.id === id)
      patch = { blocking: !u?.blocking }
    }
    res = await api.cloneUpdateUnknown({ slug: cloneState.current, id, patch })
  }
  if (!res?.ok) return toast('Unknown update failed: ' + (res?.error || 'unknown'))
  await openClone(cloneState.current, true)
  await loadClone(true)
}

/* ---------------------------------------------------------------- recorder */

function parseOutput(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return text.slice(0, 4000)
  try {
    return JSON.parse(text)
  } catch {
    return text.slice(0, 4000)
  }
}

async function handleCloneEvent(raw) {
  if (!cloneState.armed || !cloneState.current) return
  const event = raw && raw.payload && raw.payload.type ? raw.payload : raw
  if (!event || event.type !== 'message.part.updated') return
  const part = event.properties?.part
  if (!part || part.type !== 'tool') return
  const tool = part.tool || ''
  if (!RECORDABLE.test(tool)) return
  const st = part.state || {}
  if (st.status !== 'completed') return
  const key = part.callID || part.id
  if (!key || cloneState.seenCalls.has(key)) return
  cloneState.seenCalls.add(key)
  try {
    const res = await api.cloneAddCase({
      slug: cloneState.current,
      testCase: { tool, input: st.input ?? null, output: parseOutput(st.output), status: st.status },
    })
    if (!res?.ok) throw new Error(res?.error || 'record failed')
    if (cloneState.detail) {
      await openClone(cloneState.current, true)
      await loadClone(true)
    }
    toast('Recorded journey: ' + (res.case?.title || tool))
  } catch (e) {
    toast('Record failed: ' + e.message)
  }
}

function toggleArmed() {
  if (!cloneState.current) {
    toast('Open a clone project first')
    return
  }
  cloneState.armed = !cloneState.armed
  renderCloneDetail(true)
  toast(cloneState.armed ? 'Recording capture calls into this project' : 'Recording stopped')
}

function guideJourney(kind) {
  const p = cloneState.detail
  if (!p) return
  const target = p.target?.path
  const tool =
    kind === 'browser'
      ? 'capture_browser_scenario'
      : kind === 'electron'
        ? 'capture_electron_scenario'
        : kind === 'native'
          ? 'capture_native_ui_scenario'
          : 'capture_process_scenario'
  const text = [
    `Clone project: ${p.name} (${p.slug}).`,
    target ? `Target: ${target}` : 'Target: not set — ask before choosing one.',
    `Record one user journey with ${tool}.`,
    'Keep it bounded: the smallest sequence that covers one meaningful user action end to end.',
    'The app records your tool call as a replayable case, so pass the exact input you want replayed and report the evidence IDs you get back.',
    'If something in the journey is unclear or untested, add it to the clone unknown ledger instead of guessing.',
  ].join('\n\n')
  activateTab('activity')
  askAgent(text)
}

/* ------------------------------------------------------------------ create */async function startCreate() {
  cloneState.creating = true
  cloneState.target = null
  renderCloneList()
  $('#clonePickTarget')?.addEventListener('click', async () => {
    const file = await api.pickFile({ title: 'Select the target to clone' })
    if (!file) return
    cloneState.target = file
    const label = $('#cloneTargetLabel')
    if (label) {
      label.textContent = file.split(/[\\/]/).pop()
      label.title = file
    }
    const nameInput = $('#cloneNewName')
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
    }
  })
  $('#cloneCreateCancel')?.addEventListener('click', () => {
    cloneState.creating = false
    cloneState.target = null
    renderCloneList()
  })
  $('#cloneCreateGo')?.addEventListener('click', async () => {
    const name = $('#cloneNewName')?.value?.trim() || null
    const res = await api.cloneCreate({ name, targetPath: cloneState.target })
    if (!res?.ok) return toast('Create failed: ' + (res?.error || 'unknown'))
    cloneState.creating = false
    const slug = res.project.slug
    if (cloneState.target) await api.cloneSetTarget({ slug, targetPath: cloneState.target })
    cloneState.target = null
    cloneState.current = slug
    await loadClone(true)
    await openClone(slug)
    toast('Clone project created')
  })
  $('#cloneNewName')?.focus()
}

/* -------------------------------------------------------------- auto clone */

function renderAutoProgress() {
  const box = $('#autoProgress')
  if (!box) return
  const rows = [...cloneState.autoProgress.values()].map((p) =>
    `<div class="auto-progress-row ${escapeHtml(p.status || '')}">
       <span class="auto-step-title">${escapeHtml(p.title || p.id || '')}</span>
       <span class="auto-status ${escapeHtml(p.status || '')}">${escapeHtml(p.status || '')}</span>
       <span class="auto-step-detail">${escapeHtml(p.detail || '')}</span>
     </div>`,
  ).join('')
  box.innerHTML = rows || '<div class="clone-empty-note">No steps have run yet.</div>'
}

function autoReportHtml(report) {
  const p = report.project || {}
  const s = report.summary || {}
  const f = s.fidelity || {}
  const g = s.gaps || {}
  const steps = (report.steps || []).map((st, i) =>
    `<div class="auto-step">
       <span class="auto-step-num">${i + 1}</span>
       <span>${escapeHtml(st.title)}</span>
       <span class="auto-status ${escapeHtml(st.status)}">${escapeHtml(st.status)}</span>
       <span class="auto-step-detail">${escapeHtml(st.detail || '')}</span>
     </div>`,
  ).join('')
  return `<div class="auto-report">
    <div class="clone-section-head">
      <span>Last run</span>
      ${p.slug ? '<button class="btn btn-tiny" id="autoOpenProject">Open project</button>' : ''}
    </div>
    <div class="auto-summary">
      <span>status <b>${escapeHtml(s.status || 'unknown')}</b></span>
      <span>project <b>${escapeHtml(p.slug || '—')}</b></span>
      <span>fidelity <b>${f.score === undefined ? '—' : (Number(f.score) * 100).toFixed(1) + '%'}</b></span>
      <span>tier <b>${escapeHtml(f.tier || '—')}</b></span>
      <span>gaps <b>${g.total === undefined ? '—' : g.total + ' / ' + g.blocking + ' blocking'}</b></span>
    </div>
    <div class="auto-steps">${steps}</div>
  </div>`
}

function renderAuto() {
  const root = $('#cloneAuto')
  if (!root) return
  const target = cloneState.autoTarget || ''
  const report = cloneState.autoReport
  root.innerHTML = `
    <div class="clone-empty-note">
      Auto Clone runs the measured pipeline in dependency order: inventory, bounded GUI/process captures,
      Oracle and self-check, repair only when determinism is proven, then IR, spec, scaffold, parity and gaps.
      A step that cannot observe the target is reported as unavailable; it is never counted as success.
    </div>
    <div class="auto-fields">
      <div>
        <div class="auto-field-label">Executable</div>
        <div class="auto-row">
          <input id="autoTargetPath" class="auto-input" readonly value="${escapeHtml(target)}" placeholder="No executable chosen" />
          <button class="btn btn-tiny" id="autoPickTarget">Choose exe…</button>
        </div>
      </div>
      <div>
        <div class="auto-field-label">Project name (optional)</div>
        <input id="autoName" class="auto-input" placeholder="Defaults to the executable name" />
      </div>
      <div class="auto-options">
        <div>
          <div class="auto-field-label">GUI capture seconds</div>
          <input id="autoSeconds" class="auto-input" type="number" min="1" max="30" value="5" />
        </div>
        <div>
          <div class="auto-field-label">Oracle timeout (ms)</div>
          <input id="autoTimeout" class="auto-input" type="number" min="1000" max="120000" step="1000" value="20000" />
        </div>
      </div>
    </div>
    <div class="clone-detail-head">
      <button class="btn btn-tiny" id="autoRun" ${cloneState.autoBusy ? 'disabled' : ''}>${cloneState.autoBusy ? 'Running…' : 'Run auto clone'}</button>
      <span class="clone-card-sub">${cloneState.autoBusy ? 'Bounded launches — keep the app open' : 'Creates a new project each run'}</span>
    </div>
    <div id="autoProgress" class="auto-progress"></div>
    ${report ? autoReportHtml(report) : ''}
  `
  renderAutoProgress()
}

function updateAutoProgress(payload) {
  if (!payload) return
  if (payload.type === 'start') {
    cloneState.autoProgress = new Map()
    renderAutoProgress()
    return
  }
  if (payload.type === 'step') {
    cloneState.autoProgress.set(payload.id, {
      id: payload.id,
      title: payload.title || payload.id,
      status: payload.phase === 'start' ? 'running' : payload.status,
      detail: payload.phase === 'start' ? '…' : payload.detail || '',
    })
    renderAutoProgress()
    return
  }
  if (payload.type === 'done') {
    const button = $('#autoRun')
    if (button) {
      button.disabled = false
      button.textContent = 'Run auto clone'
    }
  }
}

async function refreshAuto() {
  try {
    const res = await api.autoGet({})
    if (res?.ok && res.report) cloneState.autoReport = res.report
  } catch { /* older app build without auto:get */ }
  renderAuto()
}

async function runAutoCloneUi() {
  if (cloneState.autoBusy) return
  if (!cloneState.autoTarget) {
    toast('Choose an executable first')
    return
  }
  const name = $('#autoName')?.value?.trim() || null
  const seconds = Number($('#autoSeconds')?.value) || 5
  const timeoutMs = Number($('#autoTimeout')?.value) || 20000
  cloneState.autoBusy = true
  cloneState.autoReport = null
  cloneState.autoProgress = new Map()
  renderAuto()
  try {
    const res = await api.autoRun({
      targetPath: cloneState.autoTarget,
      name,
      seconds,
      protocolSeconds: Math.max(8, seconds),
      timeoutMs,
    })
    if (!res?.ok) throw new Error(res?.error || 'auto:run failed')
    cloneState.autoReport = res
    toast('Auto clone ' + (res.summary?.status || 'finished'))
    await loadClone(true)
    if (res.project?.slug) {
      cloneState.current = res.project.slug
      await openClone(res.project.slug, true)
    }
  } catch (e) {
    toast('Auto clone failed: ' + e.message)
  } finally {
    cloneState.autoBusy = false
    renderAuto()
  }
}

/* -------------------------------------------------------------------- wire */

function wireCloneUi() {
  $('#cloneNew')?.addEventListener('click', () => {
    if (cloneState.creating) {
      cloneState.creating = false
      renderCloneList()
    } else {
      startCreate()
    }
  })
  $('#cloneRefresh')?.addEventListener('click', () => loadClone(true))
  $('#cloneList')?.addEventListener('click', (e) => {
    if (e.target.closest('#cloneCreateCard')) return
    const card = e.target.closest('.clone-card[data-slug]')
    if (card) openClone(card.dataset.slug)
  })
  $$('.tab').forEach((tab) => {
    if (['auto', 'clone', 'recorder', 'parity', 'spec', 'score', 'facts', 'uimap', 'artifacts', 'explore', 'formats', 'protocol', 'ir', 'oracle', 'repair', 'gaps', 'recipes', 'fingerprint'].includes(tab.dataset.tab)) {
      tab.addEventListener('click', () => loadClone())
    }
  })
  $$('.clone-project-pick').forEach((sel) =>
    sel.addEventListener('change', () => {
      if (sel.value) openClone(sel.value)
    }),
  )
  $$('[data-clone-tool]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      activateTab(btn.dataset.cloneTool)
      loadClone()
    }),
  )
  $('#cloneAuto')?.addEventListener('click', async (e) => {
    if (e.target.closest('#autoPickTarget')) {
      const file = await api.pickFile({
        title: 'Select an executable to clone',
        filters: [
          { name: 'Executables', extensions: ['exe', 'com', 'msi'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!file) return
      cloneState.autoTarget = file
      const pathInput = $('#autoTargetPath')
      if (pathInput) pathInput.value = file
      const nameInput = $('#autoName')
      if (nameInput && !nameInput.value.trim()) {
        nameInput.value = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
      }
      return
    }
    if (e.target.closest('#autoRun')) {
      await runAutoCloneUi()
      return
    }
    if (e.target.closest('#autoOpenProject')) {
      const slug = cloneState.autoReport?.project?.slug
      if (slug) {
        cloneState.current = slug
        await openClone(slug)
        activateTab('clone')
      }
    }
  })
  try {
    api.onAutoProgress?.(updateAutoProgress)
  } catch { }
  try {
    api.onEvent(handleCloneEvent)
  } catch { }
}

/* Called by app.js whenever the agent answer contains ev_ IDs. */
window.cloneRecordEvidence = function cloneRecordEvidence(ids, source, raw) {
  if (!cloneState.current || !ids?.length) return
  api
    .cloneCaptureEvidence({ slug: cloneState.current, ids, source, raw })
    .then((res) => {
      if (!res?.ok) return
      if (cloneState.detail && res.capture?.added) loadClone(true)
    })
    .catch(() => {})
}

wireCloneUi()
refreshAuto()
loadClone()
