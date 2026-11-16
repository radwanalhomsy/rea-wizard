import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'build')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:256px;height:256px;background:transparent;overflow:hidden}
  .tile{
    width:256px;height:256px;border-radius:60px;
    background:linear-gradient(140deg,#5aa4ff 0%,#4f9cf9 38%,#7c5cff 100%);
    position:relative;overflow:hidden;
  }
  .glow{position:absolute;inset:-40px -40px auto auto;width:190px;height:190px;border-radius:50%;
    background:radial-gradient(circle at 30% 30%,rgba(255,255,255,.42),rgba(255,255,255,0) 70%)}
  .edge{position:absolute;inset:0;border-radius:60px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.22)}
  .mark{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-family:'Segoe UI','Segoe UI Variable Display',system-ui,sans-serif;
    font-weight:700;font-size:168px;line-height:1;color:#fff;letter-spacing:-10px;
    text-shadow:0 6px 18px rgba(24,26,64,.28);
    transform:translate(-2px,-6px);
  }
  .bar{position:absolute;left:58px;bottom:52px;height:9px;width:88px;border-radius:5px;background:rgba(255,255,255,.85)}
  .dot{position:absolute;left:158px;bottom:52px;width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.6)}
  .dot2{position:absolute;left:176px;bottom:52px;width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.4)}
</style></head><body>
  <div class="tile">
    <div class="glow"></div>
    <div class="mark">R</div>
    <div class="bar"></div><div class="dot"></div><div class="dot2"></div>
    <div class="edge"></div>
  </div>
</body></html>`

function ico(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const entries = []
  let offset = 6 + 16 * count
  for (const p of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(p.size === 256 ? 0 : p.size, 0)
    e.writeUInt8(p.size === 256 ? 0 : p.size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(p.buf.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += p.buf.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { offscreen: false, paintWhenInitiallyHidden: true, zoomFactor: 1 },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 700))
  const shot = await win.webContents.capturePage()
  const base = shot.resize({ width: 256, height: 256, quality: 'best' })
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'icon.png'), base.toPNG())

  const sizes = [256, 128, 64, 48, 32, 16]
  const pngs = sizes.map((size) => ({
    size,
    buf: size === 256 ? base.toPNG() : base.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }))
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(pngs))
  console.log('icon written:', fs.statSync(path.join(outDir, 'icon.ico')).size, 'bytes; base', base.getSize())
  app.quit()
})
