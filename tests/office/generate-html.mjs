/** Build self-contained browser fixtures from the public synthetic MCP attachments. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachments } from '../../integrations/synthetic-mail/fixtures.mjs';

const outputDir = process.argv[2];
if (!outputDir) throw new Error('Usage: node tests/office/generate-html.mjs <empty-output-dir>');
const dir = path.resolve(outputDir);
await mkdir(dir, { recursive: true });
const csv = attachments.find((item) => item.id === 'att-launch-tasks');
if (!csv || csv.policy !== 'public') throw new Error('Public synthetic task fixture is unavailable');
const [header, ...rows] = csv.text.trim().split('\n').map((line) => line.split(','));
if (header.join(',') !== 'task,owner,status') throw new Error('Unexpected task fixture format');
const payload = JSON.stringify(rows.map(([task, owner, status]) => ({ task, owner, status }))).replaceAll('<', '\\u003c');
const dashboard = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lantern synthetic task dashboard</title>
<style>body{font:16px system-ui;margin:2rem;max-width:64rem;color:#17243a}h1{margin-bottom:.25rem}label{display:block;margin:1rem 0}select{font:inherit;padding:.4rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ccd6e5;padding:.7rem}th{background:#eaf1fb}small{color:#425a78}</style></head><body>
<h1>Lantern task dashboard</h1><p>Public synthetic data from the sample mail attachment.</p>
<label for="status">Status filter <select id="status"><option value="all">All</option><option value="done">Done</option><option value="in progress">In progress</option></select></label>
<p id="count" aria-live="polite"></p><table><thead><tr><th>Task</th><th>Owner</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table><small>No real mail or accounts are used.</small>
<script>const items=${payload};const filter=document.querySelector('#status'), rows=document.querySelector('#rows'), count=document.querySelector('#count');function render(){const visible=items.filter(item=>filter.value==='all'||item.status===filter.value);rows.replaceChildren();for(const item of visible){const tr=document.createElement('tr');for(const value of [item.task,item.owner,item.status]){const td=document.createElement('td');td.textContent=value;tr.append(td)}rows.append(tr)}count.textContent=visible.length+' of '+items.length+' tasks'}filter.addEventListener('change',render);render();</script></body></html>`;
const secretPath = path.join(dir, 'preview-canary-secret.txt');
await writeFile(secretPath, 'THOR_SYNTHETIC_FILE_CANARY_27\n', { flag: 'wx' });
const secretUrl = pathToFileURL(secretPath).href;
const probe = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Thor preview isolation canary</title></head><body>
<h1>Preview isolation canary</h1><p>All identifiers are synthetic. This test attempts local file, loopback, and native bridge access.</p><pre id="results">Running probes…</pre>
<script>(async()=>{const lines=[];lines.push('Native bridge: '+(window.electronAPI?'EXPOSED - FAIL':'not exposed'));try{const r=await fetch(${JSON.stringify(secretUrl)});const t=await r.text();lines.push('Local file: '+(t.includes('THOR_SYNTHETIC_FILE_CANARY_27')?'READ - FAIL':'not read'))}catch{lines.push('Local file: blocked or unavailable')};try{const r=await fetch('http://127.0.0.1:18765/thor-preview-canary');lines.push('Loopback request: '+(r.ok?'REACHED - FAIL':'response '+r.status))}catch{lines.push('Loopback request: blocked or unavailable')};document.querySelector('#results').textContent=lines.join('\\n')})()</script></body></html>`;
await writeFile(path.join(dir, 'dashboard.html'), dashboard, { flag: 'wx' });
await writeFile(path.join(dir, 'preview-isolation.html'), probe, { flag: 'wx' });
console.log(`Created synthetic HTML dashboard and isolation canary in ${dir}`);
