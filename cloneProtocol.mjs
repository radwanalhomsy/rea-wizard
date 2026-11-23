/**
 * Protocol capture.
 *
 * Three complementary, offline-capable paths into <project>/spec/protocol.json:
 *
 *  1. netstat polling — discovers TCP listeners and connections opened by a
 *     target process (works for any protocol, no packet driver needed).
 *  2. local HTTP proxy — an opt-in forward proxy that logs HTTP method, path,
 *     headers and response status from clients that honour proxy settings.
 *  3. HAR import — folds traffic captured elsewhere (browser devtools, an
 *     external proxy, REA tools) into the same endpoint model.
 *
 * HTTPS through the proxy is recorded as a CONNECT tunnel target, not
 * decrypted — that limitation is stated in the output rather than hidden.
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { getProject, projectPaths, addEvidence, captureEvidence } from './cloneStore.mjs'

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-') }

/** Parse `netstat -ano` into a stable list of TCP endpoints. */
export function netstatSnapshot() {
  const res = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  })
  const lines = String(res.stdout || '').split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const [proto, local, remote, state, pid] = parts
    if (proto.toLowerCase() !== 'tcp') continue
    out.push({ local, remote, state, pid: Number(pid) || 0 })
  }
  return out.sort((a, b) => `${a.local}|${a.remote}|${a.state}`.localeCompare(`${b.local}|${b.remote}|${b.state}`))
}

function hostPort(addr) {
  const text = String(addr || '')
  const i = text.lastIndexOf(':')
  if (i < 0) return { host: text, port: 0 }
  return { host: text.slice(0, i), port: Number(text.slice(i + 1)) || 0 }
}

function isLoopback(host) {
  const h = String(host || '').toLowerCase()
  return h === 'localhost' || h.startsWith('127.') || h === '::1' || h === '[::1]'
}

function endpointKey(e) {
  return `${e.protocol || 'tcp'}|${e.method || ''}|${e.host || '0.0.0.0'}|${String(e.port ?? '')}|${e.path || e.address || '/'}`
}

function markdown(proto) {
  const lines = ['# Protocol capture', '', `${(proto.endpoints || []).length} endpoint(s).`, '']
  lines.push('| Protocol | Method | Host | Port | Path / address | Status | Source |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const e of proto.endpoints || []) {
    lines.push(`| ${e.protocol || 'tcp'} | ${e.method || ''} | ${e.host || ''} | ${e.port || ''} | ${String(e.path || e.address || '/').slice(0, 90)} | ${e.status ?? ''} | ${e.source || ''} |`)
  }
  lines.push('', '## Limitations', '')
  for (const note of proto.limitations || []) lines.push(`- ${note}`)
  lines.push('')
  return lines.join('\n')
}

function persist(workspace, slug, proto) {
  const paths = projectPaths(workspace, slug)
  fs.mkdirSync(paths.spec, { recursive: true })
  fs.writeFileSync(path.join(paths.spec, 'protocol.json'), JSON.stringify(proto, null, 2) + '\n', 'utf8')
  fs.mkdirSync(paths.reports, { recursive: true })
  fs.writeFileSync(path.join(paths.reports, 'protocol.md'), markdown(proto), 'utf8')
  return ['spec/protocol.json', 'reports/protocol.md']
}

function attachEvidence(workspace, slug, proto, source) {
  const ids = []
  for (const e of proto.endpoints || []) {
    const id = `ev_proto_${crypto.createHash('sha256').update(endpointKey(e)).digest('hex').slice(0, 12)}`
    addEvidence(workspace, slug, {
      id,
      source,
      stage: 'behavior',
      note: `${e.method || e.protocol || 'tcp'} ${e.host || ''}${e.port ? ':' + e.port : ''}${e.path || e.address || ''}${e.status ? ' -> ' + e.status : ''}`,
      file: 'spec/protocol.json',
    })
    ids.push(id)
  }
  if (ids.length) captureEvidence(workspace, slug, { ids, source, raw: JSON.stringify(proto) })
  return ids
}

