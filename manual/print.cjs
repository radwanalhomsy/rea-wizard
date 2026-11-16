/*
 * Print the assembled manual to PDF with Chromium's print engine.
 * Invoked by build.mjs as: electron print.cjs <input.html> <output.pdf>
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [, , htmlPath, pdfPath] = process.argv
if (!htmlPath || !pdfPath) {
  console.error('usage: electron print.cjs <input.html> <output.pdf>')
  process.exit(2)
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-lcd-text')

const version = process.env.MANUAL_VERSION || ''
const isAr = process.env.MANUAL_LANG === 'ar'

const footer = isAr ? `
<div dir="rtl" style="width:100%;padding:0 15mm;font-family:'Segoe UI',Tahoma,Arial,sans-serif;font-size:8.5px;color:#74839a;display:flex;justify-content:space-between;align-items:center;">
  <span><span dir="ltr">REA Studio ${version}</span> &nbsp;·&nbsp; دليل المستخدم</span>
  <span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span>
</div>` : `
<div style="width:100%;padding:0 15mm;font-family:'Segoe UI',Arial,sans-serif;font-size:8px;color:#74839a;display:flex;justify-content:space-between;align-items:center;">
  <span>REA Studio ${version} &nbsp;·&nbsp; User Manual</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.setBackgroundThrottling(false)

  await win.loadFile(path.resolve(htmlPath))

  // Give webfonts and layout a moment to settle before printing.
  try {
    await win.webContents.executeJavaScript(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
    )
  } catch { /* not fatal */ }
  await new Promise((r) => setTimeout(r, 500))

  const pdf = await win.webContents.printToPDF({
    pageSize: 'A4',
    landscape: false,
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: footer,
    margins: {
      marginType: 'custom',
      top: 0.55,
      bottom: 0.65,
      left: 0.59,
      right: 0.59,
    },
    generateDocumentOutline: true,
    generateTaggedPDF: true,
  })

  fs.writeFileSync(pdfPath, pdf)
  console.log('printed ' + pdf.length + ' bytes -> ' + pdfPath)
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
