const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startCdpBridge } = require(process.argv[2]);
if (process.platform !== 'win32') app.commandLine.appendSwitch('no-sandbox');
function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json/version', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
function command(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () =>
      ws.send(
        JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '21 * 2', returnByValue: true } })
      )
    );
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.id === 7) {
        ws.close();
        resolve(message);
      }
    });
    ws.on('error', reject);
  });
}
function deniedUpgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      reject(new Error('Unexpected CDP access'));
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    ws.on('error', reject);
  });
}
app
  .whenReady()
  .then(async () => {
    let win,
      bridge,
      success = false;
    try {
      assert.equal(process.versions.electron, '43.8.3');
      if (process.platform === 'win32') assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
      win = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true },
      });
      await win.loadURL('data:text/html,<html><body></body></html>');
      const guestId = await win.webContents.executeJavaScript(
        `new Promise(resolve=>{const guest=document.createElement('webview');guest.src='data:text/html,<html><body>Synthetic</body></html>';guest.addEventListener('did-finish-load',()=>resolve(guest.getWebContentsId()),{once:true});document.body.appendChild(guest)})`
      );
      bridge = await startCdpBridge();
      assert.equal(bridge.attach(win.webContents.id).ok, false);
      assert.equal(bridge.attach(guestId).ok, true);
      const discovery = await request(bridge.port);
      assert.equal(discovery.status, 200);
      const url = JSON.parse(discovery.body).webSocketDebuggerUrl;
      await Promise.all(
        [{ Origin: 'null' }, { Origin: 'https://evil.example' }, { Host: `evil.example:${bridge.port}` }].map(
          async (headers) => {
            const denied = await request(bridge.port, headers);
            assert.equal(denied.status, 403);
            assert.ok(!denied.body.includes(bridge.token));
            assert.equal(await deniedUpgrade(url, headers), 403);
          }
        )
      );
      const result = await command(url);
      assert.equal(result.result.result.value, 42);
      await bridge.close();
      bridge = null;
      await win.webContents.executeJavaScript(`document.querySelectorAll('webview').forEach(guest=>guest.remove())`);
      console.log(
        JSON.stringify({
          ok: true,
          electronVersion: process.versions.electron,
          mainWindowDenied: true,
          guestCdpResult: 42,
          discoveryHostOriginDenied: true,
        })
      );
      success = true;
    } catch (error) {
      console.error(error.stack || String(error));
    } finally {
      if (bridge) await bridge.close().catch(() => {});
      if (success) {
        setTimeout(() => process.reallyExit(3), 7000);
        win.destroy();
        app.quit();
      } else process.reallyExit(1);
    }
  })
  .catch((error) => {
    console.error(error.stack || String(error));
    process.reallyExit(1);
  });
