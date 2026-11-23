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
  scoreBusy: false,
  factsBusy: false,
  language: 'typescript',
  generating: null, // 'spec' | 'scaffold' while a run is in flight
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
    const [res, arts, score, facts] = await Promise.all([
      api.cloneGet({ slug }),
      api.cloneArtifacts({ slug }),
      api.fidelityGet({ slug }),
      api.factsList({ slug }),
    ])
    if (!res?.ok || !res.project) throw new Error(res?.error || 'project not found')
    cloneState.current = slug
    cloneState.detail = res.project
    cloneState.artifacts = arts?.ok ? arts.artifacts || [] : []
    cloneState.fidelity = score?.ok ? score.score : null
    cloneState.facts = facts?.ok ? facts.facts || [] : []
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
      const actions = parityMode
        ? `<button class="btn btn-tiny" data-case-act="replay" data-case="${c.id}" title="Re-run the exact recorded request and diff it against the original">Replay</button>
           <button class="btn btn-tiny" data-case-act="json" data-case="${c.id}" title="Show the recorded case file">JSON</button>
           <button class="btn btn-tiny" data-case-act="copy" data-case="${c.id}" title="Copy the replay request">Copy</button>`
        : `<button class="btn btn-tiny" data-case-act="replay" data-case="${c.id}" title="Re-run the exact recorded request and diff it against the original">Replay</button>
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

function renderCloneDetail() {
  renderCloneProjectDetail()
  renderRecorderDetail()
  renderParityDetail()
  renderSpecDetail()
  renderScoreDetail()
  renderFactsDetail()
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
    if (['clone', 'recorder', 'parity', 'spec', 'score', 'facts'].includes(tab.dataset.tab)) {
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
loadClone()
