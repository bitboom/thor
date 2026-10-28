const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { WebSocketServer } = require('ws');
const { trustedCoreRequest, coreRequestHeaders } = require(process.argv[2]);
function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 40 >>\nstream\nBT /F1 12 Tf 20 100 Td (Synthetic) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((value, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
// Windows exercises the production Chromium sandbox. Linux CI may lack a usable
// sandbox helper and is not evidence for the Windows sandbox configuration.
if (process.platform !== 'win32') app.commandLine.appendSwitch('no-sandbox');
app
  .whenReady()
  .then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thor-core-electron-'));
    const page = path.join(dir, 'index.html');
    const frame = path.join(dir, 'foreign.html');
    fs.writeFileSync(page, '<!doctype html><html><body></body></html>');
    fs.writeFileSync(frame, '<!doctype html><html><body></body></html>');
    const token = 'synthetic-only-token';
    let testOk = false;
    let win;
    let server;
    let wss;
    let outside;
    let devServer;
    const seen = [];
    const websocketOrigins = [];
    try {
      devServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body></body></html>');
      });
      await new Promise((resolve) => devServer.listen(0, '127.0.0.1', resolve));
      const devUrl = `http://127.0.0.1:${devServer.address().port}/index.html`;
      outside = http.createServer((req, res) => {
        res.writeHead(200, { 'Access-Control-Allow-Origin': 'null', 'Content-Type': 'text/plain' });
        res.end(req.headers['x-thor-local-token'] ? 'leaked' : 'clean');
      });
      await new Promise((resolve) => outside.listen(0, '127.0.0.1', resolve));
      server = http.createServer((req, res) => {
        const authorized = req.headers['x-thor-local-token'] === token;
        const requestOrigin = req.headers.origin;
        const validOrigin =
          !requestOrigin ||
          requestOrigin === 'null' ||
          requestOrigin === new URL(devUrl).origin ||
          requestOrigin === `http://127.0.0.1:${server.address().port}`;
        const cors = {
          'Access-Control-Allow-Origin': requestOrigin || 'null',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin',
        };
        if (!validOrigin) {
          res.writeHead(403);
          return res.end();
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(authorized ? 204 : 401, authorized ? cors : {});
          return res.end();
        }
        if (req.url === '/redirect' && authorized) {
          res.writeHead(302, {
            Location: `http://127.0.0.1:${outside.address().port}/outside`,
            ...cors,
          });
          return res.end();
        }
        if (req.url === '/pdf' && authorized) {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/pdf' });
          return res.end(syntheticPdf());
        }
        res.writeHead(authorized ? 200 : 403, authorized ? { ...cors, 'Content-Type': 'text/plain' } : {});
        res.end(authorized ? 'ok' : 'denied');
      });
      wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        const requestOrigin = req.headers.origin;
        const authorized = req.headers['x-thor-local-token'] === token;
        const validOrigin =
          !requestOrigin ||
          requestOrigin === 'null' ||
          requestOrigin === new URL(devUrl).origin ||
          requestOrigin === `http://127.0.0.1:${server.address().port}`;
        websocketOrigins.push({ origin: requestOrigin, authorized });
        if (!authorized || !validOrigin) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.send('ok');
          ws.close();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
      });
      if (process.platform === 'win32') {
        assert.equal(process.versions.electron, '43.8.3', 'run against the pinned Electron binary');
        assert.equal(app.commandLine.hasSwitch('no-sandbox'), false, 'Windows must not disable Chromium sandbox');
        assert.equal(win.webContents.getLastWebPreferences().sandbox, true, 'renderer sandbox must be enabled');
      }
      session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
        const main = d.frame === win.webContents.mainFrame;
        const trusted = trustedCoreRequest({
          url: d.url,
          port,
          webContentsId: d.webContentsId,
          expectedWebContentsId: win.webContents.id,
          frameIsMain: main,
          frameUrl: d.frame?.url,
          trustedDocuments: [pathToFileURL(page).href, devUrl],
        });
        if (d.url.startsWith(`http://127.0.0.1:${port}/`) || d.url.startsWith(`ws://127.0.0.1:${port}/`))
          seen.push({ method: d.method, resourceType: d.resourceType, hasFrame: !!d.frame, main, trusted });
        cb({ requestHeaders: coreRequestHeaders(d.requestHeaders, { 'X-Thor-Local-Token': token }, trusted, d.url) });
      });
      await win.loadFile(page);
      const url = `http://127.0.0.1:${port}`;
      const httpStatus = await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url + '/api')}).then(r => r.status)`
      );
      const postStatus = await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url + '/json')}, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({synthetic:true})}).then(r=>r.status).catch(()=> 'error')`
      );
      const wsResult = await win.webContents.executeJavaScript(
        `new Promise(resolve => {const ws=new WebSocket(${JSON.stringify('ws://127.0.0.1:' + port + '/ws')}); ws.onmessage=e=>resolve(e.data); ws.onerror=()=>resolve('error'); setTimeout(()=>resolve('timeout'),5000)})`
      );
      const frameStatus = await win.webContents.executeJavaScript(
        `new Promise(resolve => { const iframe=document.createElement('iframe'); iframe.src=${JSON.stringify(pathToFileURL(frame).href)}; iframe.onload=()=>iframe.contentWindow.fetch(${JSON.stringify(url + '/iframe')}).then(r=>resolve(r.status)).catch(()=>resolve('error')); document.body.appendChild(iframe); })`
      );
      const foreignWsResult = await win.webContents.executeJavaScript(
        `new Promise(resolve => {const child = document.querySelector('iframe').contentWindow; const ws = new child.WebSocket(${JSON.stringify('ws://127.0.0.1:' + port + '/ws')}); ws.onmessage=()=>resolve('unexpected'); ws.onerror=()=>resolve('error'); setTimeout(()=>resolve('timeout'),5000)})`
      );
      const guestStatus = await win.webContents.executeJavaScript(
        `new Promise(resolve => { const guest=document.createElement('webview'); guest.partition='thor-test-guest'; guest.src=${JSON.stringify(pathToFileURL(frame).href)}; guest.addEventListener('did-finish-load',()=>guest.executeJavaScript(${JSON.stringify(`fetch(${JSON.stringify(url + '/guest')}).then(r=>r.status).catch(()=> 'error')`)}).then(resolve).catch(()=>resolve('error')),{once:true}); document.body.appendChild(guest); setTimeout(()=>resolve('timeout'),5000); })`
      );
      const redirectResult = await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url + '/redirect')}).then(r=>r.text()).catch(()=> 'error')`
      );
      const blobResult = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const blob = URL.createObjectURL(new Blob(['<html><body>synthetic document</body></html>'], {type:'text/html'}));
        const guest = document.createElement('webview'); guest.src = blob;
        guest.addEventListener('did-finish-load', () => guest.executeJavaScript('document.body.textContent').then(resolve).catch(()=>resolve('error')), {once:true});
        guest.addEventListener('did-fail-load', () => resolve('error'), {once:true});
        document.body.appendChild(guest); setTimeout(()=>resolve('timeout'), 5000);
      })`);
      const pdfResult = await win.webContents
        .executeJavaScript(`fetch(${JSON.stringify(url + '/pdf')}).then(r=>r.blob()).then(blob=>new Promise(resolve=>{
        const guest=document.createElement('webview'); guest.src=URL.createObjectURL(blob);
        guest.addEventListener('did-finish-load',()=>resolve('loaded'),{once:true});
        guest.addEventListener('did-fail-load',()=>resolve('error'),{once:true});
        document.body.appendChild(guest); setTimeout(()=>resolve('timeout'),5000);
      }))`);
      await win.loadURL(devUrl);
      const devPostStatus = await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url + '/json')}, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({synthetic:true})}).then(r=>r.status).catch(()=> 'error')`
      );
      assert.equal(httpStatus, 200, 'main frame HTTP');
      assert.equal(wsResult, 'ok', 'main frame WebSocket');
      assert.equal(foreignWsResult, 'error', 'untrusted subframe WebSocket denied');
      assert.ok(
        websocketOrigins.some((entry) => entry.authorized && entry.origin === 'null'),
        'trusted WS sends opaque null origin'
      );
      assert.ok(
        websocketOrigins.some((entry) => !entry.authorized && entry.origin === 'file://'),
        'untrusted WS retains its origin without a capability'
      );
      assert.equal(postStatus, 200, 'JSON POST and its authenticated preflight');
      assert.equal(devPostStatus, 200, 'cross-origin dev JSON POST');
      assert.equal(frameStatus, 403, 'foreign subframe denied');
      assert.equal(guestStatus, 403, 'isolated guest denied');
      assert.equal(redirectResult, 'clean', 'redirect does not carry capability');
      assert.equal(blobResult, 'synthetic document', 'guest can load renderer-owned blob');
      assert.equal(pdfResult, 'loaded', 'PDF bytes fetched by renderer load as a blob guest');
      assert.ok(seen.some((v) => v.resourceType === 'webSocket' && v.main && v.hasFrame && v.trusted));
      assert.ok(seen.some((v) => v.method === 'OPTIONS' && v.main && v.hasFrame && v.trusted));
      await win.webContents.executeJavaScript(`document.querySelectorAll('webview').forEach(guest => guest.remove())`);
      console.log(
        JSON.stringify({
          ok: true,
          httpStatus,
          postStatus,
          devPostStatus,
          wsResult,
          frameStatus,
          guestStatus,
          redirectResult,
          blobResult,
          pdfResult,
          windowsSandboxConfigured: process.platform === 'win32',
          electronVersion: process.versions.electron,
          requests: seen,
        })
      );
      testOk = true;
    } catch (error) {
      console.error(error.stack || String(error));
    } finally {
      if (wss) {
        for (const client of wss.clients) client.terminate();
        wss.close();
      }
      if (server) server.closeAllConnections();
      if (outside) outside.closeAllConnections();
      if (devServer) devServer.closeAllConnections();
      if (server) server.close();
      if (outside) outside.close();
      if (devServer) devServer.close();
      fs.unlinkSync(page);
      fs.unlinkSync(frame);
      fs.rmdirSync(dir);
      if (testOk) {
        // Bounded diagnostic: attempt the ordinary window and app shutdown path.
        // Exit code 3 means the shutdown timed out, not a passing test.
        setTimeout(() => process.reallyExit(3), 7000);
        win.destroy();
        app.quit();
      } else {
        process.reallyExit(1);
      }
    }
  })
  .catch((e) => {
    console.error(e.stack || String(e));
    app.exit(1);
  });
