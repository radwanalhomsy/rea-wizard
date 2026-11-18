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
}

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
}

async function openClone(slug, keepScroll = false) {
  try {
    const res = await api.cloneGet({ slug })
    if (!res?.ok || !res.project) throw new Error(res?.error || 'project not found')
    cloneState.current = slug
    cloneState.detail = res.project
    renderCloneList()
    renderCloneDetail(keepScroll)
  } catch (e) {
    toast('Open project: ' + e.message)
  }
}

function renderCloneDetail() {
  const box = $('#cloneDetail')
  if (!box) return
  const p = cloneState.detail
  if (!p) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false

  const target = p.target
  const targetLine = target
    ? `${escapeHtml(target.path)}<br><span style="color:var(--text-faint)">${
        target.sha256 ? 'sha256 ' + target.sha256.slice(0, 16) + '…' : 'not hashed'
      } · ${bytes(target.size)} · ${escapeHtml(target.kind || 'kind unknown')}</span>`
    : 'No target recorded yet.'

  const stages = (p.stageBoard || [])
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
          <span class="clone-stage-num">${status === 'complete' ? '✓' : i + 1}</span>
          <span class="clone-stage-title">${escapeHtml(s.title)}</span>
          <span class="clone-stage-goal">${escapeHtml(s.goal)}</span>
        </div>
        <div class="clone-stage-detail">${escapeHtml(s.detail)}${s.note ? ' — ' + escapeHtml(s.note) : ''}</div>
        <div class="clone-stage-actions">
          ${startBtn}${completeBtn}${blockBtn}
          <button class="btn btn-tiny" data-stage-act="ask" data-stage="${s.id}" title="Ask the agent to work this stage">Ask agent</button>
        </div>
        ${gateHtml}
      </div>`
    })
    .join('')

  const unknowns = (p.unknowns || []).slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
    return String(b.createdAt).localeCompare(String(a.createdAt))
  })

  const unknownHtml = unknowns.length
    ? unknowns
        .map((u) => {
          const cls = ['clone-unknown', u.status === 'closed' ? 'closed' : '', u.blocking && u.status === 'open' ? 'blocking' : '']
            .filter(Boolean)
            .join(' ')
          const act =
            u.status === 'open'
              ? `<button class="btn btn-tiny" data-un-act="close" data-un="${u.id}" title="Resolve this unknown">Resolve</button>`
              : `<button class="btn btn-tiny" data-un-act="reopen" data-un="${u.id}" title="Reopen">Reopen</button>`
          return `<div class="${cls}">
            <div class="clone-unknown-body">
              <div class="clone-unknown-q">${escapeHtml(u.question)}</div>
              <div class="clone-unknown-meta">${escapeHtml(u.stage || 'any stage')} · ${
                u.blocking ? 'blocking' : 'non-blocking'
              }${u.evidence ? ' · ' + escapeHtml(u.evidence) : ''}${
                u.resolution ? ' · ' + escapeHtml(u.resolution) : ''
              } · ${ago(u.createdAt)}</div>
            </div>
            <div class="clone-unknown-actions">
              ${act}
              <button class="btn btn-tiny" data-un-act="toggle-block" data-un="${u.id}" title="Toggle blocking">${
                u.blocking ? 'Unblock' : 'Block'
              }</button>
              <button class="btn btn-tiny" data-un-act="delete" data-un="${u.id}" title="Remove">✕</button>
            </div>
          </div>`
        })
        .join('')
    : '<div class="clone-empty-note">No open questions recorded. Every unresolved finding belongs here so a stage cannot quietly "finish".</div>'

  const evidence = (p.evidence || []).slice(-8).reverse()
  const evidenceHtml = evidence.length
    ? evidence
        .map(
          (e) =>
            `<div class="clone-unknown"><div class="clone-unknown-body"><div class="clone-unknown-q">${escapeHtml(
              e.id,
            )}</div><div class="clone-unknown-meta">${escapeHtml(e.stage || 'unassigned')} · ${escapeHtml(
              e.source || 'agent',
            )} · ${ago(e.capturedAt)}${e.file ? ' · snapshot saved' : ''}</div></div></div>`,
        )
        .join('')
    : '<div class="clone-empty-note">Evidence IDs found in agent answers are recorded here automatically while this project is selected.</div>'

  box.innerHTML = `
    <div class="clone-detail-head">
      <span class="clone-detail-title">${escapeHtml(p.name)}</span>
      <span class="clone-head-actions">
        <button class="btn btn-tiny" id="cloneOpenFolder" title="Show the project folder">Folder</button>
        <button class="btn btn-tiny" id="cloneDelete" title="Delete this project folder">Delete</button>
      </span>
    </div>
    <div class="clone-target">${targetLine}</div>
    <div class="clone-section-head"><span>Stages</span><span style="font-size:10px">${(p.stageBoard || []).filter((s) => s.status === 'complete').length}/6 done</span></div>
    <div>${stages}</div>
    <div class="clone-section-head"><span>Unknowns</span><span style="font-size:10px">${
      (p.unknowns || []).filter((u) => u.status === 'open').length
    } open</span></div>
    <div class="clone-unknowns">${unknownHtml}</div>
    <div class="clone-unknown-form">
      <input id="cloneUnknownInput" placeholder="What is still unknown about this target?" />
      <button class="btn btn-tiny" id="cloneUnknownAdd">Add</button>
    </div>
    <div class="clone-section-head"><span>Evidence</span><span style="font-size:10px">${(p.evidence || []).length} total</span></div>
    <div class="clone-unknowns">${evidenceHtml}</div>
    <div class="clone-section-head"><span>Recent activity</span></div>
    <div class="clone-unknowns">${(p.log || [])
      .slice(-6)
      .reverse()
      .map(
        (l) =>
          `<div class="clone-empty-note">${ago(l.at)} · ${escapeHtml(l.event)} · ${escapeHtml(l.detail || '')}</div>`,
      )
      .join('')}</div>
  `

  wireCloneDetail(p)
}

function wireCloneDetail(p) {
  $('#cloneOpenFolder')?.addEventListener('click', () => api.reveal(p.paths?.dir || cloneState.root))
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

/* ------------------------------------------------------------------ create */

async function startCreate() {
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
    if (tab.dataset.tab === 'clone') tab.addEventListener('click', () => loadClone())
  })
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
