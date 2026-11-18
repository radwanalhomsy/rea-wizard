const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('rea', {
  /* app / settings */
  state: () => invoke('app:state'),
  setWorkspace: (dir) => invoke('app:setWorkspace', dir),
  setModel: (model) => invoke('app:setModel', model),
  setAgent: (agent) => invoke('app:setAgent', agent),

  /* dialogs + filesystem */
  pickFile: (opts) => invoke('dialog:file', opts),
  pickFiles: (opts) => invoke('dialog:files', opts),
  pickFolder: () => invoke('dialog:folder'),
  pickSave: (opts) => invoke('dialog:save', opts),
  saveText: (payload) => invoke('file:saveText', payload),
  checkPath: (p) => invoke('path:check', p),
  reveal: (p) => invoke('shell:reveal', p),
  openExternal: (url) => invoke('shell:openExternal', url),
  saveTranscript: (payload) => invoke('transcript:save', payload),

  /* REA */
  health: () => invoke('rea:health'),
  doctor: () => invoke('rea:doctor'),
  reaRun: (payload) => invoke('rea:run', payload),
  reaCancel: () => invoke('rea:cancel'),
  workflows: (force) => invoke('rea:workflows', force),
  capabilities: (force) => invoke('rea:capabilities', force),
  commands: (force) => invoke('rea:commands', force),
  catalog: () => invoke('rea:catalog'),
  reaVersion: () => invoke('rea:version'),

  /* clone projects */
  cloneList: () => invoke('clone:list'),
  cloneCreate: (payload) => invoke('clone:create', payload),
  cloneGet: (payload) => invoke('clone:get', payload),
  cloneDelete: (payload) => invoke('clone:delete', payload),
  cloneUpdate: (payload) => invoke('clone:update', payload),
  cloneSetStage: (payload) => invoke('clone:setStage', payload),
  cloneSetTarget: (payload) => invoke('clone:setTarget', payload),
  cloneAddUnknown: (payload) => invoke('clone:addUnknown', payload),
  cloneUpdateUnknown: (payload) => invoke('clone:updateUnknown', payload),
  cloneRemoveUnknown: (payload) => invoke('clone:removeUnknown', payload),
  cloneAddEvidence: (payload) => invoke('clone:addEvidence', payload),
  cloneCaptureEvidence: (payload) => invoke('clone:captureEvidence', payload),
  cloneAddCase: (payload) => invoke('clone:addCase', payload),
  cloneGetCase: (payload) => invoke('clone:getCase', payload),
  cloneDeleteCase: (payload) => invoke('clone:deleteCase', payload),
  cloneReplayCase: (payload) => invoke('clone:replayCase', payload),

  /* OpenCode */
  bootstrap: () => invoke('oc:bootstrap'),  createSession: (payload) => invoke('oc:create', payload),
  prompt: (payload) => invoke('oc:prompt', payload),
  abort: (payload) => invoke('oc:abort', payload),
  messages: (payload) => invoke('oc:messages', payload),
  sessions: () => invoke('oc:sessions'),
  deleteSession: (payload) => invoke('oc:deleteSession', payload),
  renameSession: (payload) => invoke('oc:renameSession', payload),
  permission: (payload) => invoke('oc:permission', payload),

  /* streams */
  onEvent: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('oc:event', handler)
    return () => ipcRenderer.removeListener('oc:event', handler)
  },
  onStatus: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('oc:status', handler)
    return () => ipcRenderer.removeListener('oc:status', handler)
  },
  onReaLog: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('rea:log', handler)
    return () => ipcRenderer.removeListener('rea:log', handler)
  },
})
