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

  /* Clone facts + fidelity */
  factsExtract: (payload) => invoke('facts:extract', payload),
  factsList: (payload) => invoke('facts:list', payload),
  fidelityCompute: (payload) => invoke('fidelity:compute', payload),
  fidelityGet: (payload) => invoke('fidelity:get', payload),

  /* Clone capture tools */
  uimapCapture: (payload) => invoke('uimap:capture', payload),
  artifactsSnapshot: (payload) => invoke('artifacts:snapshot', payload),
  artifactsDiff: (payload) => invoke('artifacts:diff', payload),
  artifactsCapture: (payload) => invoke('artifacts:capture', payload),
  uimapGet: (payload) => invoke('uimap:get', payload),
  artifactsGet: (payload) => invoke('artifacts:get', payload),
  exploreRun: (payload) => invoke('explore:run', payload),
  exploreGet: (payload) => invoke('explore:get', payload),
  formatsFromArtifacts: (payload) => invoke('formats:fromArtifacts', payload),
  formatsInfer: (payload) => invoke('formats:infer', payload),
  formatsList: (payload) => invoke('formats:list', payload),
  protocolNetstat: (payload) => invoke('protocol:netstat', payload),
  protocolProxy: (payload) => invoke('protocol:proxy', payload),
  protocolHar: (payload) => invoke('protocol:har', payload),
  protocolGet: (payload) => invoke('protocol:get', payload),
  irCompile: (payload) => invoke('ir:compile', payload),
  irGet: (payload) => invoke('ir:get', payload),
  irValidate: (payload) => invoke('ir:validate', payload),
  oracleRecord: (payload) => invoke('oracle:record', payload),
  oracleShadow: (payload) => invoke('oracle:shadow', payload),
  oracleList: (payload) => invoke('oracle:list', payload),
  oracleGet: (payload) => invoke('oracle:get', payload),
  repairAnalyze: (payload) => invoke('repair:analyze', payload),
  repairApply: (payload) => invoke('repair:apply', payload),
  repairStatus: (payload) => invoke('repair:status', payload),
  repairGet: (payload) => invoke('repair:get', payload),
  gapsAnalyze: (payload) => invoke('gaps:analyze', payload),
  gapsNext: (payload) => invoke('gaps:next', payload),
  gapsStatus: (payload) => invoke('gaps:status', payload),
  gapsGet: (payload) => invoke('gaps:get', payload),
  recipesList: (payload) => invoke('recipes:list', payload),
  recipesSave: (payload) => invoke('recipes:save', payload),
  recipesGet: (payload) => invoke('recipes:get', payload),
  recipesGetOne: (payload) => invoke('recipes:one', payload),
  recipesApply: (payload) => invoke('recipes:apply', payload),
  recipesDelete: (payload) => invoke('recipes:delete', payload),
  recipesExport: (payload) => invoke('recipes:export', payload),
  recipesImport: (payload) => invoke('recipes:import', payload),
  fingerprintBuild: (payload) => invoke('fingerprint:build', payload),
  fingerprintDrift: (payload) => invoke('fingerprint:drift', payload),
  fingerprintStatus: (payload) => invoke('fingerprint:status', payload),
  fingerprintGet: (payload) => invoke('fingerprint:get', payload),

  /* Auto Clone: one-click measured pipeline */
  autoRun: (payload) => invoke('auto:run', payload),
  autoGet: (payload) => invoke('auto:get', payload),
  onAutoProgress: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('auto:progress', listener)
    return () => ipcRenderer.removeListener('auto:progress', listener)
  },

  /* IDA (GUI companion + optional Home/Pro MCP registration) */
  idaStatus: () => invoke('ida:status'),
  idaOpen: (payload) => invoke('ida:open', payload),
  idaSetPath: (payload) => invoke('ida:setPath', payload),
  idaSetMcpConfig: (payload) => invoke('ida:setMcpConfig', payload),

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
  cloneCompileSpec: (payload) => invoke('clone:compileSpec', payload),
  cloneScaffold: (payload) => invoke('clone:scaffold', payload),
  cloneArtifacts: (payload) => invoke('clone:artifacts', payload),
  cloneOpenArtifact: (payload) => invoke('clone:openArtifact', payload),

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