function readExisting(workspace, slug) {
  const file = path.join(projectPaths(workspace, slug).spec, 'protocol.json')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function merge(workspace, slug, incoming, source) {
  const current = readExisting(workspace, slug) || { schema: 1, endpoints: [], limitations: [] }
  const map = new Map()
  for (const e of [...(current.endpoints || []), ...(incoming.endpoints || [])]) map.set(endpointKey(e), e)
  const proto = {
    schema: 1,
    endpoints: [...map.values()].sort((a, b) => endpointKey(a).localeCompare(endpointKey(b))),
    limitations: Array.from(new Set([...(current.limitations || []), ...(incoming.limitations || [])])).sort(),
    sources: Array.from(new Set([...(current.sources || []), source])).sort(),
  }
  const files = persist(workspace, slug, proto)
  const evidence = attachEvidence(workspace, slug, proto, source)
  return { endpoints: proto.endpoints.length, evidence, files, limitations: proto.limitations }
}

/** Poll netstat while a target runs; record endpoints tied to it or newly opened. */
export async function captureNetstat(workspace, slug, options = {}) {
  if (process.platform !== 'win32') throw new Error('netstat capture is available on Windows only')
  const { target = null, pid = 0, seconds = 8, intervalMs = 1000, closeAfter = true } = options
  const wantPid = Number(pid) || 0
  let child = null
  let usePid = wantPid
  const baseline = new Set(netstatSnapshot().map((e) => `${e.local}|${e.remote}|${e.state}|${e.pid}`))
  try {
    if (!usePid && target) {
      if (!fs.existsSync(target)) throw new Error('Target executable does not exist')
      child = spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore', windowsHide: false })
      usePid = child.pid || 0
    }
    const seen = new Map()
    const duration = Math.max(1, Math.min(120, Number(seconds) || 8))
    const every = Math.max(250, Math.min(10000, Number(intervalMs) || 1000))
    const end = Date.now() + duration * 1000
    while (Date.now() < end) {
      for (const e of netstatSnapshot()) {
        const key = `${e.local}|${e.remote}|${e.state}|${e.pid}`
        const owned = usePid && e.pid === usePid
        const fresh = !baseline.has(key)
        if (!owned && !fresh) continue
        const l = hostPort(e.local)
        const r = hostPort(e.remote)
        const endpoint = {
          protocol: 'tcp',
          host: l.host || '0.0.0.0',
          port: l.port,
          address: e.local,
          remoteHost: r.host,
          remotePort: r.port,
          state: e.state,
          pid: e.pid,
          loopback: isLoopback(l.host) || isLoopback(r.host),
          method: '',
          path: e.state === 'LISTENING' ? '/(listener)' : r.host ? `->${r.host}:${r.port}` : '/',
          source: 'netstat',
        }
        seen.set(endpointKey(endpoint), endpoint)
      }
      await new Promise((r) => setTimeout(r, every))
    }
    const proto = {
      schema: 1,
      endpoints: [...seen.values()],
      limitations: [
        'netstat reveals TCP endpoints only; UDP and named pipes are not observed.',
        'Payloads, methods and headers are not visible without a proxy or HAR capture.',
      ],
      sources: ['netstat'],
    }
    const result = merge(workspace, slug, proto, 'netstat')
    return { ...result, pid: usePid, launchedPid: child?.pid || null }
  } finally {
    if (child && closeAfter && child.pid) {
      try { process.kill(-child.pid) } catch {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
    }
  }
}

/** Fold a HAR (HTTP Archive) file into the endpoint model. */
export function importHar(workspace, slug, harPath) {
  const abs = path.resolve(String(harPath || ''))
  if (!fs.existsSync(abs)) throw new Error('HAR file does not exist')
  const har = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const entries = har?.log?.entries || []
  if (!entries.length) throw new Error('HAR contains no entries')
  const endpoints = entries.map((entry) => {
    const req = entry.request || {}
    const res = entry.response || {}
    const url = String(req.url || '')
    let parsed = { host: '', port: 0, path: url }
    try {
      const u = new URL(url)
      parsed = { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search }
    } catch { /* keep the raw URL as the path */ }
    return {
      protocol: parsed.port === 443 ? 'https' : 'http',
      method: req.method || 'GET',
      host: parsed.host,
      port: parsed.port,
      path: parsed.path,
      status: res.status ?? null,
      contentType: res.content?.mimeType || null,
      requestHeaders: (req.headers || []).map((h) => ({ name: h.name, value: h.value })),
      responseHeaders: (res.headers || []).map((h) => ({ name: h.name, value: h.value })),
      requestBody: req.postData?.text ? req.postData.text.slice(0, 1000) : null,
      responseSize: res.bodySize ?? null,
      loopback: isLoopback(parsed.host),
      source: 'har',
    }
  })
  return merge(workspace, slug, {
    endpoints,
    limitations: ['HAR entries describe requests recorded elsewhere; body bytes may be redacted in the source file.'],
  }, 'har')
}

/**
 * Run a loopback HTTP forward proxy while the target runs, logging requests.
 * Set HTTP_PROXY to the proxy for child processes. HTTPS is logged as CONNECT
 * but not decrypted.
 */
export async function captureProxy(workspace, slug, options = {}) {
  const { port = 8899, target = null, seconds = 10, closeAfter = true, setEnv = true } = options
  if (target && !fs.existsSync(target)) throw new Error('Target executable does not exist')
  const requests = []
  const server = http.createServer((req, res) => {
    const url = String(req.url || '')
    let upstream = null
    try { upstream = new URL(url) } catch { /* handled below */ }
    const record = {
      protocol: 'http',
      method: req.method || 'GET',
      host: upstream?.hostname || '',
      port: Number(upstream?.port) || (upstream?.protocol === 'https:' ? 443 : 80),
      path: upstream ? upstream.pathname + upstream.search : url,
      requestHeaders: Object.entries(req.headers).map(([name, value]) => ({ name, value: String(value) })),
      source: 'proxy',
      status: null,
    }
    requests.push(record)
    if (!upstream || !upstream.hostname) {
      res.writeHead(400); res.end('Bad request'); return
    }
    const proxyReq = http.request({
      hostname: upstream.hostname,
      port: record.port,
      path: record.path,
      method: req.method,
      headers: { ...req.headers, host: upstream.host },
    }, (proxyRes) => {
      record.status = proxyRes.statusCode || null
      record.responseHeaders = Object.entries(proxyRes.headers).map(([name, value]) => ({ name, value: String(value) }))
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => { res.writeHead(502); res.end('Upstream error') })
    req.pipe(proxyReq)
  })
  server.on('connect', (req, clientSocket, head) => {
    const targetAddr = String(req.url || '')
    const i = targetAddr.lastIndexOf(':')
    requests.push({
      protocol: 'https', method: 'CONNECT',
      host: targetAddr.slice(0, i), port: Number(targetAddr.slice(i + 1)) || 443,
      path: '/(tunnel)', source: 'proxy', status: null,
    })
    const upstream = http.connect({ host: targetAddr.slice(0, i), port: Number(targetAddr.slice(i + 1)) || 443 })
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  let child = null
  try {
    if (target) {
      const env = { ...process.env }
      if (setEnv) {
        env.HTTP_PROXY = `http://127.0.0.1:${port}`
        env.http_proxy = env.HTTP_PROXY
      }
      child = spawn(target, [], {
        cwd: path.dirname(target), detached: true, stdio: 'ignore', windowsHide: false, env,
      })
    }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(120, Number(seconds) || 10)) * 1000))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (child && closeAfter && child.pid) {
      try { process.kill(-child.pid) } catch {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
    }
  }
  return merge(workspace, slug, {
    endpoints: requests,
    limitations: [
      'Proxy capture sees only clients that honour the HTTP_PROXY environment variable.',
      'HTTPS CONNECT tunnels are logged as tunnel targets; TLS payloads are not decrypted.',
    ],
  }, 'proxy')
}

export function readProtocol(workspace, slug) {
  return readExisting(workspace, slug)
}
