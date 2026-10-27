/** Local canary endpoint for the manual HTML isolation check; no document content is received. */
import http from 'node:http';
let probes = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/thor-preview-canary') { probes++; res.end(JSON.stringify({ synthetic: true })); return; }
  if (req.url === '/state') { res.end(JSON.stringify({ probes })); return; }
  res.statusCode = 404; res.end('{}');
});
server.listen(18765, '127.0.0.1', () => console.log('Thor synthetic canary listening on 127.0.0.1:18765; GET /state reports probe count.'));
