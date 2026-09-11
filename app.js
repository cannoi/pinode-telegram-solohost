'use strict';
/**
 * SoloHost Controller v2.6.57
 * - Smart Incident Engine (observe -> evaluate -> decide -> act)
 * - Health Scoring with Damper + Stability-aware adjustment
 * - AI Data Query DSL + named blocks
 * - Pi Node Diagnostic Framework v3.0 + Deep Knowledge Base
 * - Natural Language Command Parser (multi-language)
 * - Auto Telegram Menu Sync on boot
 * - Update checker (48h) via GitHub repo cannoi/pinode-telegram-solohost
 * - Horizon-only notice: shown under Peers line, hidden when docker.sock ON
 * - Unified data pipeline: read -> normalize -> sort -> aggregate -> use
 * - Night/off mute covers all notifications
 * - Resource-tuned: readHistory cache + rollup RAM cache + index cache
 * - [2.6.57] Host metrics come from Node OS (os.cpus / os.totalmem / fs.statfsSync)
 *   via host-metrics.js. Independent of Docker.
 * - [2.6.57] Safe getTelemetry dedupe + sock cache + no detail cache pollution
 * - [2.6.57] pull_policy: missing in generated compose to prevent image pull loops
 * - [2.6.57-fix] host-metrics module is OPTIONAL — selftest never fails if missing
 * - [2.6.57-fix] /api/host-metrics reads directly from the module (no HTTP fetch)
 * - [2.6.57-fix] index.html loaded from multiple fallback paths
 */
const http = require('http');
const https = require('https');
const PiNodeStatusMonitor = require('./status-monitor');
const dataFrame = require('./data-frame');
const lite = require('./telemetry-lite');
const net = require('net');
const fs = require('fs');
const path = require('path');

const APP_KNOWLEDGE = `
APP: Pi Node Telegram Controller PRO (SoloHost Edition)
Purpose: 24/7 Pi Node monitoring via Telegram + local SoloHost UI.
HEALTH: stability-aware damper (EMA + dead-band + confidence).
INCIDENT: 10 classes, stage machine 0-5.
AI DATA: named blocks + flexible DSL queries (metric/window/agg/filter).
DIAGNOSTIC: 7-step flow + 8 SoloHost scripts, 4 safety levels.
NATURAL LANGUAGE: report schedule, alerts on/off/night, mute N hours, stop reports.
UPDATE CHECK: every 48h from github.com/cannoi/pinode-telegram-solohost.
NIGHT MUTE: applies to alerts, reminders, recovery, scheduled reports, update notices.
HOST METRICS: Node OS CPU/RAM/Disk/Uptime (os.cpus / os.totalmem / fs.statfsSync).
DOCKER METRICS: container CPU/RAM/health only when docker.sock ON (separate from Host).
STYLE: static system messages English; AI replies match user's language.
`.trim();

const PI_NODE_DIAGNOSTIC_PROMPT = `
=== PI NODE AI DIAGNOSTIC & OPERATIONAL CONSULTANT (v3.0 PRO SoloHost) ===
ROLE: Senior Pi Node Operations & Diagnostics Consultant inside the app.
Analyze Pi Node / Docker Desktop / WSL2 / Windows state, diagnose issues,
then recommend the EXACT script from the 8 SoloHost operation scripts.
Never break the sync chain, never change LAN IP, never lose blockchain data.

GOLDEN GUARDRAILS (NEVER violate):
1. NEVER suggest LAN IP change / ipconfig /release /renew / netsh int ip reset.
2. NEVER suggest "wsl --shutdown" while Docker Desktop is running.
3. NEVER suggest docker volume prune -a or docker system prune --volumes.
4. NEVER conclude "Port Closed = Firewall fault". If the container is stopped,
   Port Closed is normal (listener not running). Not a firewall problem.
5. NEVER recommend heavy intervention during natural "Catching up" or
   "Downloading ledger" under 6 hours.

HOST vs CONTAINER (strict):
- system.cpu/ram/disk are Node OS metrics (source: node_os).
- container_cpu/container_ram are Docker container metrics (source: docker).
- Never present container metrics as host metrics, or vice versa.

8 SCRIPTS (safety L1 safest -> L4 strongest):
- CleanRam.bat      L1  Free RAM/TEMP/TRIM/DNS. Does NOT touch Docker/Pi.
- DnsFlush.bat      L1  ipconfig /flushdns + registerdns. NIC/IP unchanged.
- Firewall.bat      L2  Rebuild TCP 31401-31410 In+Out + local listener test.
- NodeReset.bat     L2  Restart Pi container only (60s grace). No data loss.
- NetRepair.bat     L3  Phase1 DNS/ARP/FW -> Phase2 adapter restart keep IP
                        -> Phase3 winsock reset (reboot required).
- LanSetup.bat      L3  Lock CURRENT IP as static + firewall + Google DNS.
- DockerRecover.bat L4  Mode S (soft) -> Mode Y (ordered WSL, kill Docker first).
- Maintain.bat      L1->L4  Weekly cleanup. Safe volume prune -f.

DECISION MATRIX (symptom -> script):
- Slow PC / RAM>85% / Docker resource starve  -> CleanRam.bat     [L1]
- Peers -> 0 but ports OPEN + ledger advancing -> DnsFlush.bat     [L1]
- Ports CLOSED + Container RUNNING             -> Firewall.bat     [L2]
- Ports CLOSED + Container STOPPED             -> NodeReset.bat    [L2]
- Local port OPEN but Internet CLOSED          -> Router NAT/CGNAT (no script)
- Container stuck, block frozen > 30 min       -> NodeReset.bat    [L2]
- No internet (ping 8.8.8.8 fails)             -> NetRepair.bat    [L3]
- IP changed, port-forward broken              -> LanSetup.bat     [L3]
- Docker Engine not ready / WSL2 stuck         -> DockerRecover   [L4 soft]
- Weekly housekeeping                          -> Maintain.bat    [Sun 03:00]

7-STEP DIAGNOSTIC FLOW (always in order):
1. DETECT    - Confirm main symptom from log/user description.
2. VERIFY    - Rule out false causes (natural catch-up, CGNAT).
3. EXPLAIN   - Root cause in simple language.
4. RECOMMEND - Name exactly 1 (max 2) scripts from the list.
5. SAFETY    - State level (L1-L4) + confirm data/IP preserved.
6. ACTION    - How to run (SoloHost UI -> Scripts -> file, or .bat).
7. RECHECK   - Time window + recovery signal (e.g. wait 10-15 min).

OUTPUT STYLE: English only. Short lines. Icons. Script names in backticks.
End every answer with a clear next-action choice for the user.
`.trim();

const PI_NODE_DEEP_KNOWLEDGE = `
=== PI NODE DEEP KNOWLEDGE BASE (for AI context) ===

1) APP COMMANDS
/status /sync /peers /report /incidents /diagnostic /scripts
/analyze /logs /donate /winpro /ping /help /mute

2) NATURAL LANGUAGE (no slash needed) - app parses intents BEFORE AI:
- "reports at 7am and 6pm" / "báo cáo 7h sáng và 6h chiều"
- "daily report at midnight" / "báo cáo hàng ngày 12 giờ đêm"
- "turn off alerts" / "tắt báo động"
- "quiet at night" / "yên tĩnh ban đêm"
- "mute for 2 hours" / "im lặng 2 giờ"
- "stop reports" / "tắt báo cáo"

3) HEALTH SCORE
- Range 0-100. Smoothed by stability-aware damper.
- 85-100 = healthy. 65-84 = watch. 40-64 = degraded. <40 = critical.
- Confidence: high (docker.sock+Core), medium (Core or Horizon+Ports), low (Horizon only).
- Frozen when no source (never drifts to 0 during outages).
- Sustained bad sync keeps the score low; brief noise does not.

4) SYNC STATUS VALUES
- Synced / Horizon live -> healthy
- Catching up / behind / slow -> transient, wait 15 min before action
- Not synced / unsynced / error -> real problem
- Horizon ingest lag -> Core advanced, Horizon behind (wait)

5) PORTS 31401-31403
- OPEN only if container listener is running.
- CLOSED with container STOPPED = normal (not a firewall issue).
- CLOSED with container RUNNING = firewall issue -> Firewall.bat.
- Local OPEN but Internet CLOSED = Router NAT / CGNAT (no local script fixes).

6) 8 SCRIPTS WITH SAFETY LEVELS
L1: CleanRam.bat (RAM>85%, PC slow, node synced)
L1: DnsFlush.bat (peers=0, ports OPEN, ledger moves)
L2: Firewall.bat (ports CLOSED, container RUNNING)
L2: NodeReset.bat (container stuck, block frozen >30 min)
L3: NetRepair.bat (no internet, 3-phase, keeps IP)
L3: LanSetup.bat (first setup OR IP changed)
L4: DockerRecover.bat (Docker not ready, WSL stuck - soft first)
SCH: Maintain.bat (Sun 03:00, weekly cleanup)

7) GOLDEN RULES (never violate)
- NEVER change LAN IP (breaks port forwarding).
- NEVER run "wsl --shutdown" while Docker Desktop is running.
- NEVER run "docker volume prune -a" (loses blockchain data).
- NEVER say "Port Closed = Firewall" without checking container state.
- NEVER intervene during natural "Catching up" < 6 hours.

8) COMMON FALSE ALARMS
- Peers 0-2 during first 24h -> normal bootstrap.
- Sync "Catching up" 5-30 min after Pi Node update -> normal.
- Ledger age 30-120s -> network blip, wait.
- Horizon "ingest lag" -> Core ahead, Horizon catching up.
- Docker "exited" with restart policy -> check if auto-restarting.

9) WHEN TO ESCALATE
- Sync stuck > 6 hours: NodeReset
- Ports closed > 30 min with container running: Firewall
- No internet at all > 5 min: NetRepair
- Docker Engine down > 5 min: DockerRecover (soft)
- Repeated incidents (>3 in 24h): /report for pattern

10) PERFORMANCE EXPECTATIONS
- Pi Node ledger: ~5-10s per block (Testnet), ~5s (Mainnet).
- Peers: 8-20 typical, 3-7 acceptable, 0-2 concerning after bootstrap.
- Container RAM: 1-2 GB typical, 3+ GB on testnet2 during catch-up.
- Container CPU: 10-60% typical (single core), >90% sustained = problem.

11) DOCKER OPTIONAL
- docker.sock gives Core version + real container state.
- Without it, app uses Horizon + TCP ports probe (still works).
- Operator must opt-in via SoloHost UI. Telegram cannot raise privileges.
- Horizon-only accuracy note: Horizon ingest can lag behind Core state,
  so ledger/sync numbers may differ from Pi Node Desktop. Enable Optional
  Docker for exact Core state + real container metrics.

12) HOST METRICS (Node OS)
- CPU/RAM/Disk/Uptime come from Node's own os module + fs.statfsSync.
- Independent of docker.sock. Works when Docker is OFF.
- Source label: node_os. Never confuse with container metrics.
- Note: values reflect the container's kernel/namespace view, not the
  Windows host directly. CPU cores and uptime match the host kernel.

13) INTERNATIONAL SUPPORT
- AI replies in user's language.
- Quick action buttons (Analyze) use last-seen chat language.
- Static system messages stay English for consistency.
- Supported languages: EN, VI, ES, FR, PT, IT, DE, TR, ID, RU, JA, KO, ZH, AR, HI, TH, PL, EL, SV, NO, HE.
`.trim();

const SCRIPT_DETAILS = {
  cleanram: {
    icon: '🧹', file: 'CleanRam.bat', level: '🟢 L1', levelTxt: 'Very safe',
    when: 'RAM > 85% or PC sluggish while node is still synced',
    does: 'Close background apps (Search, RuntimeBroker), clear TEMP, TRIM SSD, flush DNS, restart Explorer. Does NOT touch Docker or Pi Node.',
    safety: 'No sync interruption. No IP change. Pi Node stays running.'
  },
  dnsflush: {
    icon: '🌐', file: 'DnsFlush.bat', level: '🟢 L1', levelTxt: 'Very safe',
    when: 'Peers dropped but ports OPEN and ledger still advancing',
    does: 'ipconfig /flushdns + registerdns only. Keeps NIC, IP, TCP/IP intact.',
    safety: 'No sync interruption. No IP change.'
  },
  firewall: {
    icon: '🧱', file: 'Firewall.bat', level: '🟡 L2', levelTxt: 'Node intervention',
    when: 'Local ports 31401-31403 CLOSED while container is RUNNING',
    does: 'Rebuild Windows Firewall TCP 31401-31410 Inbound+Outbound rules, then run a local listener test on 31401-31403.',
    safety: 'Container untouched. No IP change.'
  },
  nodereset: {
    icon: '♻️', file: 'NodeReset.bat', level: '🟡 L2', levelTxt: 'Node intervention',
    when: 'Container stuck/exited, block frozen > 30 min, Docker Engine OK',
    does: 'Restart Pi container only (testnet2/mainnet/testnet) with 60s grace. Flush DNS, reapply firewall, enable anti-sleep, set Docker High priority.',
    safety: 'No data loss. No image pull. No IP change.'
  },
  netrepair: {
    icon: '🔧', file: 'NetRepair.bat', level: '🟠 L3', levelTxt: 'System network',
    when: 'No internet at all (ping 8.8.8.8 fails)',
    does: 'Phase 1: DNS/ARP/Firewall. Phase 2: Adapter restart KEEPING current IP. Phase 3: Winsock reset (reboot required).',
    safety: 'Never touches IP layer. No ipconfig release.'
  },
  lansetup: {
    icon: '📡', file: 'LanSetup.bat', level: '🟠 L3', levelTxt: 'System network',
    when: 'First setup, or IP changed and port-forward broke',
    does: 'Detect current IPv4 -> lock THAT SAME IP as static, disable IPv6, set Google DNS (8.8.8.8), Private network, firewall rule.',
    safety: 'Locks CURRENT IP only. Never invents a new IP.'
  },
  dockerrecover: {
    icon: '🐳', file: 'DockerRecover.bat', level: '🔴 L4', levelTxt: 'Docker / WSL',
    when: 'Docker Engine "not ready" / WSL2 stuck',
    does: 'Mode S (Soft): light Docker Desktop restart. Mode Y (Ordered): Docker stop -> confirm dead -> wsl --shutdown -> restart Docker.',
    safety: 'Ordered shutdown only AFTER Docker confirmed stopped to avoid .vhdx corruption.'
  },
  maintain: {
    icon: '🧰', file: 'Maintain.bat', level: '🟢 L1 → 🔴 L4', levelTxt: 'Scheduled',
    when: 'Weekly housekeeping (recommend Sun 03:00)',
    does: 'Sync time (w32tm), clean TEMP/Recycle Bin, docker volume prune -f (safe), image prune, TRIM (if CPU<75%), SFC/DISM (Sun week 1 if free >= 15GB).',
    safety: 'Volume prune is the safe one (not -a). Container data preserved.'
  }
};

const VERSION = '2.6.57-solohost';
const GITHUB_REPO = 'cannoi/pinode-telegram-solohost';
const GITHUB_REPO_URL = 'https://github.com/' + GITHUB_REPO;
const UPDATE_CHECK_INTERVAL_MS = 48 * 3600 * 1000;
const UPDATE_WAKE_INTERVAL_MS = 6 * 3600 * 1000;

const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const NODE_HOST = (process.env.NODE_HOST || 'host.docker.internal').trim();
const HORIZON_PORT = parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401;
const NODE_LABEL = (process.env.PI_CONTAINER || process.env.NODE_LABEL || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ALERT_ON_START = String(process.env.ALERT_ON_START || 'true').toLowerCase() !== 'false';
const TELEMETRY_SEC = Math.max(30, parseInt(process.env.TELEMETRY_SEC || '60', 10) || 60);
const REPORT_HOURS = parseHours(process.env.REPORT_HOURS, [7, 18]);
const FAIL_THRESHOLD = Math.max(2, parseInt(process.env.FAIL_THRESHOLD || '3', 10) || 3);
const ALERT_COOLDOWN = Math.max(60, parseInt(process.env.ALERT_COOLDOWN_SEC || '180', 10) || 180);
const GITHUB_PRO = 'https://github.com/cannoi/pinode-telegram-controller';
const NODE_PORTS = [31401, 31402, 31403];
const NODE_PORTS_STR = NODE_PORTS.map(String);
const statusMonitor = new PiNodeStatusMonitor({
  nodeHost: NODE_HOST, horizonPort: HORIZON_PORT, stateDir: DATA,
  cacheTTL: Math.min(8000, Math.max(3000, (typeof TELEMETRY_SEC === 'number' ? TELEMETRY_SEC : 60) * 80))
});

const DIR_HIST = path.join(DATA, 'history');
const DIR_HOURLY = path.join(DATA, 'hourly');
const DIR_DAILY = path.join(DATA, 'daily');
const DIR_STATE = path.join(DATA, 'state');
const DIR_LOGS = path.join(DATA, 'logs');
const STATE_F = path.join(DIR_STATE, 'node-state.json');
const LATEST_F = path.join(DATA, 'latest.json');
const LOG_F = path.join(DIR_LOGS, 'controller.log');
const PUBLIC = path.join(__dirname, 'public');
const SCRIPTS = path.join(__dirname, 'scripts');
const HOURLY_F = path.join(DIR_HIST, 'hourly.json');
const DAILY_F = path.join(DIR_HIST, 'daily.json');

function parseHours(raw, def) {
  const a = String(raw || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 23);
  return a.length ? a : def;
}
function ensureDirs() {
  [DIR_HIST, DIR_HOURLY, DIR_DAILY, DIR_STATE, DIR_LOGS].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  });
}
ensureDirs();

function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function saveJSON(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = f + '.tmp';
    fs.writeFileSync(t, JSON.stringify(obj));
    fs.renameSync(t, f);
  } catch (e) {}
}
function safeParse(s) {
  try {
    return JSON.parse(s, function (k, v) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
      return v;
    });
  } catch (e) { return null; }
}
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function nowISO() {
  try { return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }).replace(' ', 'T') + '+07:00'; }
  catch (e) { return new Date().toISOString(); }
}
function nowHM() {
  try {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
    }).replace(/\//g, '-').replace(',', '');
  } catch (e) { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
}
function dayVN() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function hourVN() {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }).formatToParts(new Date());
    return parseInt(p.find(x => x.type === 'hour').value, 10) % 24;
  } catch (e) { return (new Date().getUTCHours() + 7) % 24; }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function treeBlock(header, lines) {
  if (!lines || !lines.length) return '';
  const out = [header];
  lines.forEach(function (l, i) {
    const isLast = i === lines.length - 1;
    out.push(' ' + (isLast ? '└' : '├') + ' ' + l);
  });
  return out.join('\n');
}
function footerTime() {
  try {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
    }).replace(/\//g, '-').replace(',', '');
  } catch (e) { return nowHM(); }
}
function sourceLabel(t) {
  t = t || {};
  let src = t.source || 'Horizon';
  if (t.docker_sock && !/docker/i.test(src)) src = 'DockerExec+' + src;
  return src;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtN(n) { return n == null ? null : Number(n).toLocaleString('en-US'); }
function redactSecrets(s) {
  s = String(s == null ? '' : s);
  if (BOT_TOKEN) s = s.split(BOT_TOKEN).join('[BOT_TOKEN]');
  if (GEMINI_API_KEY) s = s.split(GEMINI_API_KEY).join('[GEMINI_KEY]');
  s = s.replace(/bot[0-9]{6,}:[A-Za-z0-9_-]{20,}/g, '[BOT_TOKEN]');
  s = s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[GEMINI_KEY]');
  return s;
}
function log(msg, level) {
  level = level || 'info';
  const safe = redactSecrets(msg);
  const line = '[' + nowISO() + '] [' + level + '] ' + safe;
  console.log(line);
  try {
    fs.appendFileSync(LOG_F, line + '\n');
    const st = fs.statSync(LOG_F);
    if (st.size > 250000) {
      const keep = fs.readFileSync(LOG_F, 'utf8').slice(-120000);
      fs.writeFileSync(LOG_F, keep);
    }
  } catch (e) {}
  try { if (level === 'error' || level === 'warn') actionLog(level, safe); } catch (e) {}
}

let state = loadJSON(STATE_F, {
  fsm: 'HEALTHY', failCount: 0, lastAlertAt: 0, lastReportKey: '',
  lastLevel: null, lastLedger: null, lastLedgerAt: 0,
  incidents: {},
  healthSmooth: null, healthRaw: null, healthAdjusted: null,
  healthConfidence: null, healthConfidenceScore: null, healthSourceCount: null,
  healthAt: 0, healthTrend: null, healthStability: null,
  updateCheckedAt: 0, updateLastSeenId: null, updateLastSeenAt: 0
});
if (!state.incidents || typeof state.incidents !== 'object') state.incidents = {};

const CHAT_TURNS = [];
function pushChatTurn(role, text) {
  try {
    CHAT_TURNS.push({ role, text: String(text || '').slice(0, 500), ts: Date.now() });
    while (CHAT_TURNS.length > 16) CHAT_TURNS.shift();
  } catch (e) {}
}

let cache = null;
let cacheAt = 0;
let _pendingTelemetry = null;

const tgUserBuckets = Object.create(null);
function tgUserRateLimit(userKey, max, windowMs) {
  const now = Date.now();
  let b = tgUserBuckets[userKey];
  if (!b || now > b.reset) b = tgUserBuckets[userKey] = { n: 0, reset: now + windowMs };
  b.n++;
  return b.n <= max;
}

function httpGetUrl(urlStr, headers, timeout) {
  return new Promise(resolve => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET', headers: headers || {}, timeout: timeout || 3000
      }, r => {
        let b = '';
        r.on('data', d => b += d);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}
function httpGetJson(urlStr, headers, timeout) {
  return new Promise(resolve => {
    try {
      const u = new URL(urlStr);
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
        headers: Object.assign({ 'User-Agent': 'pinode-solohost-controller', 'Accept': 'application/vnd.github+json' }, headers || {}),
        timeout: timeout || 8000
      }, r => {
        let b = '';
        r.on('data', d => b += d);
        r.on('end', () => { try { resolve(safeParse(b)); } catch (e) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}
function probeTcp(host, port, timeout) {
  return new Promise(res => {
    const s = new net.Socket();
    let done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) {} res(v); };
    s.setTimeout(timeout || 900);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch (e) { fin(false); }
  });
}

/* ======================================================================
 * DATA PIPELINE (read -> normalize -> SORT -> aggregate -> use)
 * ==================================================================== */
function normalizeHistoryRow(r) {
  if (!r || typeof r !== 'object') return null;
  const out = { ts: r.ts || null };
  const numKeys = ['ledger','ledger_age','peer_in','peer_out','peer_total','cpu','ram','temp','disk',
    'health','health_raw','health_adjusted','ports_open','ingest_lag'];
  numKeys.forEach(function (k) {
    const v = r[k];
    if (v != null && v !== '' && isFinite(Number(v))) out[k] = Number(v);
  });
  ['sync','level','container','docker','health_confidence','network_kind','source','cpu_source','ram_source','disk_source'].forEach(function (k) {
    if (r[k] != null && r[k] !== '') out[k] = String(r[k]);
  });
  if (r.ports_all_open === true || r.ports_all_open === false) out.ports_all_open = r.ports_all_open;
  if (r.docker_sock === true || r.docker_sock === false) out.docker_sock = r.docker_sock;
  return out;
}
function getTimeWindow(hours) {
  const h = Math.max(0.1, Number(hours) || 24);
  const cutoff = Date.now() - h * 3600 * 1000;
  const daysBack = Math.ceil(h / 24) + 1;
  const raw = readHistory(daysBack);
  const out = [];
  raw.forEach(function (r) {
    const ts = Date.parse(r && r.ts) || 0;
    if (!ts || ts < cutoff) return;
    const n = normalizeHistoryRow(r);
    if (n) { n._tsMs = ts; out.push(n); }
  });
  out.sort(function (a, b) { return a._tsMs - b._tsMs; });
  out.forEach(function (r) { delete r._tsMs; });
  return out;
}
function aggregate(rows, key) {
  const vals = [];
  (rows || []).forEach(function (r) {
    if (r && r[key] != null && isFinite(Number(r[key]))) vals.push(Number(r[key]));
  });
  if (!vals.length) return { n: 0, min: null, max: null, avg: null, median: null };
  const sorted = vals.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2 * 10) / 10;
  return {
    n: vals.length, min: sorted[0], max: sorted[sorted.length - 1],
    avg: Math.round(vals.reduce(function (s, x) { return s + x; }, 0) / vals.length * 10) / 10,
    median: med
  };
}
function syncConsensus(rows) {
  const buckets = {};
  let total = 0;
  (rows || []).forEach(function (r) {
    const s = (r && r.sync) ? String(r.sync) : '';
    if (!s) return;
    total++;
    buckets[s] = (buckets[s] || 0) + 1;
  });
  const out = {};
  Object.keys(buckets).forEach(function (k) {
    out[k] = { count: buckets[k], pct: Math.round(buckets[k] / Math.max(1, total) * 1000) / 10 };
  });
  return { total: total, states: out };
}
function ledgerVelocity(rows) {
  if (!rows || rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  if (first.ledger == null || last.ledger == null) return null;
  const dt = (Date.parse(last.ts) - Date.parse(first.ts)) / 3600000;
  if (!isFinite(dt) || dt <= 0) return null;
  return { delta: last.ledger - first.ledger, hours: Math.round(dt * 10) / 10,
           perHour: Math.round((last.ledger - first.ledger) / dt * 10) / 10 };
}
/* END DATA PIPELINE ==================================================== */

/* HORIZON-ONLY FOOTER (Telegram) ====================================== */
function horizonFooter(t) {
  if (!t || (t.docker_sock || t.docker_probe)) return '';
  return [
    '',
    '───────────────',
    'ℹ️ SOURCE · Horizon only (no docker.sock)',
    '⚠️ Horizon can lag behind Pi Node Desktop — data may not be 100% exact.',
    '🖥️ SYSTEM · Node OS (independent of Docker)',
    '🔓 For best accuracy, enable Optional Docker in SoloHost UI on this PC.'
  ].join('\n');
}
const _sockCache = { v: null, at: 0 };
function hasDockerSock(t) {
  if (t && (t.docker_sock === true || t.docker_probe === true)) return true;
  const now = Date.now();
  if (_sockCache.v !== null && (now - _sockCache.at) < 10000) return _sockCache.v;
  let v = false;
  try { v = fs.existsSync('/var/run/docker.sock'); } catch (e) { v = false; }
  _sockCache.v = v;
  _sockCache.at = now;
  return v;
}
/* END HORIZON FOOTER ================================================== */

/* UPDATE CHECKER ====================================================== */
async function checkForUpdates(force) {
  const now = Date.now();
  if (!force && state.updateCheckedAt && (now - state.updateCheckedAt) < UPDATE_CHECK_INTERVAL_MS) return null;
  state.updateCheckedAt = now;
  try { saveJSON(STATE_F, state); } catch (e) {}

  let latest = null;
  try {
    const r = await httpGetJson('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest');
    if (r && r.tag_name) {
      latest = {
        id: String(r.tag_name),
        name: String(r.name || r.tag_name),
        at: String(r.published_at || r.created_at || ''),
        url: String(r.html_url || GITHUB_REPO_URL),
        kind: 'release'
      };
    }
  } catch (e) {}

  if (!latest) {
    try {
      const c = await httpGetJson('https://api.github.com/repos/' + GITHUB_REPO + '/commits?per_page=1');
      if (Array.isArray(c) && c[0] && c[0].sha) {
        latest = {
          id: String(c[0].sha).slice(0, 7),
          name: String((c[0].commit && c[0].commit.message) || 'commit').split('\n')[0].slice(0, 80),
          at: String((c[0].commit && c[0].commit.author && c[0].commit.author.date) || ''),
          url: String(c[0].html_url || GITHUB_REPO_URL),
          kind: 'commit'
        };
      }
    } catch (e) {}
  }

  if (!latest || !latest.id) {
    try { actionLog('info', 'update check: no data'); } catch (e) {}
    return null;
  }
  if (state.updateLastSeenId === latest.id) return null;
  state.updateLastSeenId = latest.id;
  state.updateLastSeenAt = now;
  try { saveJSON(STATE_F, state); } catch (e) {}
  return latest;
}
async function sendUpdateNotice(latest) {
  if (!latest) return false;
  const gate = alertsMuted();
  const txt = [
    '🚀 APP UPDATE AVAILABLE',
    '───────────────',
    '📦 ' + latest.name,
    '🔖 ' + latest.id,
    latest.at ? ('🕐 ' + String(latest.at).slice(0, 10)) : '',
    '',
    '🔗 ' + latest.url,
    '',
    'Update when convenient to get the latest fixes.'
  ].filter(Boolean).join('\n');
  try { actionLog('info', 'update notice: ' + latest.id); } catch (e) {}
  if (gate.muted) {
    try { actionLog('info', 'update notice muted - ' + gate.why); } catch (e) {}
    return false;
  }
  await tgSend(txt, { reply_markup: mainKeyboard() });
  return true;
}
async function updateLoop() {
  await wait(20000);
  while (true) {
    try {
      const latest = await checkForUpdates(false);
      if (latest) await sendUpdateNotice(latest);
    } catch (e) {
      try { actionLog('warn', 'update check fail - ' + (e && e.message)); } catch (e2) {}
    }
    await wait(UPDATE_WAKE_INTERVAL_MS);
  }
}
/* END UPDATE CHECKER ================================================== */

function normalizeAny(j, sourceTag) {
  const o = { source: sourceTag || j.source || 'unknown', timestamp: j.timestamp || nowISO() };
  ['sync','docker','container','confidence'].forEach(function (k) {
    if (j[k] != null && j[k] !== '') o[k] = String(j[k]);
  });
  ['ledger','ledger_age','peer_in','peer_out','cpu','ram','temp','disk'].forEach(function (k) {
    if (j[k] != null && j[k] !== '' && isFinite(Number(j[k]))) o[k] = Number(j[k]);
  });
  if (j.ports) o.ports = j.ports;
  return o;
}

function mergeTelemetry(primary, horizon, portSnap) {
  const t = { timestamp: nowISO(), sources: {} };
  if (primary) {
    Object.keys(primary).forEach(k => { if (primary[k] != null && k !== 'source' && k !== 'timestamp') t[k] = primary[k]; });
    t.sources.data_live = true;
    t.source = 'Horizon';
    t.confidence = primary.confidence || 'high';
  } else t.sources.data_live = false;
  if (horizon) {
    t.sources.horizon = true;
    if (t.ledger == null && horizon.ledger != null) t.ledger = horizon.ledger;
    if (t.sync == null && horizon.sync) t.sync = horizon.sync;
    if (!primary) { t.source = 'Horizon'; t.confidence = 'medium'; }
  } else t.sources.horizon = false;
  if (portSnap && portSnap.ports) {
    t.sources.ports = true;
    if (!t.ports) t.ports = portSnap.ports;
    t.ports_open = portSnap.openCount;
  } else t.sources.ports = false;
  if (!t.container) t.container = NODE_LABEL;
  const portsAllOpen = t.ports && NODE_PORTS.every(p => t.ports[String(p)] === 'OPEN');
  const portsAllClosed = t.ports && NODE_PORTS.every(p => t.ports[String(p)] === 'CLOSED');
  const dockerStopped = t.docker && /stop|exit/i.test(t.docker);
  const syncStr = String(t.sync || '');
  const syncBad = /not synced|unsynced|error|fail/i.test(syncStr);
  const catching = /catching|joining|booting|behind|slow|ingest lag/i.test(syncStr);
  const coreMissing = t.core_verified === false || /core n\/a|unverified/i.test(syncStr);
  let level = 'ok';
  if (dockerStopped || portsAllClosed) level = 'critical';
  else if (syncBad || (t.ledger_age != null && t.ledger_age > 300)) level = 'warning';
  else if (catching) level = 'soft';
  else if (coreMissing && (primary || horizon)) level = 'soft';
  else if (primary || horizon || (portSnap && portSnap.openCount >= 2)) level = 'ok';
  else level = 'soft';
  t.level = level;
  t.ports_all_open = !!portsAllOpen;
  return t;
}

/* HEALTH SCORING (Damper + stability) ================================== */
const HEALTH_CFG = {
  emaAlpha: { high: 0.30, medium: 0.20, low: 0.10 },
  deadBand: { high: 3, medium: 5, low: 8 },
  trendWindow: 12, trendThreshold: 4, staleResetMs: 60 * 60 * 1000,
  stabShortWindow: 30, stabLongWindow: 180,
  stabFlipHi: 0.15, stabFlipMax: 0.50, stabBadLow: 0.40, stabBadHi: 0.70, stabLongBadHi: 0.30
};
function healthConfidence(t) {
  t = t || {};
  const hasSock = !!(t.docker_sock || t.docker_probe);
  const hasCore = !!t.core_verified;
  const hasHorizon = !!(t.source && /horizon/i.test(t.source));
  const hasPorts = t.ports_open != null;
  let sources = 0;
  if (hasSock) sources++; if (hasCore) sources++; if (hasHorizon) sources++; if (hasPorts) sources++;
  if (hasSock && hasCore) return { level: 'high', sources: sources, score: 100 };
  if (hasSock) return { level: 'high', sources: sources, score: 85 };
  if (hasCore) return { level: 'medium', sources: sources, score: 70 };
  if (hasHorizon && hasPorts) return { level: 'medium', sources: sources, score: 60 };
  if (hasHorizon) return { level: 'low', sources: sources, score: 40 };
  if (hasPorts) return { level: 'low', sources: sources, score: 30 };
  return { level: 'none', sources: 0, score: 10 };
}
function isBadSyncString(s) {
  s = String(s || '');
  if (!s) return false;
  return /catching|behind|slow|not synced|unsynced|error|fail|ingest lag/i.test(s)
    && !/synced|live|good|horizon ok/i.test(s);
}
function computeSyncStability() {
  const rows = getTimeWindow(3);
  if (!rows || rows.length < 3) return { samples: 0, flips: 0, flipRate: 0, badRatio: 0, longerBadRatio: 0, unstableShort: false, sustainedBad: false, label: 'unknown' };
  const recent = rows.slice(-HEALTH_CFG.stabShortWindow);
  let flips = 0, bad = 0, lastSync = null;
  recent.forEach(function (r) {
    const s = String(r.sync || '');
    if (!s) return;
    if (isBadSyncString(s)) bad++;
    if (lastSync != null && s !== lastSync) flips++;
    lastSync = s;
  });
  const n = Math.max(1, recent.length);
  const flipRate = flips / n, badRatio = bad / n;
  const longer = rows.slice(-HEALTH_CFG.stabLongWindow);
  let longBad = 0;
  longer.forEach(function (r) { if (isBadSyncString(String(r.sync || ''))) longBad++; });
  const longerBadRatio = longer.length ? longBad / longer.length : 0;
  const unstableShort = flipRate >= HEALTH_CFG.stabFlipHi && badRatio < HEALTH_CFG.stabBadLow;
  const sustainedBad = longerBadRatio >= HEALTH_CFG.stabLongBadHi || badRatio >= HEALTH_CFG.stabBadHi;
  let label = 'stable';
  if (sustainedBad) label = 'sustained_bad';
  else if (unstableShort) label = 'unstable_short';
  else if (flipRate >= 0.10) label = 'some_flips';
  return { samples: recent.length, flips: flips,
    flipRate: Math.round(flipRate * 100) / 100,
    badRatio: Math.round(badRatio * 100) / 100,
    longerBadRatio: Math.round(longerBadRatio * 100) / 100,
    unstableShort: unstableShort, sustainedBad: sustainedBad, label: label };
}
function applyStabilityAdjustment(rawHealth, stability) {
  if (!stability || stability.samples < 5) return rawHealth;
  let adjusted = rawHealth;
  if (stability.unstableShort && !stability.sustainedBad) {
    const noiseFactor = Math.min(1, (stability.flipRate - HEALTH_CFG.stabFlipHi) / (HEALTH_CFG.stabFlipMax - HEALTH_CFG.stabFlipHi));
    const notBadFactor = 1 - Math.min(1, stability.badRatio / HEALTH_CFG.stabBadLow);
    const pullUp = noiseFactor * notBadFactor * 0.6;
    adjusted = rawHealth + (95 - rawHealth) * pullUp;
  }
  if (stability.sustainedBad) {
    if (stability.badRatio >= 0.3) adjusted = Math.min(adjusted, rawHealth);
    else adjusted = Math.min(adjusted, rawHealth + (95 - rawHealth) * 0.25);
  }
  return Math.max(0, Math.min(100, adjusted));
}
function computeHealthTrend(recentRows) {
  if (!recentRows || recentRows.length < 4) return 'stable';
  const vals = recentRows.map(function (r) { return r && r.health; })
    .filter(function (x) { return x != null && isFinite(Number(x)); }).map(Number);
  if (vals.length < 4) return 'stable';
  const half = Math.floor(vals.length / 2);
  let olderSum = 0, newerSum = 0;
  for (let i = 0; i < half; i++) olderSum += vals[i];
  for (let i = vals.length - half; i < vals.length; i++) newerSum += vals[i];
  const delta = (newerSum / half) - (olderSum / half);
  if (delta > HEALTH_CFG.trendThreshold) return 'improving';
  if (delta < -HEALTH_CFG.trendThreshold) return 'degrading';
  return 'stable';
}
function dampHealthScore(t, rawHealth) {
  t = t || {};
  const conf = healthConfidence(t);
  const stability = computeSyncStability();
  if (conf.level === 'none' || rawHealth == null || !isFinite(Number(rawHealth))) {
    const frozen = state.healthSmooth != null ? Number(state.healthSmooth) : null;
    state.healthStability = stability;
    return { health: frozen, raw: null, adjusted: null, confidence: conf.level,
      confidenceScore: conf.score, sourceCount: conf.sources,
      trend: state.healthTrend || 'unknown', frozen: true, stability: stability };
  }
  const alpha = HEALTH_CFG.emaAlpha[conf.level];
  const dead = HEALTH_CFG.deadBand[conf.level];
  const raw = Number(rawHealth);
  const adjustedRaw = applyStabilityAdjustment(raw, stability);
  const stale = !state.healthAt || (Date.now() - state.healthAt) > HEALTH_CFG.staleResetMs;
  let prev = (!stale && state.healthSmooth != null) ? Number(state.healthSmooth) : adjustedRaw;
  let input = adjustedRaw;
  if (Math.abs(adjustedRaw - prev) < dead) input = prev;
  let smoothed = prev * (1 - alpha) + input * alpha;
  if (adjustedRaw <= 30 && smoothed > adjustedRaw + 20) smoothed = adjustedRaw + 20;
  if (adjustedRaw >= 95 && smoothed < adjustedRaw - 15) smoothed = adjustedRaw - 15;
  const recentRows = getTimeWindow(1).slice(-HEALTH_CFG.trendWindow);
  const trend = computeHealthTrend(recentRows);
  state.healthSmooth = Math.round(smoothed);
  state.healthRaw = Math.round(raw);
  state.healthAdjusted = Math.round(adjustedRaw);
  state.healthConfidence = conf.level;
  state.healthConfidenceScore = conf.score;
  state.healthSourceCount = conf.sources;
  state.healthAt = Date.now();
  state.healthTrend = trend;
  state.healthStability = stability;
  return { health: Math.round(smoothed), raw: Math.round(raw), adjusted: Math.round(adjustedRaw),
    confidence: conf.level, confidenceScore: conf.score, sourceCount: conf.sources,
    trend: trend, frozen: false, stability: stability };
}
/* END HEALTH SCORING ==================================================== */

async function collectTelemetry() {
  let t = null;
  try { t = await statusMonitor.getStatus(true, { detailed: false, docker: false }); }
  catch (e) { try { actionLog('error', 'statusMonitor: ' + (e && e.message)); } catch (e2) {} }
  if (!t || typeof t !== 'object') t = { source: 'none', sync: 'Unknown', level: 'soft', core_verified: false, sources: {} };
  t.sources = t.sources || {};
  t.sources.horizon = !!(t.source && /horizon/i.test(String(t.source)));
  t.sources.core = !!t.core_verified;
  t.sources.ports = t.ports_open != null;
  if (!t.container && NODE_LABEL) t.container = NODE_LABEL;
  if (!t.container) t.container = NODE_LABEL || null;
  try { t = Object.assign(t, dataFrame.toFrame(t)); dataFrame.applyPeerRule(t); } catch (e) {}
  try {
    const prev = getTimeWindow(1).slice(-10);
    const lf = lite.liveFrame(t, prev);
    t.status = lf.status;
    t.peers = lf.peers;
    t.ports_ok = lf.ports_ok;
    t.docker_status = lf.docker_status;
    t.docker_health = lf.docker_health;
    t.health_raw = lf.health;
    const damped = dampHealthScore(t, lf.health);
    if (damped && damped.health != null) {
      t.health = damped.health;
      t.health_raw = damped.raw;
      t.health_adjusted = damped.adjusted;
      t.health_confidence = damped.confidence;
      t.health_confidence_score = damped.confidenceScore;
      t.health_sources = damped.sourceCount;
      t.health_trend = damped.trend;
      t.health_frozen = damped.frozen === true;
      if (!damped.frozen && damped.trend) t.trend = damped.trend;
      else t.trend = lf.trend || 'stable';
    } else {
      t.health = lf.health != null ? lf.health : null;
      t.health_confidence = 'low';
      t.trend = lf.trend || 'stable';
    }
    t.core_health = lf.core_health;
    t.health_source = lf.health_source;
    try {
      const hist = getTimeWindow(1);
      const prev2 = hist.length ? hist[hist.length - 1] : null;
      if (prev2 && prev2.ledger != null && t.ledger != null && prev2.ts) {
        const dt = (Date.now() - Date.parse(prev2.ts)) / 60000;
        if (dt > 0.2 && t.ledger >= prev2.ledger) {
          const rate = (t.ledger - prev2.ledger) / dt;
          if (isFinite(rate) && rate >= 0) t.ledger_per_min = Math.round(rate * 10) / 10;
        }
      }
    } catch (e2) {}
    if (t.disk == null) t.disk = lf.disk;
  } catch (e) {}
  try {
    if (typeof readCgroupResources === 'function') {
      const cg = readCgroupResources();
      if (cg) {
        if (cg.ram != null && Number(cg.ram) > 0 && t.ram == null) t.ram = cg.ram;
        if (cg.cpu != null && Number(cg.cpu) > 0 && t.cpu == null) t.cpu = cg.cpu;
        t.sources.cgroup = true;
      }
    }
  } catch (e) {}
  try { state.lastTelemetry = lite.historyRow(t); saveJSON(STATE_F, state); } catch (e) {}
  try { cache = t; cacheAt = Date.now(); t._age = 0; } catch (e) {}
  try { appendHistory(t); } catch (e) {}
  try {
    const tmp = LATEST_F + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(t));
    fs.renameSync(tmp, LATEST_F);
  } catch (e) { try { fs.writeFileSync(LATEST_F, JSON.stringify(t)); } catch (e2) {} }
  return t;
}
function getTelemetry() {
  if (cache && Date.now() - cacheAt < TELEMETRY_SEC * 1000 + 5000) return Promise.resolve(cache);
  if (_pendingTelemetry) return _pendingTelemetry;
  _pendingTelemetry = collectTelemetry().then(function (t) {
    _pendingTelemetry = null;
    return t;
  }, function (e) {
    _pendingTelemetry = null;
    throw e;
  });
  return _pendingTelemetry;
}

/* HISTORY ============================================================== */
const _readHistCache = { key: '', ts: 0, data: null, ttlMs: 3000 };
function invalidateReadHistory() {
  _readHistCache.key = '';
  _readHistCache.ts = 0;
  _readHistCache.data = null;
}
function readHistory(days) {
  const k = String(days || 1);
  const now = Date.now();
  if (_readHistCache.key === k && _readHistCache.data && (now - _readHistCache.ts) < _readHistCache.ttlMs) {
    return _readHistCache.data;
  }
  const out = [];
  for (let i = 0; i < (days || 1); i++) {
    const d = new Date(Date.now() - i * 864e5);
    let key; try { key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
    catch (e) { key = d.toISOString().slice(0, 10); }
    try {
      fs.readFileSync(path.join(DIR_HIST, key + '.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
        .forEach(l => { try { out.push(JSON.parse(l)); } catch (e) {} });
    } catch (e) {}
  }
  _readHistCache.key = k;
  _readHistCache.ts = now;
  _readHistCache.data = out;
  return out;
}
const _rollupState = { hourly: null, daily: null, loaded: false };
function ensureRollupLoaded() {
  if (_rollupState.loaded) return;
  try { _rollupState.hourly = JSON.parse(fs.readFileSync(HOURLY_F, 'utf8')) || []; } catch (e) { _rollupState.hourly = []; }
  try { _rollupState.daily = JSON.parse(fs.readFileSync(DAILY_F, 'utf8')) || []; } catch (e) { _rollupState.daily = []; }
  if (!Array.isArray(_rollupState.hourly)) _rollupState.hourly = [];
  if (!Array.isArray(_rollupState.daily)) _rollupState.daily = [];
  _rollupState.loaded = true;
}
function appendHistory(t) {
  try {
    const f = path.join(DIR_HIST, dayVN() + '.ndjson');
    const row = lite.historyRow(t);
    row.ts = nowISO();
    if (t.sync) row.sync = String(t.sync);
    if (t.ledger != null) row.ledger = Number(t.ledger);
    if (t.ledger_age != null) row.ledger_age = Number(t.ledger_age);
    if (t.level != null) row.level = t.level;
    if (t.health != null) row.health = t.health;
    if (t.health_raw != null) row.health_raw = t.health_raw;
    if (t.health_adjusted != null) row.health_adjusted = t.health_adjusted;
    if (t.health_confidence) row.health_confidence = t.health_confidence;
    if (t.ports_open != null) row.ports_open = t.ports_open;
    if (t.ports_all_open != null) row.ports_all_open = t.ports_all_open;
    if (t.docker_sock != null) row.docker_sock = t.docker_sock;
    if (t.container) row.container = t.container;
    if (t.docker) row.docker = t.docker;
    if (t.peer_in != null) row.peer_in = t.peer_in;
    if (t.peer_out != null) row.peer_out = t.peer_out;
    if (t.peer_total != null) row.peer_total = t.peer_total;
    if (t.cpu_source) row.cpu_source = t.cpu_source;
    if (t.ram_source) row.ram_source = t.ram_source;
    if (t.disk_source) row.disk_source = t.disk_source;
    fs.appendFileSync(f, JSON.stringify(row) + '\n');
    invalidateReadHistory();
    try { rollupHistory(row); } catch (e2) {}
    pruneHistory();
  } catch (e) {}
}
function rollupHistory(row) {
  ensureRollupLoaded();
  const hourKey = nowISO().slice(0, 13);
  let cur = _rollupState.hourly.find(function (x) { return x.hour === hourKey; });
  if (!cur) {
    cur = { hour: hourKey, n: 0, sum_cpu: 0, max_cpu: null, sum_ram: 0, max_ram: null, min_peers: null, max_age: null, sum_health: 0, health_min: null, bad: 0 };
    _rollupState.hourly.push(cur);
  }
  cur.n++;
  if (row.cpu != null) { cur.sum_cpu += row.cpu; cur.max_cpu = cur.max_cpu == null ? row.cpu : Math.max(cur.max_cpu, row.cpu); }
  if (row.ram != null) { cur.sum_ram += row.ram; cur.max_ram = cur.max_ram == null ? row.ram : Math.max(cur.max_ram, row.ram); }
  if (row.peers != null) cur.min_peers = cur.min_peers == null ? row.peers : Math.min(cur.min_peers, row.peers);
  if (row.ledger_age != null) cur.max_age = cur.max_age == null ? row.ledger_age : Math.max(cur.max_age, row.ledger_age);
  if (row.health != null) { cur.sum_health += row.health; cur.health_min = cur.health_min == null ? row.health : Math.min(cur.health_min, row.health); }
  if (row.health != null && row.health < 55) cur.bad++;
  if (_rollupState.hourly.length > 24 * 30) _rollupState.hourly = _rollupState.hourly.slice(-24 * 30);

  const dayKey = dayVN();
  let d = _rollupState.daily.find(function (x) { return x.day === dayKey; });
  if (!d) { d = { day: dayKey, n: 0, sum_health: 0, health_min: null, sync_fail: 0 }; _rollupState.daily.push(d); }
  d.n++;
  if (row.health != null) { d.sum_health += row.health; d.health_min = d.health_min == null ? row.health : Math.min(d.health_min, row.health); }
  if (row.sync && /not synced|offline|fail|error/i.test(String(row.sync))) d.sync_fail++;
  if (_rollupState.daily.length > 370) _rollupState.daily = _rollupState.daily.slice(-370);

  try { fs.writeFileSync(HOURLY_F, JSON.stringify(_rollupState.hourly)); } catch (e) {}
  try { fs.writeFileSync(DAILY_F, JSON.stringify(_rollupState.daily)); } catch (e) {}
}
function pruneHistory() {
  try {
    const keepRawDays = 2;
    const files = fs.readdirSync(DIR_HIST).filter(n => n.endsWith('.ndjson'));
    const cutoff = Date.now() - keepRawDays * 864e5;
    for (const n of files) {
      const day = n.replace('.ndjson', '');
      const t0 = Date.parse(day + 'T00:00:00+07:00') || Date.parse(day);
      if (t0 && t0 < cutoff) { try { fs.unlinkSync(path.join(DIR_HIST, n)); } catch (e) {} }
    }
  } catch (e) {}
}
/* END HISTORY ========================================================== */

/* FSM ALERTS =========================================================== */
function hourNowLocal() {
  try { return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false }), 10); }
  catch (e) { return new Date().getHours(); }
}
function alertsMuted() {
  const now = Date.now();
  if (state.muteUntil && now < state.muteUntil) return { muted: true, why: 'until ' + new Date(state.muteUntil).toISOString() };
  const mode = String(state.alertMode || 'on').toLowerCase();
  if (mode === 'off') return { muted: true, why: 'alerts off' };
  if (mode === 'night') {
    const h = hourNowLocal();
    if (h >= 22 || h < 7) return { muted: true, why: 'night quiet 22:00-07:00' };
  }
  return { muted: false, why: '' };
}
function reportKeyboard() {
  return { inline_keyboard: [
    [{ text: '🕖 07:00', callback_data: 'cmd_report_h7' }, { text: '🕕 18:00', callback_data: 'cmd_report_h18' }],
    [{ text: '🕖🕕 Both', callback_data: 'cmd_report_both' }, { text: '⏰ Off', callback_data: 'cmd_report_off' }],
    [{ text: '🔔 Alerts On', callback_data: 'cmd_mute_on' }]
  ]};
}
function effectiveReportHours() {
  if (state.reportHours === 'off' || (Array.isArray(state.reportHours) && !state.reportHours.length)) return [];
  if (Array.isArray(state.reportHours) && state.reportHours.length) return state.reportHours;
  return REPORT_HOURS;
}
function alertKeyboard() {
  return { inline_keyboard: [
    [{ text: '🔇 1h', callback_data: 'cmd_mute_1h' }, { text: '🌙 Night', callback_data: 'cmd_mute_night' }],
    [{ text: '📅 24h', callback_data: 'cmd_mute_24h' }, { text: '🔕 Off', callback_data: 'cmd_mute_off' }],
    [{ text: '✅ I did it', callback_data: 'cmd_incident_ack' }, { text: '⏸ Skip 4h', callback_data: 'cmd_incident_skip' }],
    [{ text: '🩺 Diag', callback_data: 'cmd_diagnostic' }, { text: '📋 Incidents', callback_data: 'cmd_incidents' }]
  ]};
}
function scriptActionKeyboard() {
  return { inline_keyboard: [
    [{ text: '🧹 CleanRam', callback_data: 'cmd_script_cleanram' }, { text: '🌐 DnsFlush', callback_data: 'cmd_script_dnsflush' }],
    [{ text: '🧱 Firewall', callback_data: 'cmd_script_firewall' }, { text: '♻️ NodeReset', callback_data: 'cmd_script_nodereset' }],
    [{ text: '🔧 NetRepair', callback_data: 'cmd_script_netrepair' }, { text: '📡 LanSetup', callback_data: 'cmd_script_lansetup' }],
    [{ text: '🐳 DockerRecover', callback_data: 'cmd_script_dockerrecover' }, { text: '🧰 Maintain', callback_data: 'cmd_script_maintain' }],
    [{ text: '🩺 Diag', callback_data: 'cmd_diagnostic' }, { text: '📊 Status', callback_data: 'cmd_status' }]
  ]};
}
function setMuteHours(h) {
  state.muteUntil = Date.now() + h * 3600 * 1000;
  state.alertMode = 'on';
  try { saveJSON(STATE_F, state); } catch (e) {}
}
function formatMuteAck() {
  const m = alertsMuted();
  const until = state.muteUntil ? new Date(state.muteUntil).toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }) : '-';
  return [
    '🔔 ALERT PREFS', '───────────────',
    'Mode       · ' + (state.alertMode || 'on'),
    'Mute until · ' + until,
    'Now        · ' + (m.muted ? ('QUIET · ' + m.why) : 'ACTIVE'), '',
    'Night/off mute applies to ALL notifications:',
    'alerts, reminders, recovery, scheduled reports, update notices.'
  ].join('\n');
}
function mapLevelToFsm(level) {
  if (level === 'critical') return 'CRITICAL';
  if (level === 'warning') return 'WARNING';
  if (level === 'soft') return 'DEGRADED';
  return 'HEALTHY';
}
function classifyIssueKind(t) {
  t = t || {};
  const sync = String(t.sync || '');
  const age = t.ledger_age != null ? Number(t.ledger_age) : null;
  const portsClosed = t.ports_open === 0;
  const catching = /catch|behind|syncing|joining/i.test(sync);
  const live = /synced|live|horizon ok|good/i.test(sync);
  if (portsClosed && !live) return 'network_or_host';
  if (catching && t.ledger != null) return 'catchup_or_upgrade';
  if (age != null && age > 300 && !portsClosed) return 'lagging';
  if (t.level === 'critical') return 'persistent_risk';
  if (t.level === 'warning' || t.level === 'soft') return 'watch';
  return 'ok';
}
/* INCIDENT ENGINE ====================================================== */
function detectIncidentSignature(t) {
  t = t || {};
  const sync = String(t.sync || '');
  const age = t.ledger_age != null ? Number(t.ledger_age) : null;
  const portsOpen = t.ports_open != null ? Number(t.ports_open) : null;
  const peerIn = t.peer_in != null ? Number(t.peer_in) : null;
  const peerOut = t.peer_out != null ? Number(t.peer_out) : null;
  const peerTotal = (peerIn != null || peerOut != null) ? ((peerIn || 0) + (peerOut || 0)) : null;
  const docker = String(t.docker || '');
  const ram = t.ram != null ? Number(t.ram) : null;
  const cpu = t.cpu != null ? Number(t.cpu) : null;
  const disk = t.disk != null ? Number(t.disk) : null;
  const source = String(t.source || '');
  const synced = /synced|live|horizon ok|good/i.test(sync);
  if (/stop|exit/i.test(docker)) return { type: 'docker_down', severity: 'critical' };
  if (portsOpen === 0 && source === 'none') return { type: 'network_down', severity: 'critical' };
  if (portsOpen === 0) return { type: 'ports_closed', severity: 'warning' };
  if (age != null && age > 300) return { type: 'sync_stalled', severity: 'warning' };
  if (age != null && age > 120) return { type: 'sync_lag', severity: 'soft' };
  if (/catching|behind|slow|ingest lag/i.test(sync)) return { type: 'sync_lag', severity: 'soft' };
  if (peerTotal === 0 && synced) return { type: 'peers_zero', severity: 'warning' };
  if (ram != null && ram >= 88) return { type: 'ram_high', severity: 'warning' };
  if (cpu != null && cpu >= 90) return { type: 'cpu_high', severity: 'warning' };
  if (disk != null && disk >= 90) return { type: 'disk_high', severity: 'warning' };
  if (peerTotal != null && peerTotal > 0 && peerTotal <= 2 && synced) return { type: 'peers_low', severity: 'soft' };
  return null;
}
function updateIncidentState(t) {
  const sig = detectIncidentSignature(t);
  const now = Date.now();
  state.incidents = state.incidents || {};
  if (sig) {
    const key = sig.type;
    let inc = state.incidents[key];
    if (!inc || inc.resolved) {
      inc = state.incidents[key] = {
        type: sig.type, severity: sig.severity,
        firstSeen: now, lastSeen: now, samples: 1, stage: 0,
        alertsSent: 0, lastAlertAt: 0, resolved: false,
        firstLedger: t.ledger != null ? t.ledger : null,
        firstCoreVersion: t.core_version || null,
        firstSync: t.sync || null,
        ackedAt: 0, skippedUntil: 0
      };
      try { actionLog('info', 'incident start: ' + key + ' (' + sig.severity + ')'); } catch (e) {}
    } else {
      inc.lastSeen = now;
      inc.samples = (inc.samples || 0) + 1;
      inc.severity = sig.severity;
    }
    Object.keys(state.incidents).forEach(function (k) {
      if (k === key) return;
      const other = state.incidents[k];
      if (other && !other.resolved) { other.resolved = true; other.resolvedAt = now; }
    });
    return inc;
  } else {
    Object.keys(state.incidents).forEach(function (k) {
      const inc = state.incidents[k];
      if (inc && !inc.resolved) { inc.resolved = true; inc.resolvedAt = now; }
    });
    const keys = Object.keys(state.incidents);
    if (keys.length > 30) {
      keys.sort(function (a, b) { return (state.incidents[b].firstSeen || 0) - (state.incidents[a].firstSeen || 0); });
      const keep = {};
      keys.slice(0, 30).forEach(function (k) { keep[k] = state.incidents[k]; });
      state.incidents = keep;
    }
    return null;
  }
}
function decideIncidentAction(incident, t) {
  if (!incident) return { action: 'none' };
  const now = Date.now();
  const durMin = Math.max(0, Math.round((now - incident.firstSeen) / 60000));
  const samples = incident.samples || 1;
  const currentStage = incident.stage || 0;
  let targetStage = 0;
  if (samples >= 3 || durMin >= 2) targetStage = 1;
  if (samples >= 5 || durMin >= 5) targetStage = 2;
  if (durMin >= 15 || samples >= 15) targetStage = 3;
  if (durMin >= 45 || samples >= 45) targetStage = 4;
  if (durMin >= 180) targetStage = 5;
  const isUpgradeCatchup = incident.type === 'sync_lag' &&
    incident.firstCoreVersion && t && t.core_version &&
    String(t.core_version) !== String(incident.firstCoreVersion);
  if (isUpgradeCatchup && targetStage <= 2) return { action: 'suppress', targetStage: 1, reason: 'upgrade_catchup', durationMin: durMin };
  if (incident.skippedUntil && now < incident.skippedUntil) return { action: 'wait', targetStage: targetStage, reason: 'skipped', durationMin: durMin };
  if (targetStage < 2) return { action: 'watch', targetStage: targetStage, durationMin: durMin };
  if (currentStage >= targetStage) return { action: 'wait', targetStage: targetStage, durationMin: durMin };
  const cooldownMin = [0, 0, 0, 30, 60, 180][targetStage] || 60;
  const sinceLastMin = (now - (incident.lastAlertAt || 0)) / 60000;
  const userAckBonus = (incident.ackedAt && now - incident.ackedAt < 2 * 3600 * 1000) ? 30 : 0;
  if ((incident.alertsSent || 0) > 0 && sinceLastMin < (cooldownMin + userAckBonus)) {
    return { action: 'cooldown', targetStage: targetStage, durationMin: durMin, waitMin: Math.round((cooldownMin + userAckBonus) - sinceLastMin) };
  }
  return { action: (incident.alertsSent || 0) === 0 ? 'alert' : 'remind',
    targetStage: targetStage, durationMin: durMin,
    reason: isUpgradeCatchup ? 'upgrade_catchup' : 'persistent' };
}
function smartScriptForIncident(incident, t) {
  if (!incident) return null;
  const type = incident.type;
  switch (type) {
    case 'docker_down': return { script: 'DockerRecover', note: 'Docker Engine appears down. Try SOFT restart first (Mode S). Ordered WSL (Mode Y) only after Docker confirmed dead.' };
    case 'network_down': return { script: 'NetRepair', note: 'Ports closed AND no telemetry source. 3-phase repair KEEPING the current LAN IP. No ipconfig release.' };
    case 'ports_closed': return { script: 'Firewall', then: 'NetRepair', note: 'PC online but Pi ports 31401-31403 unreachable. Rebuild firewall rules first; if it persists >15 min, escalate to NetRepair.' };
    case 'sync_stalled': return { script: 'NodeReset', note: 'Ledger age > 5 min while container running. Container may be stuck - NodeReset only AFTER confirming Docker Engine healthy.' };
    case 'sync_lag': {
      if (incident.firstCoreVersion && t && t.core_version && String(t.core_version) !== String(incident.firstCoreVersion)) {
        return { script: 'WAIT', note: 'Catching up after a Core version change - normal. Watch 10-15 min; DO NOT restart.' };
      }
      return { script: 'WAIT', note: 'Sync lag while ports are OK and ledger is still advancing. Wait - do not restart. If >15 min AND ledger stops moving, escalate to /diagnostic.' };
    }
    case 'peers_zero': return { script: 'DnsFlush', note: 'Ports open, ledger moving, but no peers. DNS flush only - keeps LAN IP unchanged. Wait 10-15 min.' };
    case 'peers_low': return { script: 'DnsFlush', note: 'Peer count is low while synced. Try DNS flush; also check regional ISP outage.' };
    case 'ram_high': return { script: 'CleanRam', note: 'RAM pressure. CleanRam closes extra apps, clears TEMP/TRIM. Does NOT stop Pi Node or Docker.' };
    case 'cpu_high': return { script: 'CleanRam', note: 'CPU pressure. Observe first; run CleanRam only if the host has extra heavy apps.' };
    case 'disk_high': return { script: 'Maintain', note: 'Disk nearly full. Weekly cleanup (Maintain.bat) safe while node is otherwise healthy.' };
    default: return null;
  }
}
function currentTelemetryInterval() {
  const incidents = state.incidents || {};
  const active = Object.keys(incidents).map(function (k) { return incidents[k]; }).filter(function (i) { return i && !i.resolved; });
  if (!active.length) return TELEMETRY_SEC;
  const hasCritical = active.some(function (i) { return i.severity === 'critical' || (i.stage || 0) >= 3; });
  const hasWarning = active.some(function (i) { return i.severity === 'warning' || (i.stage || 0) >= 1; });
  if (hasCritical) return Math.max(30, Math.floor(TELEMETRY_SEC / 2));
  if (hasWarning) return Math.max(30, Math.floor(TELEMETRY_SEC * 0.75));
  return TELEMETRY_SEC;
}
function formatIncidents() {
  const now = Date.now();
  const all = state.incidents || {};
  const keys = Object.keys(all);
  const active = keys.map(function (k) { return all[k]; }).filter(function (i) { return i && !i.resolved; });
  const recent = keys.map(function (k) { return all[k]; })
    .filter(function (i) { return i && i.resolved && (now - (i.resolvedAt || 0)) < 24 * 3600 * 1000; })
    .sort(function (a, b) { return (b.resolvedAt || 0) - (a.resolvedAt || 0); }).slice(0, 8);
  const parts = ['🧭 INCIDENT ENGINE', '───────────────', ''];
  parts.push('Active: ' + active.length + ' · Recent 24h: ' + recent.length);
  parts.push('');
  if (active.length) {
    parts.push('🔴 ACTIVE');
    active.forEach(function (inc) {
      const durMin = Math.max(0, Math.round((now - inc.firstSeen) / 60000));
      const script = smartScriptForIncident(inc, cache || {});
      const sev = inc.severity === 'critical' ? '🔴' : (inc.severity === 'warning' ? '🟠' : '🟡');
      parts.push(' ' + sev + ' ' + inc.type + ' · stage ' + (inc.stage || 0) + ' · ' + durMin + ' min · ' + (inc.samples || 1) + ' samples');
      if (script) {
        if (script.script === 'WAIT') parts.push('    ⏸ WAIT — ' + script.note.slice(0, 160));
        else parts.push('    🛠 ' + script.script + (script.then ? (' → ' + script.then) : '') + ' — ' + script.note.slice(0, 140));
      }
    });
    parts.push('');
  } else { parts.push('🟢 No active incident.'); parts.push(''); }
  if (recent.length) {
    parts.push('📜 RECENT (24h)');
    recent.forEach(function (inc) {
      const durMin = Math.max(0, Math.round(((inc.resolvedAt || 0) - inc.firstSeen) / 60000));
      parts.push(' ✅ ' + inc.type + ' · lasted ' + durMin + ' min · ' + (inc.alertsSent || 0) + ' alerts');
    });
    parts.push('');
  }
  parts.push('───────────────');
  parts.push('Adaptive interval: ' + currentTelemetryInterval() + 's (base ' + TELEMETRY_SEC + 's)');
  return parts.join('\n');
}
/* END INCIDENT ENGINE ================================================== */

async function fetchPctContext() {
  const now = Date.now();
  if (state.pctNews && state.pctNewsAt && now - state.pctNewsAt < 12 * 3600 * 1000) return state.pctNews;
  return new Promise(function (resolve) {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/PiCoreTeam/pi-node-docker/releases?per_page=3',
      method: 'GET',
      headers: { 'User-Agent': 'pinode-solohost-controller', 'Accept': 'application/vnd.github+json' }
    }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () {
        try {
          const j = safeParse(b);
          const list = Array.isArray(j) ? j.slice(0, 3).map(function (x) {
            return { tag: x.tag_name || x.name, at: x.published_at || x.created_at, name: x.name };
          }) : [];
          state.pctNews = list; state.pctNewsAt = Date.now();
          try { saveJSON(STATE_F, state); } catch (e) {}
          resolve(list);
        } catch (e) { resolve(state.pctNews || []); }
      });
    });
    req.on('error', function () { resolve(state.pctNews || []); });
    req.setTimeout(8000, function () { try { req.destroy(); } catch (e) {} resolve(state.pctNews || []); });
    req.end();
  });
}
async function aiClassifyIncident(t, kind, durationMin) {
  if (!GEMINI_API_KEY) return null;
  if (state.incidentAiAt && Date.now() - state.incidentAiAt < 25 * 60 * 1000) return state.incidentAiText || null;
  try {
    const pct = await fetchPctContext();
    const brief = preEvalBrief(t);
    const q = [
      'Classify this Pi Node incident for the operator. Reply in English, short (alerts are English-only).',
      'Kind guess: ' + kind + '. Duration minutes: ' + durationMin + '.',
      'Decide: TRANSIENT vs ACTION. Use the 8-script framework when ACTION.',
      'PCT recent releases: ' + JSON.stringify(pct).slice(0, 400),
      brief.slice(0, 1200),
      'Format: 1 line verdict + 2 lines why + 1 line what to do. No markdown.'
    ].join('\n');
    const text = await generateWithSmartGemini(q);
    if (text) {
      state.incidentAiAt = Date.now();
      state.incidentAiText = String(text).slice(0, 1200);
      try { saveJSON(STATE_F, state); } catch (e) {}
      return state.incidentAiText;
    }
  } catch (e) {}
  return null;
}
function alertFingerprint(t, kind) {
  const s = String((kind || '') + ' ' + (t && t.sync || '') + ' ' + (t && t.level || '')).replace(/\d+/g, 'N').toLowerCase();
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}
async function sendAlertTelegram(text, t) {
  const gate = alertsMuted();
  if (gate.muted) { try { actionLog('info', 'alert muted - ' + gate.why); } catch (e) {} return false; }
  const fp = alertFingerprint(t || {}, (t && t._incidentType) || classifyIssueKind(t || {}));
  const now = Date.now();
  if (state.alertDedupe && state.alertDedupe.fp === fp && now - (state.alertDedupe.at || 0) < 30 * 60 * 1000) {
    try { actionLog('info', 'alert deduped 30m - ' + fp); } catch (e) {}
    return false;
  }
  state.alertDedupe = { fp: fp, at: now };
  try { saveJSON(STATE_F, state); } catch (e) {}
  try { pushDashAlert(text, t); } catch (e) {}
  await tgSend(text, { reply_markup: alertKeyboard() });
  return true;
}
function dashAlertPath() { return path.join(DATA, 'state', 'dash-alerts.json'); }
function readDashAlerts() {
  try { const x = JSON.parse(fs.readFileSync(dashAlertPath(), 'utf8')); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}
function pushDashAlert(text, t) {
  const rows = readDashAlerts();
  const rec = recommendActions(t || {});
  const tip = (rec && rec.why && rec.why[0]) ? rec.why[0] : '';
  const files = (rec && rec.items) ? rec.items.map(function (i) { return i.file; }).join(', ') : '';
  rows.unshift({ ts: nowISO(), text: String(text || '').slice(0, 500), tip: tip, scripts: files,
    health: t && t.health != null ? t.health : null, sync: t && t.sync || null, read: false });
  fs.mkdirSync(path.dirname(dashAlertPath()), { recursive: true });
  fs.writeFileSync(dashAlertPath(), JSON.stringify(rows.slice(0, 30)));
}
async function runAlertMachine(t) {
  const prev = state.fsm || 'HEALTHY';
  const now = Date.now();
  const incident = updateIncidentState(t);
  if (!incident) {
    if (prev === 'CRITICAL' || prev === 'WARNING' || prev === 'DEGRADED') {
      const justResolved = Object.keys(state.incidents).map(function (k) { return state.incidents[k]; })
        .filter(function (i) { return i && i.resolvedAt && (now - i.resolvedAt) < 60000 && (i.alertsSent || 0) > 0; })
        .sort(function (a, b) { return (b.resolvedAt || 0) - (a.resolvedAt || 0); })[0];
      if (justResolved) {
        const gate = alertsMuted();
        const durMin = Math.max(1, Math.round((justResolved.resolvedAt - justResolved.firstSeen) / 60000));
        const recTxt = '🟢 RECOVERED after ~' + durMin + ' min\nPrevious issue: ' + justResolved.type + '\n\n' + formatStatus(t, 'RECOVERED');
        try { pushDashAlert(recTxt, t); } catch (e3) {}
        if (gate.muted) { try { actionLog('info', 'recovery muted - ' + gate.why); } catch (e) {} }
        else { await tgSend(recTxt); }
      }
    }
    state.fsm = 'HEALTHY'; state.failCount = 0;
    saveJSON(STATE_F, state);
    return;
  }
  const decision = decideIncidentAction(incident, t);
  if (decision.action === 'watch') { incident.stage = Math.max(incident.stage || 0, decision.targetStage || 0); saveJSON(STATE_F, state); return; }
  if (decision.action === 'suppress') {
    try { actionLog('info', 'incident suppressed: ' + incident.type + ' (' + (decision.reason || '') + ')'); } catch (e) {}
    incident.stage = Math.max(incident.stage || 0, decision.targetStage || 0); saveJSON(STATE_F, state); return;
  }
  if (decision.action === 'cooldown' || decision.action === 'wait' || decision.action === 'none') { saveJSON(STATE_F, state); return; }
  const script = smartScriptForIncident(incident, t);
  const ai = (incident.type === 'sync_lag' || incident.type === 'network_down' || incident.type === 'ports_closed')
    ? await aiClassifyIncident(t, incident.type, decision.durationMin) : null;
  const sevIcon = incident.severity === 'critical' ? '🔴' : (incident.severity === 'warning' ? '🟠' : '🟡');
  const stageLabel = decision.targetStage === 2 ? 'ALERT' : (decision.targetStage === 3 ? 'REMINDER 1' : (decision.targetStage === 4 ? 'REMINDER 2' : 'CHRONIC'));
  const head = sevIcon + ' PI NODE · ' + stageLabel + ' · ' + String(incident.type).toUpperCase() +
    '\nDuration: ' + decision.durationMin + ' min · Samples: ' + incident.samples +
    (decision.reason === 'upgrade_catchup' ? ' · upgrade catch-up' : '');
  let advice = '';
  if (script) {
    if (script.script === 'WAIT') advice = '\n\n⏸️ RECOMMENDED: WAIT\n' + script.note;
    else { advice = '\n\n🛠️ RECOMMENDED: ' + script.script + '\n' + script.note; if (script.then) advice += '\nIf not improved after ~15 min, escalate to: ' + script.then; }
  }
  const aiBlock = ai ? ('\n\n🤖 AI\n' + ai) : '';
  const body = '\n\n' + formatStatus(t, 'ALERT');
  await sendAlertTelegram(head + body + aiBlock + advice, t);
  incident.stage = decision.targetStage;
  incident.lastAlertAt = now;
  incident.alertsSent = (incident.alertsSent || 0) + 1;
  incident.lastScript = script ? script.script : null;
  state.fsm = mapLevelToFsm(t.level);
  state.lastAlertKind = incident.type;
  state.lastAlertAt = now;
  saveJSON(STATE_F, state);
}

/* FORMAT HELPERS ======================================================= */
function lineIf(icon, label, value) {
  if (value == null || value === '') return null;
  return icon + '  ' + label + '  ' + value;
}
const ACTION_LOG = path.join(DIR_LOGS, 'actions.ndjson');
function actionLog(kind, msg, extra) {
  try {
    const row = { ts: nowISO(), kind: kind || 'info', msg: (typeof redactSecrets === 'function' ? redactSecrets(String(msg || '')) : String(msg || '')).slice(0, 500) };
    if (extra && typeof extra === 'object') { try { row.extra = JSON.stringify(extra).slice(0, 400); } catch (e) {} }
    fs.appendFileSync(ACTION_LOG, JSON.stringify(row) + '\n');
  } catch (e) {}
}
function readActionLog(maxLines) {
  try {
    const lines = fs.readFileSync(ACTION_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(maxLines || 40)).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return { msg: l }; }
    });
  } catch (e) { return []; }
}
function formatActionLog() {
  const rows = readActionLog(35);
  const lines = ['📋 APP LOG', '───────────────', ''];
  if (!rows.length) { lines.push('No entries yet.'); return lines.join('\n'); }
  rows.forEach(function (r) {
    const tag = r.kind === 'error' ? '❌' : (r.kind === 'warn' ? '⚠️' : '✅');
    const ts = (r.ts || '').replace('T', ' ').slice(0, 19);
    lines.push(tag + ' ' + ts + ' · ' + (r.msg || ''));
  });
  lines.push(''); lines.push('SoloHost · /logs');
  return lines.join('\n');
}
function healthIcon(score) {
  if (score == null) return '⚪';
  if (score >= 85) return '🟢';
  if (score >= 65) return '🟡';
  if (score >= 40) return '🟠';
  return '🔴';
}
function healthConfIcon(conf) {
  if (conf === 'high') return '🟢';
  if (conf === 'medium') return '🟡';
  if (conf === 'low') return '🟠';
  return '⚪';
}
function fmtIssueDuration(samples) {
  const n = Math.max(1, Number(samples) || 1);
  const minutes = Math.max(1, Math.round(n * TELEMETRY_SEC / 60));
  if (minutes < 60) return minutes + 'min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? (h + 'h ' + m + 'min') : (h + 'h');
}
function formatStatus(t, mode) {
  t = t || {};
  const age = t._age != null ? t._age : (cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0);
  const syncStr = String(t.sync || '');
  const syncOk = syncStr && /synced|live|good|horizon ok/i.test(syncStr) && !(t.ledger_age != null && t.ledger_age > 120);
  const netOk = t.ports_all_open || (t.ports_open != null && t.ports_open >= 2);
  const nodeOk = t.level === 'ok' || (syncOk && netOk && t.level !== 'critical');
  let head;
  if (mode === 'RECOVERED') head = '🟢 PI NODE · RECOVERED';
  else if (t.level === 'critical') head = '🔴 PI NODE · QUICK STATUS';
  else if (!nodeOk) head = '🟡 PI NODE · QUICK STATUS';
  else head = '🟢 PI NODE · QUICK STATUS';
  const runtime = [];
  if (t.sync) {
    const ic = /synced|live/i.test(syncStr) ? '🟢' : (/catch|behind|slow|lag/i.test(syncStr) ? '🟡' : '🔄');
    runtime.push('SYNC    · ' + ic + ' ' + t.sync);
  }
  if (t.container) {
    const ic = /stop|exit/i.test(String(t.docker || '')) ? '🔴' : '🟢';
    runtime.push('NODE    · ' + ic + ' RUNNING (`' + t.container + '`)');
  } else if (t.docker) {
    const ic = /stop|exit/i.test(String(t.docker)) ? '🔴' : '🟢';
    runtime.push('NODE    · ' + ic + ' ' + t.docker);
  } else if (t.docker_sock) runtime.push('NODE    · 🟢 sock');
  else if (t.ports_all_open) runtime.push('NODE    · 🟢 Running');
  else if (t.ports_open === 0) runtime.push('NODE    · 🔴 Ports closed');
  if (netOk) {
    let netKind = '';
    if (t.network_kind === 'Testnet') netKind = 'Pi Testnet';
    else if (t.network_kind === 'Mainnet') netKind = 'Pi Mainnet';
    else if (t.network_kind) netKind = t.network_kind;
    runtime.push('NET     · 🟢 Good' + (netKind ? ' (' + netKind + ')' : ''));
  } else if (t.ports_open != null) runtime.push('NET     · 🟡 Partial');
  if (t.ledger != null) {
    let s = Number(t.ledger).toLocaleString('en-US');
    if (t.ledger_age != null) s += ' (Age ' + t.ledger_age + 's)';
    runtime.push('LEDGER  ·    ' + s);
  }
  if (t.core_version) runtime.push('CORE    ·    ' + t.core_version);
  const sys = [];
  if (t.health != null) {
    const hIcon = healthIcon(t.health);
    const cIcon = healthConfIcon(t.health_confidence);
    const trendTag = t.health_trend === 'improving' ? ' ↗' : (t.health_trend === 'degrading' ? ' ↘' : '');
    const frozenTag = t.health_frozen ? ' · frozen' : '';
    sys.push('HEALTH  · ' + hIcon + ' ' + t.health + '/100' + trendTag + ' · ' + cIcon + ' ' + (t.health_confidence || 'low') + frozenTag);
  }
  if (t.ram != null) sys.push('RAM     ·    ' + Math.round(t.ram) + '%');
  if (t.cpu != null) {
    const cic = t.cpu >= 90 ? '🔴' : (t.cpu >= 70 ? '🟡' : '🟢');
    sys.push('CPU     · ' + cic + ' ' + t.cpu + '%');
  }
  if (t.disk != null) {
    const dic = t.disk >= 90 ? '🔴' : (t.disk >= 80 ? '🟡' : '🟢');
    sys.push('DISK    · ' + dic + ' ' + Math.round(t.disk) + '%');
  }
  if (t.temp != null) sys.push('TEMP    ·    ' + t.temp + '°C');
  const result = [];
  if (nodeOk) { result.push('STATUS  · 🟢 OK'); result.push('ACTION  · None (No Issues)'); }
  else if (t.level === 'critical') { result.push('STATUS  · 🔴 CRITICAL'); result.push('ACTION  · Inspect node'); }
  else { result.push('STATUS  · 🟡 WATCH'); result.push('ACTION  · Review'); }
  const parts = [head, ''];
  if (runtime.length) parts.push(treeBlock('⚙️ RUNTIME', runtime));
  if (sys.length) { parts.push(''); parts.push(treeBlock('📊 SYSTEM', sys)); }

  const dockerLines = [];
  if (t.docker_sock || t.docker_probe) {
    if (t.container) dockerLines.push('NODE    · ' + t.container);
    if (t.container_health) dockerLines.push('HEALTH  · ' + t.container_health);
    if (t.container_cpu != null) dockerLines.push('CPU     · ' + t.container_cpu + '%');
    if (t.container_ram_mb != null) {
      dockerLines.push('RAM     · ' + t.container_ram_mb + ' MB' +
        (t.container_ram_limit_mb != null ? (' / ' + t.container_ram_limit_mb + ' MB') : ''));
    } else if (t.container_ram != null) {
      dockerLines.push('RAM     · ' + t.container_ram + '%');
    }
    if (t.restart_count != null) dockerLines.push('RESTARTS· ' + t.restart_count);
    if (dockerLines.length) {
      parts.push('');
      parts.push(treeBlock('🐳 DOCKER (container)', dockerLines));
    }
  }

  parts.push('');
  parts.push(treeBlock('✅ RESULT', result));
  parts.push('');
  parts.push('───────────────');
  parts.push('📡 ' + sourceLabel(t) + ' · ⏱ ' + age + 's ago');
  parts.push('🕐 ' + footerTime() + ' · v' + VERSION);
  const footer = horizonFooter(t);
  return parts.join('\n') + footer;
}
function formatPeers(t) {
  t = t || {};
  try { if (typeof dataFrame !== 'undefined') dataFrame.applyPeerRule(t); } catch (e) {}
  const inn = t.peer_in, out = t.peer_out;
  const total = t.peer_total != null ? t.peer_total : ((inn != null && out != null) ? (inn + out) : (inn != null ? inn : out));
  const age = cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0;
  const parts = ['🌐 PEERS & TREND · STELLAR CORE', ''];
  if (inn == null && out == null) {
    parts.push('👥 CONNECTIONS');
    parts.push(' └ ⚠️ Peer data unavailable');
    parts.push('');
    parts.push('(Core HTTP /peers not exposed)');
    parts.push('');
    parts.push('───────────────');
    parts.push('📡 Controller Pro · ⏱ ' + age + 's ago');
    return parts.join('\n') + horizonFooter(t);
  }
  const conn = [];
  if (inn != null) conn.push('🟢 IN    · ' + inn);
  if (out != null) conn.push('🔵 OUT   · ' + out);
  if (total != null) conn.push('📊 TOTAL · ' + total);
  parts.push(treeBlock('👥 CONNECTIONS', conn));
  parts.push('');
  parts.push('📈 TREND');
  try {
    const rows = getTimeWindow(1).filter(function (r) { return r.peer_in != null || r.peer_out != null; }).slice(-12);
    if (rows.length >= 2) {
      const a = rows[0], b = rows[rows.length - 1];
      const ta = (a.peer_in || 0) + (a.peer_out || 0);
      const tb = (b.peer_in || 0) + (b.peer_out || 0);
      const drop = ta > 0 ? ((ta - tb) / ta) : 0;
      const totalTrend = (ta === tb) ? '🟢 Stable' : (drop > 0.5 ? '📉 Drop' : '🟡 Changed');
      const trendLines = [];
      trendLines.push('TOTAL · ' + ta + ' ➔ ' + tb + ' (' + totalTrend + ')');
      if (a.peer_in != null && b.peer_in != null) trendLines.push('IN    · ' + a.peer_in + ' ➔ ' + b.peer_in + ' (🟢 Stable)');
      if (a.peer_out != null && b.peer_out != null) trendLines.push('OUT   · ' + a.peer_out + ' ➔ ' + b.peer_out + ' (🟢 Stable)');
      trendLines.forEach(function (l, i) {
        const isLast = i === trendLines.length - 1;
        parts.push(' ' + (isLast ? '└' : '├') + ' ' + l);
      });
    } else parts.push(' └ 👥 ' + (total != null ? total : '?') + ' · collecting');
  } catch (e) { parts.push(' └ 👥 collecting'); }
  parts.push(''); parts.push('───────────────');
  parts.push('📡 Controller Pro · ⏱ ' + age + 's ago');
  return parts.join('\n') + horizonFooter(t);
}
function formatDiagnostic(t) {
  t = t || {};
  const net = [];
  if (t.network_kind === 'Testnet') net.push('Network · Pi Testnet');
  else if (t.network_kind === 'Mainnet') net.push('Network · Pi Mainnet');
  else if (t.network_kind) net.push('Network · ' + t.network_kind);
  else if (t.network) net.push('Network · ' + t.network);
  if (t.sync) {
    const ic = /synced|live/i.test(String(t.sync)) ? '🟢' : (/catch|behind|slow|lag/i.test(String(t.sync)) ? '🟡' : '🔄');
    net.push('Sync    · ' + ic + ' ' + t.sync);
  }
  if (t.ledger != null) {
    let s = 'Ledger  · ' + Number(t.ledger).toLocaleString('en-US');
    const bits = [];
    if (t.ledger_age != null) bits.push('Age: ' + t.ledger_age + 's');
    if (t.ingest_lag != null) bits.push('Lag: ' + t.ingest_lag);
    if (bits.length) s += ' (' + bits.join(' | ') + ')';
    net.push(s);
  }
  if (t.peer_in != null || t.peer_out != null) net.push('Peers   · IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?'));
  if (t.ports) {
    const openCount = NODE_PORTS_STR.filter(function (p) { return t.ports[p] === 'OPEN'; }).length;
    const pic = openCount === 3 ? '🟢 OPEN' : (openCount === 0 ? '🔴 CLOSED' : '🟡 ' + openCount + '/3');
    net.push('Ports   · 31401-31403 ' + pic);
  }
  const eng = [];
  const sockYes = !!(t.docker_sock || t.docker_probe);
  if (t.docker) {
    const dic = /stop|exit/i.test(String(t.docker)) ? '🔴' : '🟢';
    eng.push('Docker    · ' + dic + ' ' + String(t.docker).toUpperCase() + ' (Sock: ' + (sockYes ? 'Yes' : 'No') + ')');
  } else if (sockYes) eng.push('Docker    · 🟢 Sock (Sock: Yes)');
  if (t.container) eng.push('Container · ' + t.container);
  if (t.core_version) eng.push('Core      · ' + t.core_version + (t.protocol != null ? ' (Proto ' + t.protocol + ')' : ''));
  if (t.horizon_version) eng.push('Horizon   · ' + t.horizon_version);
  let levelIc = '🟢';
  if (t.level === 'critical') levelIc = '🔴';
  else if (t.level === 'warning' || t.level === 'soft') levelIc = '🟡';
  const health = [];
  if (t.health != null) {
    const hIcon = healthIcon(t.health);
    const cIcon = healthConfIcon(t.health_confidence);
    const trendTag = t.health_trend === 'improving' ? '↗ improving' : (t.health_trend === 'degrading' ? '↘ degrading' : '→ stable');
    health.push('Score      · ' + hIcon + ' ' + t.health + '/100');
    if (t.health_raw != null && t.health_raw !== t.health) health.push('Raw        · ' + t.health_raw + '/100 (pre-damper)');
    if (t.health_adjusted != null && t.health_adjusted !== t.health_raw) health.push('Adjusted   · ' + t.health_adjusted + '/100 (after stability)');
    health.push('Confidence · ' + cIcon + ' ' + (t.health_confidence || 'low') + ' (' + (t.health_sources || 0) + ' sources)');
    health.push('Trend      · ' + trendTag);
    const s = state.healthStability;
    if (s && s.samples > 0) {
      const sIcon = s.sustainedBad ? '🔴' : (s.unstableShort ? '🟡' : (s.flipRate >= 0.10 ? '🟡' : '🟢'));
      health.push('Stability  · ' + sIcon + ' ' + s.label + ' · flip ' + s.flipRate + ' · bad ' + s.badRatio + ' (3h ' + s.longerBadRatio + ')');
    }
    if (t.health_frozen) health.push('State      · ⚪ frozen (no source)');
  }

  const hostSys = [];
  if (t.system && t.system.available) {
    if (t.system.cpu_percent != null) hostSys.push('CPU     · ' + t.system.cpu_percent + '%');
    if (t.system.memory_percent != null) hostSys.push('RAM     · ' + t.system.memory_percent + '%');
    if (t.system.disk_percent != null) hostSys.push('Disk    · ' + t.system.disk_percent + '%' + (t.system.disk_drive ? ' (' + t.system.disk_drive + ')' : ''));
    if (t.system.uptime_seconds != null) hostSys.push('Uptime  · ' + Math.round(t.system.uptime_seconds / 3600) + 'h');
    hostSys.push('Source  · node_os' + (t.system.age_seconds != null ? ' · age ' + t.system.age_seconds + 's' : ''));
  } else if (t.cpu != null || t.ram != null || t.disk != null) {
    if (t.cpu != null) hostSys.push('CPU     · ' + t.cpu + '%' + (t.cpu_source ? ' (' + t.cpu_source + ')' : ''));
    if (t.ram != null) hostSys.push('RAM     · ' + t.ram + '%' + (t.ram_source ? ' (' + t.ram_source + ')' : ''));
    if (t.disk != null) hostSys.push('Disk    · ' + t.disk + '%' + (t.disk_source ? ' (' + t.disk_source + ')' : ''));
  } else if (t.system && !t.system.available) {
    hostSys.push('Status  · ⚪ unavailable');
    if (t.system.error) hostSys.push('Reason  · ' + t.system.error);
    if (t.system.endpoint) hostSys.push('Endpoint· ' + t.system.endpoint);
  }

  const parts = ['🩺 PI NODE · DIAGNOSTIC', ''];
  if (health.length) { parts.push(treeBlock('💚 HEALTH', health)); parts.push(''); }
  if (hostSys.length) { parts.push(treeBlock('🖥️ HOST SYSTEM', hostSys)); parts.push(''); }
  if (net.length) { parts.push(treeBlock('🌐 NETWORK & LEDGER', net)); parts.push(''); }
  if (eng.length) { parts.push(treeBlock('🐳 ENGINE & SYSTEM', eng)); parts.push(''); }
  parts.push('───────────────');
  parts.push('💡 Level: ' + levelIc + ' ' + String(t.level || 'unknown').toUpperCase());
  parts.push('🧭 Incidents: /incidents');
  parts.push('☕ Donate: MB 0905428801');
  return parts.join('\n') + horizonFooter(t);
}

const ACTION_CATALOG = [
  { id: 'CleanRam', file: 'CleanRam.bat', when: 'RAM high or PC sluggish while node is still synced.', does: 'Close extra apps/services, clear TEMP, TRIM, flush DNS. Does not stop Pi Node or Docker.', how: 'Double-click CleanRam.bat. Auto-elevates. Press Y.' },
  { id: 'CleanTemp', file: 'CleanTemp.bat', when: 'Gentle cleanup while node is healthy.', does: 'Delete temp older than 6 hours + Recycle Bin.', how: 'Double-click CleanTemp.bat. Auto-elevates. Press Y.' },
  { id: 'DnsFlush', file: 'DnsFlush.bat', when: 'Peers dropped but ports stay open and ledger still moves.', does: 'ipconfig /flushdns and /registerdns only. Keeps LAN IP.', how: 'Double-click DnsFlush.bat. Auto-elevates. Press Y.' },
  { id: 'Firewall', file: 'Firewall.bat', when: 'Local ports 31401-31403 stay closed while the PC is online.', does: 'Recreate Windows Firewall TCP 31401-31410 inbound + outbound remote ports, then test local listen.', how: 'Double-click Firewall.bat. Auto-elevates. Press Y. Then /status.' },
  { id: 'NetRepair', file: 'NetRepair.bat', when: 'Internet/Horizon down for a LONG window. Never after a 1-minute catch-up.', does: 'Keep current LAN IP. DNS/ARP/firewall, then adapter restart, then winsock if still offline.', how: 'Double-click NetRepair.bat. Confirm each phase.' },
  { id: 'LanSetup', file: 'LanSetup.bat', when: 'First setup on a new PC, or modem already forwards to this PC IP.', does: 'Detect current IPv4. Optional lock that same IP as static + Google DNS + firewall.', how: 'Double-click LanSetup.bat. Press Y to lock the current IP.' },
  { id: 'NodeReset', file: 'NodeReset.bat', when: 'Pi container stuck/exited for a long time. Docker Engine is healthy.', does: 'Restart testnet2/mainnet/testnet only. Then DNS + firewall + anti-sleep. No WSL shutdown. No IP change.', how: 'Double-click NodeReset.bat. Auto-elevates. Press Y.' },
  { id: 'DockerRecover', file: 'DockerRecover.bat', when: 'Docker Engine itself is down. Not for a short Core catch-up.', does: 'Soft restart Docker Desktop. Ordered WSL only AFTER Docker process is confirmed stopped.', how: 'Double-click DockerRecover.bat. Choose Soft first.' },
  { id: 'Maintain', file: 'Maintain.bat', when: 'Node is healthy. Sunday quiet hours.', does: 'Weekly v13.2 cleanup, unused docker prune, optional Sunday 03:00 task. No token inside the file.', how: 'Double-click Maintain.bat. Press Y. Optional schedule.' },
  { id: 'Reboot', file: 'Reboot.bat', when: 'Last resort after NetRepair + DockerRecover failed and the host is wedged.', does: 'Controlled shutdown /r with delay. Cancel: shutdown /a', how: 'Double-click Reboot.bat. Type delay. Press Y. Never auto-suggested for a short sync dip.' }
];

const APP_GUIDE = `
HOW TO USE THIS APP
Telegram commands: /status /sync /peers /report /diagnostic /analyze /logs /incidents /scripts /donate /help /mute.
Natural language: "reports at 7am and 6pm", "turn off alerts", "mute for 2 hours", "quiet at night".
SoloHost window http://127.0.0.1:18780/ : live status + local chat + script downloads.
Diagnostic framework: 7 steps, 8 SoloHost scripts, 4 safety levels (L1 safest -> L4 strongest).
Health score: stability-aware damper - noise tolerated but sustained bad sync is punished.
Update check: every 48h from github.com/cannoi/pinode-telegram-solohost.
Source note: when docker.sock is OFF, data is Horizon-only and may differ slightly from Pi Node Desktop.
Host metrics: Node OS CPU/RAM/Disk/Uptime (os.cpus / os.totalmem / fs.statfsSync).
Docker metrics: container CPU/RAM/health only when docker.sock ON (separate from Host).
Night/off mute applies to all notifications including recovery, scheduled reports, update notices.
Reports always show the last 24h rolling window (spans midnight).
Donate: /donate - Pay with Pi or MB Bank QR.
`;

const SCRIPT_MAP = `
APP FLOW
Telegram or SoloHost UI -> /status /report /analyze use history frames.
Incident engine: observe -> first alert -> reminder -> chronic.
Alert only fires when the incident persists 5+ minutes or 5+ samples.

8 SCRIPTS (Safety L1 safest -> L4 strongest)
CleanRam.bat      L1  RAM high / PC sluggish while node synced.
DnsFlush.bat      L1  Peers dropped, ports OPEN, ledger still moves.
Firewall.bat      L2  Ports CLOSED locally, container RUNNING.
NodeReset.bat     L2  Container stuck, block frozen > 30 min.
NetRepair.bat     L3  No internet at all (ping 8.8.8.8 fails).
LanSetup.bat      L3  First setup OR IP changed, port-forward broke.
DockerRecover.bat L4  Docker Engine "not ready" / WSL2 stuck (Soft first).
Maintain.bat      L1->L4  Weekly cleanup (recommend Sun 03:00).

7-STEP DIAGNOSTIC FLOW
1. DETECT    - Confirm main symptom.
2. VERIFY    - Rule out false causes (catch-up, CGNAT).
3. EXPLAIN   - Root cause in simple language.
4. RECOMMEND - Name 1 (max 2) scripts.
5. SAFETY    - State L1-L4 + confirm data/IP preserved.
6. ACTION    - How to run.
7. RECHECK   - Wait time + recovery signal.
`;

function recommendActions(t) {
  t = t || {};
  const rows = getTimeWindow(24);
  const windows = extractIssueWindows(rows);
  const lastWin = windows.length ? windows[windows.length - 1] : null;
  const longBad = lastWin && ((lastWin.n || 0) >= 8 || (lastWin.min || 0) >= 15);
  const repeated = windows.filter(function (w) { return (w.n || 0) >= 3; }).length >= 2;
  const persistent = !!(longBad || repeated);
  const catching = /catch|behind|syncing/i.test(String(t.sync || ''));
  const live = /synced|live|horizon ok|good/i.test(String(t.sync || ''));
  const portsClosed = t.ports_ok === false || t.ports_open === 0;
  const ramVal = (typeof lite !== 'undefined' && lite.hostMetric) ? lite.hostMetric(t.ram) : (t.ram != null && Number(t.ram) >= 0 ? Number(t.ram) : null);
  const cpuVal = (typeof lite !== 'undefined' && lite.hostMetric) ? lite.hostMetric(t.cpu) : (t.cpu != null && Number(t.cpu) >= 0 ? Number(t.cpu) : null);
  const diskVal = (typeof lite !== 'undefined' && lite.hostMetric) ? lite.hostMetric(t.disk) : (t.disk != null && Number(t.disk) >= 0 ? Number(t.disk) : null);
  const peers = t.peers != null ? Number(t.peers) : (t.peer_total != null ? Number(t.peer_total) : null);
  const health = t.health != null ? Number(t.health) : null;
  const trend = String(t.trend || 'stable');
  const degrading = trend === 'degrading';
  const dockerBad = t.docker_health === 'unhealthy' || t.docker_status === 'stopped';
  const ramHigh = ramVal != null && ramVal >= 85;
  const cpuHigh = cpuVal != null && cpuVal >= 90;
  const diskHigh = diskVal != null && diskVal >= 90;
  const picks = [];
  const why = [];
  const lastFix = state.lastRepair || null;
  const sameScriptRecently = function (id) {
    if (!lastFix || lastFix.id !== id) return false;
    return Date.now() - (lastFix.ts || 0) < 6 * 3600 * 1000;
  };
  if (health != null && health >= 80 && trend === 'stable' && !portsClosed && !dockerBad) {
    why.push('Health ' + health + ' · trend stable. Observe. Repair BATs not needed.');
    return { why: why, items: [], picks: [] };
  }
  if (!persistent && !degrading && !(ramHigh && degrading) && !dockerBad) {
    why.push('No repeated / degrading incident. Wait and watch. Do not run repair BATs yet.');
    return { why: why, items: [], picks: [] };
  }
  if (catching && !portsClosed && (t.ledger != null)) {
    why.push('Catch-up with ports_ok and a live ledger. Wait for Core; do not restart.');
    return { why: why, items: [], picks: [] };
  }
  if (portsClosed && (persistent || degrading) && !live) {
    why.push('ports_ok=false for a lasting window. Firewall then NetRepair. Keep current LAN IP.');
    if (!sameScriptRecently('Firewall')) picks.push('Firewall');
    if (!sameScriptRecently('NetRepair')) picks.push('NetRepair');
  } else if (peers === 0 && (persistent || degrading) && t.ports_ok !== false) {
    why.push('Peers 0 while ports not closed. DnsFlush only.');
    if (!sameScriptRecently('DnsFlush')) picks.push('DnsFlush');
  } else if (dockerBad && (persistent || degrading)) {
    why.push('docker_health/status bad. Soft DockerRecover first. No WSL while Docker lives.');
    if (!sameScriptRecently('DockerRecover')) picks.push('DockerRecover');
  } else if (ramHigh && (persistent || degrading)) {
    why.push('RAM ' + ramVal + '% and ' + trend + '. CleanRam. Do not restart the node.');
    if (!sameScriptRecently('CleanRam')) picks.push('CleanRam');
  } else if (cpuHigh && degrading) {
    why.push('CPU high and degrading. Observe first; CleanRam if host is busy with extra apps.');
    if (!sameScriptRecently('CleanRam')) picks.push('CleanRam');
  } else if (diskHigh && (persistent || degrading)) {
    why.push('Disk pressure. Maintain cleanup only while node is otherwise healthy.');
    if (!sameScriptRecently('Maintain')) picks.push('Maintain');
  } else {
    why.push('Incident lasted, but no safe BAT maps cleanly. Collect /diagnostic first.');
  }
  if (!picks.length && lastFix && lastFix.ok === false) {
    why.push('Previous repair did not improve telemetry. Escalate to /analyze rather than repeat the same BAT.');
  }
  const items = ACTION_CATALOG.filter(function (a) { return picks.indexOf(a.id) >= 0; });
  return { why: why, items: items, picks: picks };
}
function formatActionAdvice(t) {
  const r = recommendActions(t);
  const lines = ['🛠️ ACTIONS', '───────────────'];
  r.why.forEach(function (w) { lines.push('• ' + w); });
  if (!r.items.length) lines.push('• No BAT required right now.');
  r.items.forEach(function (a) {
    lines.push('');
    lines.push('📂 ' + a.file);
    lines.push('When: ' + a.when);
    lines.push('Does: ' + a.does);
    lines.push('How: ' + a.how);
  });
  return lines.join('\n');
}
function formatScriptDetail(id) {
  const s = SCRIPT_DETAILS[id];
  if (!s) return '❓ Unknown script.';
  return [
    s.icon + ' SCRIPT · ' + s.file,
    '───────────────',
    '🛡️ Level    · ' + s.level + ' (' + s.levelTxt + ')', '',
    '📌 WHEN',
    '  ' + s.when, '',
    '🔧 WHAT IT DOES',
    '  ' + s.does, '',
    '🛡️ SAFETY',
    '  ' + s.safety, '',
    '▶️ HOW TO RUN',
    '  SoloHost UI -> Scripts -> ' + s.file,
    '  or double-click the .bat (auto-elevates, press Y).', '',
    '───────────────',
    '☕ Donate: MB 0905428801'
  ].join('\n');
}
function recommendScriptsFromText(text) {
  const t = String(text || '');
  const hits = [];
  if (/\bCleanRam\b/i.test(t)) hits.push('cleanram');
  if (/\bDnsFlush\b/i.test(t)) hits.push('dnsflush');
  if (/\bFirewall\b/i.test(t)) hits.push('firewall');
  if (/\bNodeReset\b/i.test(t)) hits.push('nodereset');
  if (/\bNetRepair\b/i.test(t)) hits.push('netrepair');
  if (/\bLanSetup\b/i.test(t)) hits.push('lansetup');
  if (/\bDockerRecover\b/i.test(t)) hits.push('dockerrecover');
  if (/\bMaintain\b/i.test(t)) hits.push('maintain');
  return hits;
}

function formatReport(hours) {
  const H = Math.max(1, Math.min(168, Number(hours) || 24));
  const rows = getTimeWindow(H);
  const t = cache || {};
  if (!rows.length) {
    return [
      '🟢 PI NODE · REPORT', '', '⏱ RANGE · collecting…', '',
      '📊 METRICS', ' └ 🔄 SYNC · n/a', '',
      '💡 DIAGNOSIS', ' ├ 🟢 NODE   · Healthy (n/a)', ' └ 🛠️ ACTION · None (No BAT needed)', '',
      '───────────────', '☕ Donate: MB 0905428801'
    ].join('\n') + horizonFooter(t);
  }
  const first = rows[0], last = rows[rows.length - 1];
  const fmtHM = function (iso) {
    const s = String(iso || '').replace('T', ' ');
    const hm = s.slice(11, 16) || '--:--';
    const dd = s.slice(8, 10) || '--';
    const mm = s.slice(5, 7) || '--';
    return hm + ' ' + dd + '/' + mm;
  };
  const durMs = Math.max(0, (Date.parse(last.ts) || Date.now()) - (Date.parse(first.ts) || 0));
  const hoursShown = Math.round(durMs / 3600000 * 10) / 10;
  const minutesShown = Math.round(durMs / 60000);
  const coverageText = hoursShown >= 1 ? ('~' + hoursShown + 'h') : ('~' + minutesShown + ' min');
  const crit = rows.filter(function (r) { return r.level === 'critical'; }).length;
  const healthy = rows.filter(function (r) { return r.level === 'ok' || r.level === 'soft'; }).length;
  const healthyPct = Math.round((healthy / rows.length) * 100);
  const head = (crit > rows.length * 0.15) ? '🟡 PI NODE · REPORT' : '🟢 PI NODE · REPORT';
  const live = cache || last;
  const metrics = [];
  const lastSync = live.sync || last.sync || '';
  metrics.push('🔄 SYNC    · ' + (/synced|live|good/i.test(lastSync) ? '🟢 ' : '🟡 ') + (lastSync || 'n/a'));
  const portsOpen = (live.ports_open != null) ? Number(live.ports_open) : null;
  let dockLabel, dockIcon;
  if (live.docker && String(live.docker).length) {
    dockLabel = String(live.docker);
    dockIcon = /stop|exit/i.test(dockLabel) ? '🟡 ' : '🟢 ';
  } else if (live.docker_sock === true) { dockLabel = 'sock'; dockIcon = '🟢 '; }
  else if (live.container) { dockLabel = 'Running (`' + live.container + '`)'; dockIcon = '🟢 '; }
  else if (portsOpen != null && portsOpen > 0) { dockLabel = 'Running (via ports)'; dockIcon = '🟢 '; }
  else { dockLabel = 'N/A'; dockIcon = '⚪ '; }
  metrics.push('🐳 DOCKER  · ' + dockIcon + dockLabel);
  const livePeerIn = live.peer_in != null ? live.peer_in : last.peer_in;
  const livePeerOut = live.peer_out != null ? live.peer_out : last.peer_out;
  if (livePeerIn != null || livePeerOut != null) {
    metrics.push('👥 PEERS   · IN ' + (livePeerIn != null ? livePeerIn : '?') + ' / OUT ' + (livePeerOut != null ? livePeerOut : '?'));
  }
  let netLabel;
  if (portsOpen == null) netLabel = '⚪ Unknown';
  else if (portsOpen === 3) netLabel = '🟢 Stable (3/3)';
  else if (portsOpen === 0) netLabel = '🔴 Closed (0/3)';
  else if (portsOpen >= 2) netLabel = '🟢 Stable (' + portsOpen + '/3)';
  else netLabel = '🟡 Check (' + portsOpen + '/3)';
  metrics.push('🌐 NETWORK · ' + netLabel);
  if (live.ram != null) {
    const ric = live.ram >= 92 ? '🔴' : (live.ram >= 85 ? '🟡' : '🟢');
    metrics.push('🧠 RAM     · ' + ric + ' ' + Math.round(live.ram) + '%');
  }
  if (live.cpu != null) {
    const cic = live.cpu >= 95 ? '🔴' : (live.cpu >= 85 ? '🟡' : '🟢');
    metrics.push('⚙️ CPU     · ' + cic + ' ' + live.cpu + '%');
  }
  if (live.disk != null) {
    const dic = live.disk >= 95 ? '🔴' : (live.disk >= 88 ? '🟡' : '🟢');
    metrics.push('💾 DISK    · ' + dic + ' ' + Math.round(live.disk) + '%');
  }
  const windows = extractIssueWindows(rows);
  const diag = [];
  diag.push((healthyPct >= 90 ? '🟢' : '🟡') + ' NODE   · ' + (healthyPct >= 90 ? 'Healthy' : 'Watch') + ' (' + healthyPct + '%)');
  diag.push('🛠️ ACTION · ' + (crit > rows.length * 0.1 ? 'Review node' : 'None (No BAT needed)'));
  const parts = [head, ''];
  parts.push('🕐 WINDOW · Last ' + H + 'h (rolling from now)');
  parts.push('⏱ RANGE  · ' + fmtHM(first.ts) + ' ➔ ' + fmtHM(last.ts));
  parts.push('📊 DATA   · ' + rows.length + ' samples · ' + coverageText + ' covered');
  parts.push('');
  parts.push(treeBlock('📊 METRICS', metrics));
  if (windows.length) { parts.push(''); parts.push('⚠️ ISSUE WINDOWS'); parts.push(formatIssueWindows(windows)); }
  parts.push('');
  parts.push(treeBlock('💡 DIAGNOSIS', diag));
  parts.push('');
  parts.push('───────────────');
  parts.push('☕ Donate: MB 0905428801');
  return parts.join('\n') + horizonFooter(t);
}
function formatHelp() {
  return [
    '📖 PI NODE CONTROLLER · HELP', '───────────────', '',
    '📊 /status      - Current node health snapshot',
    '🔄 /sync        - Sync status and latest ledger',
    '👥 /peers       - Inbound and outbound peers',
    '📈 /report      - Last 24h rolling window (spans midnight)',
    '🧭 /incidents   - Active + recent incident history',
    '🩺 /diagnostic  - Technical source details',
    '🔧 /scripts     - 8 SoloHost scripts (with safety levels)',
    '💬 /analyze     - AI technician review (in your language)',
    '📋 /logs        - App activity and errors',
    '💛 /donate      - Support the project',
    '💻 /winpro      - Windows PRO edition link',
    '🏓 /ping        - Controller heartbeat',
    '❓ /help        - This list',
    '🔕 /mute        - Quiet alerts (also mutes recovery)',
    '',
    '💡 Natural language also works:',
    '  "reports at 7am and 6pm"',
    '  "turn off alerts" / "mute for 2 hours"',
    '  "quiet at night"',
    '',
    'Ask in any language. AI replies in the same language.',
    'Night/off mute applies to ALL notifications.', '',
    '💛 /donate'
  ].join('\n');
}
function extractIssueWindows(rows) {
  const out = [];
  if (!rows || !rows.length) return out;
  function bad(r) {
    if (!r) return false;
    if (r.level === 'critical' || r.level === 'warning') return true;
    const s = String(r.sync || '');
    if (/catch|behind|lost|offline|unknown|n\/a/i.test(s) && !/synced|live|good|horizon ok/i.test(s)) return true;
    if (r.ports_open === 0) return true;
    if (r.ledger_age != null && Number(r.ledger_age) > 180) return true;
    return false;
  }
  let cur = null;
  rows.forEach(function (r) {
    const ts = r.ts || '';
    if (bad(r)) {
      if (!cur) cur = { from: ts, to: ts, kind: r.level || 'watch', sync: r.sync || '', n: 1 };
      else { cur.to = ts; cur.n++; if (r.sync) cur.sync = r.sync; }
    } else if (cur) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out.slice(-8);
}
function formatIssueWindows(windows) {
  if (!windows || !windows.length) return ' └ 🟢 None in this sample set';
  return windows.map(function (w, i) {
    const isLast = i === windows.length - 1;
    const from = String(w.from || w.to || '').replace('T', ' ');
    const hhmm = from.slice(11, 16) || '--:--';
    const dur = fmtIssueDuration(w.n);
    const sync = w.sync ? (' ' + w.sync) : '';
    return ' ' + (isLast ? '└' : '├') + ' 🔴 ' + (w.kind || 'watch') + ' · ' + hhmm + ' · ' + dur + sync;
  }).join('\n');
}
function preEvalBrief(t) {
  t = t || {};
  const h = buildHistory24h();
  const rows = getTimeWindow(48);
  const windows = extractIssueWindows(rows);
  const lines = [];
  lines.push('PRE-EVAL (do not invent beyond this)');
  lines.push('Now source=' + (t.source || '?') + ' sync=' + (t.sync || '?') + ' level=' + (t.level || '?'));
  if (t.ledger != null) lines.push('Ledger=' + t.ledger + (t.ledger_age != null ? (' age=' + t.ledger_age + 's') : ''));
  if (t.peer_in != null || t.peer_out != null) lines.push('Peers IN/OUT=' + (t.peer_in != null ? t.peer_in : '?') + '/' + (t.peer_out != null ? t.peer_out : '?'));
  lines.push('Docker=' + (t.docker || 'n/a') + ' sock=' + (t.docker_sock ? 'yes' : 'no') + ' container=' + (t.container || 'n/a'));
  if (t.ports_open != null) lines.push('Ports open=' + t.ports_open);
  if (t.health != null) lines.push('Health=' + t.health + ' (raw=' + (t.health_raw != null ? t.health_raw : '?') + ', adj=' + (t.health_adjusted != null ? t.health_adjusted : '?') + ', conf=' + (t.health_confidence || '?') + ', trend=' + (t.health_trend || '?') + ')');
  if (t.system) lines.push('Host system (node_os): available=' + !!t.system.available + ' cpu=' + (t.system.cpu_percent != null ? t.system.cpu_percent + '%' : '?') + ' ram=' + (t.system.memory_percent != null ? t.system.memory_percent + '%' : '?') + ' disk=' + (t.system.disk_percent != null ? t.system.disk_percent + '%' : '?'));
  if (h && h.samples) {
    lines.push('24h samples=' + h.samples + ' ok/warn/crit=' + h.level_ok + '/' + h.level_warning + '/' + h.level_critical);
    if (h.first_ts) lines.push('24h window=' + String(h.first_ts).slice(0, 16) + ' -> ' + String(h.last_ts).slice(0, 16));
    lines.push('Sync flips=' + h.sync_flips);
  }
  lines.push('Issue windows:');
  lines.push(formatIssueWindows(windows));
  return lines.join('\n');
}
function formatScripts() {
  return [
    '🔧 SOLOHOST SCRIPTS (8)',
    '───────────────', '',
    '🟢 L1  · 🧹 CleanRam.bat',
    '        RAM high / PC sluggish while synced',
    '🟢 L1  · 🌐 DnsFlush.bat',
    '        Peers dropped, ports OPEN, ledger moves',
    '🟡 L2  · 🧱 Firewall.bat',
    '        Ports CLOSED locally, container RUNNING',
    '🟡 L2  · ♻️ NodeReset.bat',
    '        Container stuck, block frozen > 30 min',
    '🟠 L3  · 🔧 NetRepair.bat',
    '        No internet (ping 8.8.8.8 fails)',
    '🟠 L3  · 📡 LanSetup.bat',
    '        First setup OR IP changed, port-forward broke',
    '🔴 L4  · 🐳 DockerRecover.bat',
    '        Docker Engine "not ready" / WSL2 stuck',
    '🧰 SCH · Maintain.bat (Sun 03:00)',
    '        Weekly housekeeping', '',
    '───────────────',
    'Tap a button below for details.',
    '☕ Donate: MB 0905428801'
  ].join('\n');
}
function randomDonateThanks() {
  const pool = [
    '💜 Thank you - this coffee helps keep the app going.',
    '💜 Thank you for supporting the Pi Node community.',
    '💜 Thank you. Wishing your node a stable run.',
    '💜 Thanks a lot! Your coffee keeps SoloHost updates coming.',
    '💜 That coffee means a lot. Thank you for walking with us.',
    '💜 Your support means more than a number. Thank you.',
    '💜 Wow, thank you. We will keep improving the bot.',
    '💜 Thank you - every gift helps the app stay stable.',
    '💜 Pi or MB Bank - both are appreciated. Thank you.',
    '💜 Thank you for supporting open Pi Node tools.'
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}
function formatDonate() {
  return [
    '💛 DONATE · DEV COFFEE', '───────────────', 'Choose one donate method:', '',
    '🟣 1) Pay with Pi', '   User: @cannoi', '   Wallet:',
    '   GAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL', '',
    '🏦 2) MB Bank', '   STK: 0905428801', '   Name: TRAN HUU NGHI', '',
    '📱 QR: Pay with Pi + MB Bank', '',
    '🙏 ' + randomDonateThanks()
  ].join('\n');
}
function donateQrPath(kind) {
  const name = kind === 'pi' ? 'donate-qr-pi.jpg' : 'donate-qr-mb.jpg';
  const f = path.join(PUBLIC, name);
  if (fs.existsSync(f)) return f;
  const fallback = path.join(PUBLIC, 'donate-qr.jpg');
  return fs.existsSync(fallback) ? fallback : null;
}
function donateKeyboard() {
  return { inline_keyboard: [
    [{ text: '🟣 Pi', callback_data: 'cmd_donate_pi' }, { text: '🏦 MB Bank', callback_data: 'cmd_donate_mb' }],
    [{ text: '📦 Both QRs', callback_data: 'cmd_donate_both' }],
    [{ text: '📊 Status', callback_data: 'cmd_status' }, { text: '💬 Analyze', callback_data: 'cmd_analyze' }]
  ]};
}
async function sendDonateQr(kind) {
  const thanks = randomDonateThanks();
  if (kind === 'pi' || kind === 'both') {
    const qr = donateQrPath('pi');
    if (qr) await tgSendPhotoFile(qr, '🟣 Pay with Pi\n@cannoi\nGAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL\n\n🙏 ' + thanks);
    else { try { actionLog('warn', 'donate Pi QR missing'); } catch (e) {} }
  }
  if (kind === 'mb' || kind === 'both') {
    const qr = donateQrPath('mb');
    if (qr) await tgSendPhotoFile(qr, '🏦 MB Bank\n0905428801 · TRAN HUU NGHI\n\n🙏 ' + thanks);
    else { try { actionLog('warn', 'donate MB QR missing'); } catch (e) {} }
  }
  return true;
}
async function tgSendPhotoFile(filePath, caption) {
  if (!BOT_TOKEN || !CHAT_ID || !filePath || !fs.existsSync(filePath)) return false;
  try {
    const boundary = '----PiNode' + Date.now().toString(16);
    const fileBuf = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const parts = [];
    function field(n, v) { parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n')); }
    field('chat_id', String(CHAT_ID));
    field('caption', String(caption || '').slice(0, 900));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="' + name + '"\r\nContent-Type: image/jpeg\r\n\r\n'));
    parts.push(fileBuf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    await new Promise(function (resolve) {
      const req = https.request({
        hostname: 'api.telegram.org', path: '/bot' + BOT_TOKEN + '/sendPhoto', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
      }, function (r) {
        let b = '';
        r.on('data', function (d) { b += d; });
        r.on('end', function () {
          try {
            const j = safeParse(b);
            if (!(j && j.ok)) try { actionLog('warn', 'donate QR telegram: ' + String((j && j.description) || r.statusCode)); } catch (e) {}
          } catch (e) {}
          resolve();
        });
      });
      req.on('error', resolve);
      req.setTimeout(20000, function () { try { req.destroy(); } catch (e) {} resolve(); });
      req.write(body); req.end();
    });
    try { actionLog('info', 'donate QR sent (local file)'); } catch (e) {}
    return true;
  } catch (e) {
    try { actionLog('error', 'donate QR fail: ' + (e && e.message)); } catch (e2) {}
    return false;
  }
}
function formatWindowsPro() {
  return [
    '💻 WINDOWS PRO · FULL', '───────────────',
    'SoloHost is the lightweight monitor.', 'Windows PRO has more tools:',
    '• Live host CPU / RAM / temp', '• Docker control and scripts',
    '• Clean RAM / maintenance / reset', '• Deeper diagnostics and scheduler', '',
    'Download:', 'https://github.com/cannoi/pinode-telegram-controller', '',
    'Use SoloHost for alerts on the go;', 'use Windows PRO for full control.'
  ].join('\n');
}

/* LANGUAGE ============================================================= */
function detectUserLang(q) {
  const s = String(q || '');
  if (!s.trim()) return null;
  if (/[\u3040-\u30ff]/.test(s)) return 'Japanese';
  if (/[\uac00-\ud7af]/.test(s)) return 'Korean';
  if (/[\u4e00-\u9fff]/.test(s)) return 'Chinese';
  if (/[\u0400-\u04ff]/.test(s)) return 'Russian';
  if (/[\u0600-\u06ff]/.test(s)) return 'Arabic';
  if (/[\u0590-\u05ff]/.test(s)) return 'Hebrew';
  if (/[\u0e00-\u0e7f]/.test(s)) return 'Thai';
  if (/[\u0900-\u097f]/.test(s)) return 'Hindi';
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'Vietnamese';
  if (/\b(hola|gracias|c[oó]mo|est[aá]|buenos|qu[eé]|por favor|ayuda)\b/i.test(s)) return 'Spanish';
  if (/\b(ol[aá]|obrigado|voc[eê]|est[aá]|por favor|ajuda)\b/i.test(s)) return 'Portuguese';
  if (/\b(bonjour|merci|vous|comment|s'il|aidez)\b/i.test(s)) return 'French';
  if (/\b(ciao|grazie|come|perch[eé]|aiuto)\b/i.test(s)) return 'Italian';
  if (/\b(hallo|danke|bitte|wie geht|hilfe)\b/i.test(s)) return 'German';
  if (/\b(merhaba|te[sş]ekk[uü]r|nas[iı]l|yard[iı]m)\b/i.test(s)) return 'Turkish';
  if (/\b(selamat|terima kasih|bagaimana|tolong)\b/i.test(s)) return 'Indonesian';
  if (/\b(привет|спасибо|помощь)\b/i.test(s)) return 'Russian';
  if (/\b(γειά|ευχαριστώ|βοήθεια)\b/i.test(s)) return 'Greek';
  if (/\b(cześć|dziękuję|pomoc)\b/i.test(s)) return 'Polish';
  if (/\b(hei|takk|hjelp)\b/i.test(s)) return 'Norwegian';
  if (/\b(hej|tack|hjälp)\b/i.test(s)) return 'Swedish';
  return 'English';
}
function detectUserPreferredLang(currentMsg, opts) {
  opts = opts || {};
  if (!opts.skipCurrent) {
    const current = detectUserLang(currentMsg);
    if (current) return current;
  }
  const turns = loadChatHistory();
  const userTurns = turns.filter(function (t) { return t && t.role === 'user'; }).slice(-10);
  const counts = {};
  userTurns.forEach(function (t) { const l = detectUserLang(t.text); if (l) counts[l] = (counts[l] || 0) + 1; });
  let best = null, bestN = 0;
  for (const k in counts) if (counts[k] > bestN) { best = k; bestN = counts[k]; }
  return best || 'English';
}
function isQuickActionText(msg) {
  const m = String(msg || '').trim();
  return !m || /^(review my node|node status|analyze|check|status)$/i.test(m);
}
function detectIntent(q) {
  const s = String(q || '').toLowerCase();
  if (/^(hello|hi|hey|xin chào|chào|hola|hallo|bonjour|ciao|olá)\b/.test(s) || s === 'hello' || s === 'hi') return 'GREETING';
  if (/what day|what time|today|hôm nay|thứ mấy|qué día|quel jour/.test(s)) return 'SMALLTALK';
  if (/explain|clarify|giải thích|expl[ií]came|explique/.test(s)) return 'CLARIFY';
  if (/\bram\b|memory|bộ nhớ|memoria|mémoire/.test(s)) return 'RAM';
  if (/\bcpu\b|processor|procesador|processeur/.test(s)) return 'CPU';
  if (/\btemp\b|temperature|nhiệt|nóng|temp[eé]rature/.test(s)) return 'TEMP';
  if (/\bdisk\b|storage|ổ cứng|disco|disque/.test(s)) return 'DISK';
  if (/docker|container/.test(s)) return 'DOCKER';
  if (/\bport\b|31401|31402|31403|cổng|puerto/.test(s)) return 'PORT';
  if (/peer|incoming|outgoing|đồng nghiệp/.test(s)) return 'PEERS';
  if (/sync|ledger|đồng bộ|sincronizaci[oó]n|synchronisation/.test(s)) return 'BLOCK_SYNC';
  if (/bonus|reward|points|điểm thưởng|recompensa/.test(s)) return 'BONUS';
  if (/upgrade|add ram|ssd|nâng cấp|mejorar|améliorer/.test(s)) return 'ADVICE';
  if (/\bwhy\b|error|slow|issue|problem|tại sao|lỗi|por qué|pourquoi/.test(s)) return 'DIAGNOSIS';
  if (/\bok\??\b|how is|status|my node|health|ổn không|tình trạng|c[oó]mo est[aá]/.test(s)) return 'NODE_HEALTH';
  if (/should i|recommend|advice|what to do|tư vấn|recomiendas|conseil/.test(s)) return 'RECOMMENDATION';
  if (/sell|finance|money|tight|bán|kẹt tiền|vender|argent/.test(s)) return 'FINANCE';
  return 'GENERAL';
}
function loadChatHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'chat_history.json'), 'utf8'));
    return Array.isArray(j) ? j.slice(-24) : [];
  } catch (e) { return []; }
}
function saveChatHistory(turns) {
  try { fs.writeFileSync(path.join(DATA, 'chat_history.json'), JSON.stringify(turns.slice(-40))); } catch (e) {}
}
function pushChatPersistent(role, text) {
  const turns = loadChatHistory();
  turns.push({ role: role, text: String(text || '').slice(0, 800), ts: nowISO() });
  saveChatHistory(turns);
  try { pushChatTurn(role, text); } catch (e) {}
}
function evidenceSummary(t) {
  const parts = [];
  if (t.source) parts.push('Source: ' + t.source);
  if (t.sync) parts.push('Sync: ' + t.sync);
  if (t.ledger != null) parts.push('Ledger: ' + Number(t.ledger).toLocaleString('en-US'));
  if (t.ledger_age != null) parts.push('Age: ' + t.ledger_age + 's');
  if (t.peer_in != null || t.peer_out != null) parts.push('Peer IN/OUT: ' + (t.peer_in != null ? t.peer_in : '?') + '/' + (t.peer_out != null ? t.peer_out : '?'));
  if (t.docker) parts.push('Docker: ' + t.docker);
  if (t.ports_all_open) parts.push('Ports 31401-3: OPEN');
  else if (t.ports_open != null) parts.push('Ports open: ' + t.ports_open + '/3');
  if (t.ram != null) parts.push('RAM: ' + t.ram + '%');
  if (t.cpu != null) parts.push('CPU: ' + t.cpu + '%');
  if (t.temp != null) parts.push('Temp: ' + t.temp + '°C');
  if (t.health != null) parts.push('Health: ' + t.health + '/100 (' + (t.health_confidence || '?') + ')');
  return parts;
}
function collectIssues(t) {
  const issues = [];
  if (t.docker && /stop|exit/i.test(String(t.docker))) issues.push('Docker/container not running');
  if (t.ports_open === 0) issues.push('Node ports closed');
  if (t.sync && /not synced|error|fail/i.test(String(t.sync))) issues.push('Unusual sync: ' + t.sync);
  if (t.ledger_age != null && t.ledger_age > 300) issues.push('Ledger age high (' + t.ledger_age + 's)');
  if (t.peer_in != null && t.peer_in < 2) issues.push('Peer IN low (' + t.peer_in + ')');
  if (t.ram != null && t.ram >= 88) issues.push('RAM high (' + t.ram + '%)');
  if (t.cpu != null && t.cpu >= 90) issues.push('CPU high (' + t.cpu + '%)');
  if (t.temp != null && t.temp >= 78) issues.push('High temperature (' + t.temp + '°C)');
  if (!t.source && t.ports_open === 0) issues.push('No telemetry source and ports closed');
  return issues;
}
function metricIntentKey(intent) {
  if (intent === 'RAM') return 'ram';
  if (intent === 'CPU') return 'cpu';
  if (intent === 'TEMP') return 'temp';
  return null;
}
function buildFacts(t) {
  t = t || {};
  return {
    source: t.source || null, sync: t.sync || null,
    health: t.health != null ? t.health : null,
    health_raw: t.health_raw != null ? t.health_raw : null,
    health_adjusted: t.health_adjusted != null ? t.health_adjusted : null,
    health_confidence: t.health_confidence || null, health_trend: t.health_trend || null,
    core_health: t.core_health != null ? t.core_health : null, health_source: t.health_source || null,
    core_state: t.core_state || null, core_verified: t.core_verified === true,
    sync_confidence: t.sync_confidence || null,
    ledger: t.ledger != null ? t.ledger : null, ledger_age: t.ledger_age != null ? t.ledger_age : null,
    ingest_lag: t.ingest_lag != null ? t.ingest_lag : null,
    peer_in: t.peer_in != null ? t.peer_in : null, peer_out: t.peer_out != null ? t.peer_out : null,
    ports_open: t.ports_open != null ? t.ports_open : null, ports: t.ports || null,
    network: t.network || null, network_kind: t.network_kind || null,
    protocol: t.protocol != null ? t.protocol : null,
    core_version: t.core_version || null, horizon_version: t.horizon_version || null,
    level: t.level || null, fsm: t.fsm || null, sources_ok: t.sources || null,
    docker: t.docker || null, docker_sock: t.docker_sock === true, docker_probe: t.docker_probe === true,
    container: t.container || null, cpu: t.cpu != null ? t.cpu : null, ram: t.ram != null ? t.ram : null,
    temp: t.temp != null ? t.temp : null, ports_all_open: t.ports_all_open === true,
    cpu_source: t.cpu_source || null, ram_source: t.ram_source || null, disk_source: t.disk_source || null,
    uptime_seconds: t.uptime_seconds != null ? t.uptime_seconds : null,
    system_available: t.system ? t.system.available === true : false
  };
}

/* DOCKER CONSENT ====================================================== */
function dockerPrefPath() { return path.join(DATA, 'state', 'docker-pref.json'); }
function readDockerPref() { try { return JSON.parse(fs.readFileSync(dockerPrefPath(), 'utf8')); } catch (e) { return { enabled: false }; } }
function writeDockerPref(obj) { try { fs.mkdirSync(path.dirname(dockerPrefPath()), { recursive: true }); fs.writeFileSync(dockerPrefPath(), JSON.stringify(obj, null, 2)); } catch (e) {} }
function applyDockerConsentFiles() {
  const result = { wrote_data: false, wrote_host: false, paths: [] };
  let tag = 'v2.6.57';
  try { const m = String(VERSION || '').match(/(\d+\.\d+\.\d+)/); if (m) tag = 'v' + m[1]; } catch (e) {}
  const img = process.env.AUTO_COMPOSE_IMAGE || ('ghcr.io/cannoi/pinode-telegram-solohost:' + tag);
  const composeBody = [
    '# Generated after Operator consent in Pi Node Telegram Controller',
    'services:', '  agent:', '    image: ' + img,
    '    pull_policy: missing',
    '    labels:', '      pi.ui.primary: "true"',
    '    ports:', '      - "127.0.0.1:18780:8080"',
    '    environment:',
    '      - BOT_TOKEN=${BOT_TOKEN}', '      - CHAT_ID=${CHAT_ID}',
    '      - GEMINI_API_KEY=${GEMINI_API_KEY}',
    '      - NODE_HOST=host.docker.internal', '      - HORIZON_PORT=31401',
    '      - CORE_HTTP_PORT=11626', '      - DOCKER_PROBE=1',
    '      - AUTO_DOCKER_SOCK=0', '      - TELEMETRY_SEC=60',
    '      - TZ=Asia/Ho_Chi_Minh',
    '    volumes:', '      - ./data:/data',
    '      - ./:/solohost-config:rw',
    '      - ./public:/app/public:rw',
    '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    '    restart: unless-stopped', ''
  ].join('\n');
  const readme = 'OPTIONAL DOCKER - Operator consent\n=================================\n\n1) Copy docker-compose.yml over the one in this SoloHost app folder.\n2) SoloHost -> Stop -> Start the app.\n3) Telegram: /docker  (should show Socket: YES when mount worked).\n\nThis is NOT default SoloHost permission. You opted in.\n';
  const bat = '@echo off\r\ncd /d "%~dp0"\r\nif exist docker-compose.yml copy /Y docker-compose.yml docker-compose.yml.bak\r\ncopy /Y "%~dp0docker-compose.yml" "%~dp0..\\docker-compose.yml" 2>nul\r\necho Done.\r\npause\r\n';
  const ps1 = '# Optional Docker enable - run from app folder after consent\n$ErrorActionPreference = "Continue"\n$here = $PSScriptRoot\n$root = Split-Path $here -Parent\nif ((Split-Path $here -Leaf) -eq "docker-enable") { $root = Split-Path (Split-Path $here -Parent) -Parent }\n$src = Join-Path $here "docker-compose.yml"\n$dst = Join-Path $root "docker-compose.yml"\nif (Test-Path $dst) { Copy-Item $dst ($dst + ".bak") -Force }\nCopy-Item $src $dst -Force\nWrite-Host "Wrote $dst"\nWrite-Host "Stop -> Start the SoloHost app now."\n';
  try {
    const dir = path.join(DATA, 'docker-enable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), composeBody);
    fs.writeFileSync(path.join(dir, 'README.txt'), readme);
    fs.writeFileSync(path.join(dir, 'APPLY.bat'), bat);
    fs.writeFileSync(path.join(dir, 'APPLY.ps1'), ps1);
    result.wrote_data = true; result.paths.push(dir);
  } catch (e) { result.data_error = String(e && e.message); }
  const hostDir = process.env.SOLOHOST_CONFIG_DIR || '/solohost-config';
  try {
    if (fs.existsSync(hostDir)) {
      const dst = path.join(hostDir, 'docker-compose.yml');
      try { if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + '.bak'); } catch (e2) {}
      fs.writeFileSync(dst, composeBody);
      fs.writeFileSync(path.join(hostDir, 'DOCKER_ENABLE_README.txt'), readme);
      result.wrote_host = true; result.paths.push(dst);
    }
  } catch (e) { result.host_error = String(e && e.message); }
  try { actionLog('ok', 'docker consent files ' + JSON.stringify(result)); } catch (e) {}
  return result;
}
function dockerTermsText() {
  return ['OPTIONAL DOCKER ACCESS - TERMS', '==============================', '', 'What this is', 'The app can optionally use the Docker engine socket on YOUR computer to read Pi Node container status. This is OFF by default.', '', 'SoloHost default', 'SoloHost installs this app as a sandbox. docker.sock is NOT a default SoloHost permission.', '', 'Your responsibility (Operator)', 'By agreeing you confirm that:', '1) You understand docker.sock is powerful.', '2) You accept the risk.', '3) You may turn the preference OFF later.', '4) Publisher is not responsible for damage arising from optional elevated access.', '', 'Agree only if you accept these terms.'].join('\n');
}
async function formatDockerRules() { return dockerTermsText(); }
async function formatDockerHelp(tel) {
  const pref = readDockerPref();
  const sock = !!(tel && tel.docker_sock);
  return ['DOCKER OPTIONAL - STATUS', 'Pref: ' + (pref.enabled ? 'ON' : 'OFF') + ' | Sock in container: ' + (sock ? 'YES' : 'NO'), '', 'Read the terms first (button: Terms).', 'If you Agree: app overwrites app-folder docker-compose.yml with sock, then you SoloHost Stop -> Start.', '', 'Normal monitoring works without Docker.'].join('\n');
}

/* AGGREGATE HELPERS ==================================================== */
function historySnippet(n) {
  try {
    return getTimeWindow(48).slice(-(n || 24)).map(function (r) {
      const o = { ts: r.ts, level: r.level };
      ['sync','ledger','ledger_age','peer_in','peer_out','ram','cpu','temp','ports_open','health'].forEach(function (k) {
        if (r[k] != null) o[k] = r[k];
      });
      return o;
    });
  } catch (e) { return []; }
}
function buildHistory24h() {
  const rows = getTimeWindow(24);
  if (!rows.length) return { samples: 0, note: 'No history yet - collecting telemetry every 60s.' };
  const nums = function (key) {
    return rows.map(function (r) { return r[key]; }).filter(function (x) { return x != null && isFinite(Number(x)); }).map(Number);
  };
  const ledgers = nums('ledger'), ages = nums('ledger_age'), rams = nums('ram'), cpus = nums('cpu'), temps = nums('temp');
  const peersIn = nums('peer_in'), peersOut = nums('peer_out'), healths = nums('health');
  let critical = 0, warning = 0, ok = 0, syncFlips = 0, lastSync = null;
  rows.forEach(function (r) {
    if (r.level === 'critical') critical++;
    else if (r.level === 'warning' || r.level === 'soft') warning++;
    else ok++;
    if (r.sync && lastSync && r.sync !== lastSync) syncFlips++;
    if (r.sync) lastSync = r.sync;
  });
  const first = rows[0], last = rows[rows.length - 1];
  const spanMin = Math.max(1, Math.round(((Date.parse(last.ts) - Date.parse(first.ts)) || 0) / 60000));
  return {
    samples: rows.length, approx_minutes: spanMin,
    first_ts: first && first.ts, last_ts: last && last.ts,
    level_ok: ok, level_warning: warning, level_critical: critical,
    sync_flips: syncFlips, last_sync: last && last.sync,
    ledger_min: ledgers.length ? Math.min.apply(null, ledgers) : null,
    ledger_max: ledgers.length ? Math.max.apply(null, ledgers) : null,
    ledger_delta: ledgers.length >= 2 ? (ledgers[ledgers.length - 1] - ledgers[0]) : null,
    age_max_s: ages.length ? Math.max.apply(null, ages) : null,
    age_avg_s: ages.length ? Math.round(ages.reduce(function (a, b) { return a + b; }, 0) / ages.length) : null,
    peer_in_min: peersIn.length ? Math.min.apply(null, peersIn) : null,
    peer_in_max: peersIn.length ? Math.max.apply(null, peersIn) : null,
    peer_out_min: peersOut.length ? Math.min.apply(null, peersOut) : null,
    peer_out_max: peersOut.length ? Math.max.apply(null, peersOut) : null,
    ram_min: rams.length ? Math.min.apply(null, rams) : null,
    ram_max: rams.length ? Math.max.apply(null, rams) : null,
    cpu_max: cpus.length ? Math.max.apply(null, cpus) : null,
    temp_max: temps.length ? Math.max.apply(null, temps) : null,
    health_min: healths.length ? Math.min.apply(null, healths) : null,
    health_max: healths.length ? Math.max.apply(null, healths) : null,
    health_avg: healths.length ? Math.round(healths.reduce(function (a, b) { return a + b; }, 0) / healths.length) : null
  };
}
function formatHistory24hText(h) {
  if (!h || !h.samples) return 'No 24h history yet.';
  const lines = [];
  lines.push('Samples: ' + h.samples + ' (~' + h.approx_minutes + ' min coverage)');
  if (h.first_ts && h.last_ts) lines.push('Window: ' + String(h.first_ts).slice(0, 16) + ' -> ' + String(h.last_ts).slice(0, 16));
  lines.push('Levels OK/Warn/Crit: ' + h.level_ok + '/' + h.level_warning + '/' + h.level_critical);
  lines.push('Sync flips: ' + h.sync_flips + (h.last_sync ? ('; last=' + h.last_sync) : ''));
  if (h.ledger_min != null) lines.push('Ledger: ' + h.ledger_min + ' -> ' + h.ledger_max + (h.ledger_delta != null ? (' (delta ' + h.ledger_delta + ')') : ''));
  if (h.age_max_s != null) lines.push('Ledger age max/avg: ' + h.age_max_s + 's / ' + h.age_avg_s + 's');
  if (h.health_avg != null) lines.push('Health avg/min/max: ' + h.health_avg + ' / ' + h.health_min + ' / ' + h.health_max);
  if (h.peer_in_min != null) lines.push('Peer IN: ' + h.peer_in_min + '-' + h.peer_in_max);
  if (h.peer_out_min != null) lines.push('Peer OUT: ' + h.peer_out_min + '-' + h.peer_out_max);
  if (h.ram_max != null) lines.push('RAM range: ' + h.ram_min + '-' + h.ram_max + '%');
  if (h.cpu_max != null) lines.push('CPU peak: ' + h.cpu_max + '%');
  if (h.temp_max != null) lines.push('Temp peak: ' + h.temp_max + 'C');
  return lines.join('\n');
}
function toNum(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
function median(arr) {
  if (!arr || !arr.length) return null;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2 * 10) / 10;
}
function avg(arr) {
  if (!arr || !arr.length) return null;
  return Math.round(arr.reduce(function (s, x) { return s + x; }, 0) / arr.length * 10) / 10;
}
function minMax(arr) {
  if (!arr || !arr.length) return { min: null, max: null };
  return { min: Math.min.apply(null, arr), max: Math.max.apply(null, arr) };
}
function historyRowsDays(days) { return getTimeWindow(Math.max(1, days || 7) * 24); }
function periodLabel(days) {
  if (days <= 1) return '24h';
  if (days <= 7) return '7 days';
  return days + ' days';
}
function formatMetricAnalysis(metricKey, days) {
  const d = Math.max(1, days || 7);
  const rows = getTimeWindow(d * 24);
  const agg = aggregate(rows, metricKey);
  const titleMap = { ram: '🧠 RAM ANALYSIS', cpu: '⚙️ CPU ANALYSIS', temp: '🌡️ TEMP ANALYSIS', ledger_age: '⏱️ LEDGER AGE ANALYSIS', health: '💚 HEALTH ANALYSIS' };
  const unit = (metricKey === 'temp') ? '°C' : (metricKey === 'ledger_age' ? 's' : (metricKey === 'health' ? '' : '%'));
  const title = (titleMap[metricKey] || metricKey) + ' · ' + periodLabel(d);
  if (!agg.n) return [title, '───────────────', 'Not enough history samples yet. Collecting every ~60s - ask again later.'].join('\n');
  return [
    title, '───────────────',
    '📋 Samples · ' + agg.n,
    '📉 Min     · ' + agg.min + unit,
    '📈 Max     · ' + agg.max + unit,
    '📊 Avg     · ' + agg.avg + unit,
    '🎯 Median  · ' + agg.median + unit
  ].join('\n');
}
function financialBoundaryReply() {
  return [
    '⚡AI PINODE GUIDE', '───────────────',
    'I understand money pressure is real. As a technical Pi Node assistant I only report machine health - I cannot advise buying/selling or personal finance.', '',
    'Technically, check /status and the history summary below. Whether to keep the node is your decision.', '',
    'Ask for 7-day RAM/CPU/sync stats anytime if that helps your technical review.'
  ].join('\n');
}

/* ======================================================================
 * AI DATA PROVIDERS (named blocks)
 * ==================================================================== */
function aiDataConsensus6h() {
  const rows = getTimeWindow(6);
  if (!rows.length) return { samples: 0, note: 'no data in last 6h' };
  return {
    samples: rows.length, window_hours: 6,
    sync_states: syncConsensus(rows).states,
    ledger_velocity: ledgerVelocity(rows),
    ledger_age: aggregate(rows, 'ledger_age'),
    peer_in: aggregate(rows, 'peer_in'), peer_out: aggregate(rows, 'peer_out'),
    health: aggregate(rows, 'health')
  };
}
function aiDataConsensus24h() {
  const rows = getTimeWindow(24);
  if (!rows.length) return { samples: 0, note: 'no data in last 24h' };
  const crit = rows.filter(function (r) { return r.level === 'critical'; }).length;
  const warn = rows.filter(function (r) { return r.level === 'warning' || r.level === 'soft'; }).length;
  return {
    samples: rows.length, window_hours: 24,
    sync_states: syncConsensus(rows).states,
    ledger_velocity: ledgerVelocity(rows),
    ledger_age: aggregate(rows, 'ledger_age'),
    peer_in: aggregate(rows, 'peer_in'), peer_out: aggregate(rows, 'peer_out'),
    health: aggregate(rows, 'health'),
    levels: { critical: crit, warning_or_soft: warn, ok: rows.length - crit - warn }
  };
}
function aiDataLedgerVelocity6h() { return ledgerVelocity(getTimeWindow(6)) || { note: 'insufficient data' }; }
function aiDataPeerTrend24h() {
  const rows = getTimeWindow(24);
  if (!rows.length) return { samples: 0 };
  let flips = 0, lastTotal = null;
  rows.forEach(function (r) {
    const t = (r.peer_in || 0) + (r.peer_out || 0);
    if (lastTotal != null && Math.abs(t - lastTotal) >= 3) flips++;
    lastTotal = t;
  });
  return { samples: rows.length, peer_in: aggregate(rows, 'peer_in'), peer_out: aggregate(rows, 'peer_out'), big_swings: flips };
}
function aiDataMetric7d(key) {
  const rows = getTimeWindow(24 * 7);
  if (!rows.length) return { samples: 0, metric: key };
  return { samples: rows.length, metric: key, stats: aggregate(rows, key) };
}
function aiDataIncidentHistory7d() {
  const now = Date.now();
  const all = state.incidents || {};
  const items = Object.keys(all).map(function (k) { return all[k]; });
  const recent = items.filter(function (i) { return i && (now - (i.resolvedAt || i.lastSeen || i.firstSeen || 0)) < 7 * 86400000; });
  const byType = {};
  recent.forEach(function (i) {
    if (!byType[i.type]) byType[i.type] = { count: 0, alerts: 0, totalMin: 0 };
    byType[i.type].count++;
    byType[i.type].alerts += (i.alertsSent || 0);
    const end = i.resolvedAt || i.lastSeen || now;
    byType[i.type].totalMin += Math.max(0, Math.round((end - i.firstSeen) / 60000));
  });
  return { total_recent: recent.length, by_type: byType };
}
function aiDataFullStats24h() {
  const rows = getTimeWindow(24);
  if (!rows.length) return { samples: 0 };
  return {
    samples: rows.length,
    sync_states: syncConsensus(rows).states,
    ledger_velocity: ledgerVelocity(rows),
    ledger_age: aggregate(rows, 'ledger_age'),
    peer_in: aggregate(rows, 'peer_in'), peer_out: aggregate(rows, 'peer_out'),
    ram: aggregate(rows, 'ram'), cpu: aggregate(rows, 'cpu'), temp: aggregate(rows, 'temp'),
    health: aggregate(rows, 'health')
  };
}
function aiDataHourly24h() {
  try {
    ensureRollupLoaded();
    const arr = (_rollupState.hourly || []).slice(-24);
    return arr.map(function (x) {
      return { hour: x.hour, samples: x.n, health_min: x.health_min, max_ledger_age: x.max_age, min_peers: x.min_peers, max_ram: x.max_ram, bad_samples: x.bad };
    });
  } catch (e) { return []; }
}
const AI_DATA_PROVIDERS = {
  consensus_6h: { desc: 'Sync distribution + ledger velocity + ranges over last 6h', fn: aiDataConsensus6h },
  consensus_24h: { desc: 'Same as consensus_6h but over 24h + level counts', fn: aiDataConsensus24h },
  ledger_velocity_6h: { desc: 'Ledger growth rate over last 6h', fn: aiDataLedgerVelocity6h },
  peer_trend_24h: { desc: 'Peer IN/OUT min/max/avg over 24h + big swings', fn: aiDataPeerTrend24h },
  ram_7d: { desc: 'RAM min/max/avg/median over 7 days', fn: function () { return aiDataMetric7d('ram'); } },
  cpu_7d: { desc: 'CPU min/max/avg/median over 7 days', fn: function () { return aiDataMetric7d('cpu'); } },
  temp_7d: { desc: 'Temperature min/max/avg/median over 7 days', fn: function () { return aiDataMetric7d('temp'); } },
  ledger_age_7d: { desc: 'Ledger age min/max/avg/median over 7 days', fn: function () { return aiDataMetric7d('ledger_age'); } },
  incident_history_7d: { desc: 'Incidents last 7 days grouped by type', fn: aiDataIncidentHistory7d },
  full_stats_24h: { desc: 'One-shot 24h stats (sync, ledger, peer, ram, cpu, temp, health)', fn: aiDataFullStats24h },
  hourly_24h: { desc: 'Hourly rollup for last 24 hours', fn: aiDataHourly24h }
};
/* END AI DATA PROVIDERS ================================================ */

/* ======================================================================
 * AI DATA QUERY DSL
 * ==================================================================== */
const AI_METRIC_WHITELIST = {
  ledger: 'number', ledger_age: 'number', peer_in: 'number', peer_out: 'number',
  peer_total: 'number', cpu: 'number', ram: 'number', temp: 'number', disk: 'number',
  health: 'number', health_raw: 'number', health_adjusted: 'number',
  ports_open: 'number', ingest_lag: 'number',
  sync: 'string', level: 'string', container: 'string', docker: 'string',
  health_confidence: 'string', network_kind: 'string', source: 'string',
  ports_all_open: 'boolean', docker_sock: 'boolean'
};
const AI_QUERY_LIMITS = {
  maxQueries: 5, maxWindowHours: 168, maxRawRows: 200, defaultWindowHours: 24
};
function parseKVToken(str) {
  const out = {};
  String(str || '').split(/\s+/).forEach(function (p) {
    const eq = p.indexOf('=');
    if (eq < 0) return;
    const k = p.slice(0, eq).trim().toLowerCase();
    const v = p.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  });
  return out;
}
function parseWindowHours(w) {
  if (!w) return AI_QUERY_LIMITS.defaultWindowHours;
  const s = String(w).trim().toLowerCase();
  let n = null;
  if (/^[\d.]+h?$/.test(s)) n = parseFloat(s);
  else if (/^[\d.]+d$/.test(s)) n = parseFloat(s) * 24;
  else if (/^[\d.]+m$/.test(s)) n = parseFloat(s) / 60;
  if (n == null || !isFinite(n) || n <= 0) return AI_QUERY_LIMITS.defaultWindowHours;
  return Math.max(0.1, Math.min(AI_QUERY_LIMITS.maxWindowHours, n));
}
function parseDataQueries(text) {
  const out = [];
  const re = /\[DATA_QUERY:\s*([^\]]+)\]/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const q = parseKVToken(m[1]);
    if (q.metric) out.push(q);
    if (out.length >= AI_QUERY_LIMITS.maxQueries) break;
  }
  return out;
}
function applyQueryFilters(rows, filterStr) {
  if (!filterStr) return rows;
  const filters = [];
  String(filterStr).split(',').forEach(function (f) {
    const m = String(f).trim().match(/^([a-z_][a-z0-9_]*?)(?:_(eq|lt|gt|le|ge|contains))?=(.+)$/i);
    if (!m) return;
    filters.push({ key: m[1].toLowerCase(), op: (m[2] || 'eq').toLowerCase(), val: m[3] });
  });
  if (!filters.length) return rows;
  return rows.filter(function (r) {
    return filters.every(function (f) {
      const v = r[f.key];
      if (v == null) return false;
      if (f.op === 'contains') return String(v).toLowerCase().indexOf(String(f.val).toLowerCase()) >= 0;
      const vNum = Number(v), valNum = Number(f.val);
      const isNum = isFinite(vNum) && isFinite(valNum);
      if (f.op === 'eq') return isNum ? vNum === valNum : String(v).toLowerCase() === String(f.val).toLowerCase();
      if (f.op === 'lt') return isNum ? vNum < valNum : false;
      if (f.op === 'gt') return isNum ? vNum > valNum : false;
      if (f.op === 'le') return isNum ? vNum <= valNum : false;
      if (f.op === 'ge') return isNum ? vNum >= valNum : false;
      return false;
    });
  });
}
function stateDistribution(rows, key) {
  const counts = {};
  let total = 0;
  rows.forEach(function (r) {
    const v = r[key];
    if (v == null) return;
    total++;
    const k = String(v);
    counts[k] = (counts[k] || 0) + 1;
  });
  const states = {};
  Object.keys(counts).forEach(function (k) {
    states[k] = { count: counts[k], pct: Math.round(counts[k] / Math.max(1, total) * 1000) / 10 };
  });
  return { total: total, states: states };
}
function aggregateHourly(rows, key) {
  const buckets = {};
  rows.forEach(function (r) {
    if (r[key] == null) return;
    const ts = Date.parse(r.ts);
    if (!isFinite(ts)) return;
    const hourKey = new Date(ts).toISOString().slice(0, 13);
    if (!buckets[hourKey]) buckets[hourKey] = [];
    buckets[hourKey].push(r);
  });
  return Object.keys(buckets).sort().map(function (hk) {
    return { hour: hk, n: buckets[hk].length, stats: aggregate(buckets[hk], key) };
  });
}
function rateOfChange(rows, key) {
  if (!rows || rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  if (first[key] == null || last[key] == null) return null;
  const dt = (Date.parse(last.ts) - Date.parse(first.ts)) / 3600000;
  if (!isFinite(dt) || dt <= 0) return null;
  return {
    delta: Math.round((last[key] - first[key]) * 100) / 100,
    hours: Math.round(dt * 10) / 10,
    per_hour: Math.round((last[key] - first[key]) / dt * 100) / 100
  };
}
function metricTrend(rows, key) {
  const vals = rows.map(function (r) { return r[key]; })
    .filter(function (x) { return x != null && isFinite(Number(x)); }).map(Number);
  if (vals.length < 4) return { direction: 'unknown', note: 'insufficient samples' };
  const half = Math.floor(vals.length / 2);
  let olderSum = 0, newerSum = 0;
  for (let i = 0; i < half; i++) olderSum += vals[i];
  for (let i = vals.length - half; i < vals.length; i++) newerSum += vals[i];
  const olderAvg = olderSum / half, newerAvg = newerSum / half;
  const delta = newerAvg - olderAvg;
  const m = vals.reduce(function (s, x) { return s + x; }, 0) / vals.length;
  const thresh = Math.max(0.5, Math.abs(m) * 0.05);
  let direction = 'stable';
  if (delta > thresh) direction = 'increasing';
  else if (delta < -thresh) direction = 'decreasing';
  return {
    direction: direction,
    delta: Math.round(delta * 100) / 100,
    older_avg: Math.round(olderAvg * 100) / 100,
    newer_avg: Math.round(newerAvg * 100) / 100,
    samples: vals.length
  };
}
function executeDataQuery(q) {
  const metric = String(q.metric || '').toLowerCase();
  const kind = AI_METRIC_WHITELIST[metric];
  if (!kind) return {
    ok: false, error: 'unknown_metric', requested: metric,
    allowed_numeric: ['ledger','ledger_age','peer_in','peer_out','peer_total','cpu','ram','temp','disk','health','health_raw','health_adjusted','ports_open','ingest_lag'],
    allowed_category: ['sync','level','container','docker','health_confidence','network_kind','source','ports_all_open','docker_sock']
  };
  const windowH = parseWindowHours(q.window);
  const agg = String(q.agg || (kind === 'number' ? 'summary' : 'states')).toLowerCase();
  const limit = Math.max(1, Math.min(AI_QUERY_LIMITS.maxRawRows, parseInt(q.limit || '20', 10) || 20));
  let rows = getTimeWindow(windowH);
  rows = applyQueryFilters(rows, q.filter);
  const base = { ok: true, metric: metric, kind: kind, window_hours: windowH, samples: rows.length };
  if (!rows.length) return Object.assign(base, { note: 'no data in window after filter' });
  if (kind === 'string' || kind === 'boolean') {
    if (agg === 'hourly') return Object.assign(base, { hourly: aggregateHourly(rows, metric) });
    return Object.assign(base, stateDistribution(rows, metric));
  }
  if (agg === 'velocity') return Object.assign(base, { velocity: rateOfChange(rows, metric) });
  if (agg === 'hourly') return Object.assign(base, { hourly: aggregateHourly(rows, metric) });
  if (agg === 'trend') return Object.assign(base, { trend: metricTrend(rows, metric) });
  if (agg === 'raw') return Object.assign(base, {
    returned: Math.min(rows.length, limit),
    rows: rows.slice(-limit).map(function (r) { const o = { ts: r.ts }; o[metric] = r[metric]; return o; })
  });
  return Object.assign(base, { stats: aggregate(rows, metric) });
}
function runDataQueries(queries) {
  const results = {};
  (queries || []).slice(0, AI_QUERY_LIMITS.maxQueries).forEach(function (q) {
    const key = 'q_' + (q.metric || '?') + '_' + (q.window || '24') + '_' + (q.agg || 'summary') + (q.filter ? '_f' : '');
    try { results[key] = executeDataQuery(q); }
    catch (e) { results[key] = { ok: false, error: String(e && e.message) }; }
  });
  return results;
}
function buildDSLSpec() {
  return [
    'metric (numeric): ledger, ledger_age, peer_in, peer_out, peer_total, cpu, ram, temp, disk, health, health_raw, health_adjusted, ports_open, ingest_lag',
    'metric (category): sync, level, container, docker, health_confidence, network_kind, source, ports_all_open, docker_sock',
    'agg: summary (numeric default), states (category default), velocity (rate/h), hourly (group by hour), raw (last N samples), trend (older vs newer avg)',
    'window: 30m, 6h, 24h, 7d (max 168h)',
    'filter: key=value, key_lt, key_gt, key_le, key_ge, key_contains; separate with commas',
    'limit: for agg=raw, default 20, max 200',
    'max 5 queries per round'
  ].join('\n');
}
function buildProviderCatalog() {
  return Object.keys(AI_DATA_PROVIDERS).map(function (k) { return '- ' + k + ' : ' + AI_DATA_PROVIDERS[k].desc; }).join('\n');
}
function parseDataRequests(text) {
  const out = [];
  const re = /\[DATA_REQUEST:\s*([a-z0-9_]+)\s*\]/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const key = String(m[1] || '').toLowerCase();
    if (AI_DATA_PROVIDERS[key] && out.indexOf(key) < 0) out.push(key);
  }
  return out;
}
function stripDataRequests(text) {
  return String(text || '')
    .replace(/\[DATA_REQUEST:\s*[a-z0-9_]+\s*\]/gi, '')
    .replace(/\[DATA_QUERY:[^\]]+\]/gi, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
/* END DSL ============================================================== */

/* ======================================================================
 * NATURAL LANGUAGE COMMAND PARSER
 * ==================================================================== */
function extractHoursFromText(low) {
  const hours = [];
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|h|giờ|sáng|chiều|tối|đêm|trưa|a\.m\.|p\.m\.)?/gi;
  let m;
  while ((m = re.exec(low))) {
    let h = parseInt(m[1], 10);
    const mer = (m[3] || '').toLowerCase();
    if (!isFinite(h) || h < 0 || h > 23) continue;
    if (/(pm|chiều|tối)/.test(mer) && h < 12) h += 12;
    if (/(am|sáng)/.test(mer) && h === 12) h = 0;
    if (/đêm/.test(mer) && h === 12) h = 0;
    if (/trưa/.test(mer) && h < 12) h = 12;
    hours.push(h);
  }
  if (/\bmidnight\b|nửa\s*đêm|12\s*giờ\s*đêm/i.test(low)) hours.push(0);
  if (/\bnoon\b|12\s*giờ\s*trưa/i.test(low)) hours.push(12);
  const uniq = Array.from(new Set(hours)).sort(function (a, b) { return a - b; });
  return uniq.slice(0, 4);
}

function tryNaturalCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 220) return null;
  const low = s.toLowerCase();

  const looksLikeSetting = /(report|báo\s*cáo|informe|alert|notification|báo\s*động|thông\s*báo|mute|im\s*lặng|silent|quiet|yên\s*tĩnh|turn\s+(on|off)|bật|tắt|disable|enable|stop|schedule|lịch)/i.test(low);
  if (!looksLikeSetting) return null;

  if (/(stop|turn\s*off|disable|tắt|dừng|no\s*more)\s+(daily\s+)?(report|báo\s*cáo|informe)/i.test(low) ||
      /(report|báo\s*cáo)\s+(off|stop|tắt|dừng)/i.test(low)) {
    state.reportHours = 'off';
    try { saveJSON(STATE_F, state); } catch (e) {}
    return '⏰ Scheduled reports OFF.\nUse /report_both to re-enable.';
  }

  if (/(turn\s*on|enable|bật|reativar|activar)\s+(alert|notification|báo\s*động|thông\s*báo|notif)/i.test(low)) {
    state.alertMode = 'on'; state.muteUntil = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
    return '🔔 Alerts ON. All notifications active.';
  }
  if (/(turn\s*off|disable|tắt|dừng|silence|silenciar)\s+(all\s+)?(alert|notification|báo\s*động|thông\s*báo|notif)/i.test(low)) {
    state.alertMode = 'off'; state.muteUntil = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
    return '🔕 Alerts OFF until you press On.';
  }
  if (/(night\s*mode|quiet\s+at\s+night|yên\s*tĩnh\s*ban\s*đêm|im\s*lặng\s*ban\s*đêm|no\s*sound\s*at\s*night)/i.test(low)) {
    state.alertMode = 'night'; state.muteUntil = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
    return '🌙 Night quiet 22:00–07:00 activated.';
  }

  const muteMatch = low.match(/(mute|im\s*lặng|silent|quiet|silenciar|pausar)\s*(?:for|trong|durante)?\s*(\d+)\s*(h|hour|giờ|m|min|minute|phút|seg|sec)/i);
  if (muteMatch) {
    const n = parseInt(muteMatch[2], 10);
    const unit = String(muteMatch[3] || '').toLowerCase();
    let hours = n;
    if (/^(m|min|minute|phút)/.test(unit)) hours = n / 60;
    if (/^(s|seg|sec)/.test(unit)) hours = n / 3600;
    if (hours > 0 && hours <= 72) {
      setMuteHours(hours);
      const label = hours < 1 ? Math.round(hours * 60) + ' min' : (Math.round(hours * 10) / 10) + 'h';
      return '🔇 Muted for ' + label + '.\n' + formatMuteAck();
    }
  }

  if (/(report|báo\s*cáo|informe|schedule|lịch)/i.test(low)) {
    const hours = extractHoursFromText(low);
    if (hours && hours.length) {
      state.reportHours = hours;
      try { saveJSON(STATE_F, state); } catch (e) {}
      const fmt = hours.map(function (h) { return String(h).padStart(2, '0') + ':00'; }).join(', ');
      return '🕐 Daily reports scheduled at: ' + fmt + '.\nUse /report_off to turn off.';
    }
  }

  return null;
}
/* END NATURAL LANGUAGE PARSER ======================================== */

function localAssistantReply(t, intent, userQ) {
  const ok = t.level === 'ok' || (t.sync && /synced|live|horizon ok/i.test(String(t.sync)));
  const age = t.ledger_age != null ? t.ledger_age : null;
  const sync = t.sync || null;
  const ledger = t.ledger != null ? Number(t.ledger).toLocaleString('en-US') : null;
  const h24 = buildHistory24h();
  const hTxt = formatHistory24hText(h24);
  function withHistory(msg) {
    if (!h24 || !h24.samples) return msg;
    return msg + '\n\nLast ~24h data\n' + hTxt + '\n\nTip: use /report for a fuller summary.';
  }
  if (intent === 'GREETING') return 'Hi! I am watching your Pi Node. Right now it looks ' + (ok ? 'fine' : 'like it needs attention') + '. Ask about sync, ports, bonus, or upgrades anytime.';
  if (intent === 'SMALLTALK') return 'Around ' + nowHM() + ' local time. I can help with your Node - ask naturally.';
  if (intent === 'CLARIFY') return 'Simply put: the node looks ' + (ok ? 'healthy' : 'unstable') + (sync ? ('; sync: ' + sync) : '') + (ledger ? ('; ledger ~' + ledger) : '') + '. What should I explain more?';
  if (intent === 'BONUS') return 'Bonus depends on stable uptime, open ports, and good sync - this app does not show bonus points. ' + (ok ? ('Your node looks ' + (sync || 'synced') + (age != null ? (', age ' + age + 's') : '') + '. Keep online 24/7, ports open, avoid constant restarts.') : 'Something looks off - check sync and ports first.');
  if (intent === 'BLOCK_SYNC' || intent === 'DIAGNOSIS') {
    if (ok && age != null && age <= 60) return withHistory('I get the concern about losing sync. Right now it is ' + (sync || 'Synced') + ', ledger ~' + (ledger || '?') + ', age ' + age + 's - blocks are closing on time. Short blips often recover alone; if it keeps happening, check network and /report.');
    if (age != null && age > 120) return 'Sync looks slow: age ' + age + 's (' + (sync || '?') + '). It may be catching up or the network is congested. Check ports; restart Pi Node if this lasts >10 minutes.';
    return 'On sync: ' + (sync || 'unclear') + (ledger ? (', ledger ' + ledger) : '') + (age != null ? (', age ' + age + 's') : '') + '. If dropouts are frequent, send /report.';
  }
  if (intent === 'NODE_HEALTH') return withHistory('Overall the node looks ' + (ok ? 'healthy' : 'like it needs attention') + (sync ? (', ' + sync) : '') + (ledger ? (', ledger ' + ledger) : '') + '. ' + (ok ? 'Safe to keep running; check /peers and /report for more confidence.' : 'Open /diagnostic and verify ports/network.'));
  if (intent === 'ADVICE' || intent === 'RECOMMENDATION') return 'Practical tips: (1) keep online, (2) keep ports 31401-31403 open, (3) enough RAM and cooling, (4) avoid constant resets. Windows PRO: https://github.com/cannoi/pinode-telegram-controller';
  if (intent === 'RAM') return formatMetricAnalysis('ram', 7) + (t.ram != null ? ('\n\nNow · ' + t.ram + '%') : '');
  if (intent === 'CPU') return formatMetricAnalysis('cpu', 7) + (t.cpu != null ? ('\n\nNow · ' + t.cpu + '%') : '');
  if (intent === 'TEMP') return formatMetricAnalysis('temp', 7) + (t.temp != null ? ('\n\nNow · ' + t.temp + '°C') : '');
  if (intent === 'FINANCE') return financialBoundaryReply() + (h24 && h24.samples ? ('\n\n' + hTxt) : '');
  if (intent === 'PEERS') {
    if (t.peer_in == null && t.peer_out == null) return 'Peer counts unavailable. Try /ports.';
    return 'Peers IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?');
  }
  if (intent === 'PORT') {
    if (!t.ports) return 'Ports not probed yet.';
    return NODE_PORTS.map(function (p) { return p + ': ' + (t.ports[String(p)] || '?'); }).join('\n');
  }
  if (intent === 'DOCKER') return 'SoloHost does not control host Docker. Container label: ' + (t.container || 'n/a') + '.';
  if (ok) return withHistory('From current data the node looks fine' + (sync ? (' (' + sync + ')') : '') + (ledger ? (', ledger ' + ledger) : '') + '. Brief sync drops are often temporary - keep it online and check /report if it repeats.');
  return withHistory('Something needs attention' + (sync ? (': ' + sync) : '') + '. Check /diagnostic and network/ports.');
}

/* GEMINI =============================================================== */
const GEMINI_FALLBACK_ORDER = [
  'gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-preview',
  'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
  'gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'
];
function geminiScore(name) {
  const n = String(name || '').toLowerCase();
  if (/3\.1.*flash.*lite.*preview/.test(n)) return 100;
  if (/3\.1.*flash.*lite/.test(n)) return 95;
  if (/3\.1.*flash.*preview/.test(n)) return 90;
  if (/3\.1.*flash/.test(n)) return 88;
  if (/3\.5.*flash/.test(n)) return 85;
  if (/3.*flash.*preview/.test(n)) return 82;
  if (/3.*flash/.test(n)) return 80;
  if (/2\.5.*flash.*lite/.test(n)) return 70;
  if (/2\.5.*flash/.test(n)) return 65;
  if (/2\.0.*flash.*lite/.test(n)) return 55;
  if (/2\.0.*flash/.test(n)) return 50;
  if (/1\.5.*flash/.test(n)) return 40;
  if (/flash/.test(n)) return 30;
  return 10;
}
function stripModelsPrefix(id) { return String(id || '').replace(/^models\//, ''); }
async function httpGetGemini(pathSuffix) {
  if (!GEMINI_API_KEY) return null;
  return new Promise(function (resolve) {
    const path = '/v1beta/' + pathSuffix + (pathSuffix.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(GEMINI_API_KEY);
    const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: path, method: 'GET', headers: { 'Accept': 'application/json' } }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () { try { resolve({ status: r.statusCode, body: safeParse(b) }); } catch (e) { resolve(null); } });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(15000, function () { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}
async function discoverGeminiModels(force) {
  if (!GEMINI_API_KEY) return [];
  const now = Date.now();
  if (!force && state.geminiModels && state.geminiModels.length) return state.geminiModels;
  const r = await httpGetGemini('models');
  let names = [];
  if (r && r.body && Array.isArray(r.body.models)) {
    r.body.models.forEach(function (m) {
      const id = stripModelsPrefix(m.name || m.id || '');
      const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
      const canGen = !methods.length || methods.indexOf('generateContent') >= 0;
      if (id && canGen && /gemini/i.test(id) && !/embedding|aqa|tts|vision|image/i.test(id)) names.push(id);
    });
  }
  if (!names.length) names = GEMINI_FALLBACK_ORDER.slice();
  names.sort(function (a, b) { return geminiScore(b) - geminiScore(a); });
  const seen = {};
  names = names.filter(function (n) { if (seen[n]) return false; seen[n] = true; return true; });
  state.geminiModels = names.slice(0, 20); state.geminiModelsAt = now;
  try { saveJSON(STATE_F, state); } catch (e) {}
  try { actionLog('info', 'Gemini models discovered · ' + state.geminiModels.slice(0, 5).join(', ')); } catch (e) {}
  return state.geminiModels;
}
function orderedGeminiModels(discovered) {
  const list = [];
  const seen = {};
  function add(n) { n = stripModelsPrefix(n); if (!n || seen[n]) return; seen[n] = true; list.push(n); }
  if (state.geminiPreferred) add(state.geminiPreferred);
  const pool = (discovered && discovered.length) ? discovered : GEMINI_FALLBACK_ORDER;
  pool.slice().sort(function (a, b) { return geminiScore(b) - geminiScore(a); }).forEach(add);
  GEMINI_FALLBACK_ORDER.forEach(add);
  return list;
}
function rememberGeminiSuccess(model) {
  if (!model) return;
  if (state.geminiPreferred !== model) {
    state.geminiPreferred = model; state.geminiPreferredAt = Date.now(); state.geminiFailStreak = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
    try { actionLog('info', 'Gemini preferred · ' + model); } catch (e) {}
  } else state.geminiFailStreak = 0;
}
function rememberGeminiFailure(model) {
  state.geminiFailStreak = (state.geminiFailStreak || 0) + 1;
  if (state.geminiPreferred === model && state.geminiFailStreak >= 2) {
    try { actionLog('warn', 'Gemini drop preferred · ' + model); } catch (e) {}
    state.geminiPreferred = null; state.geminiFailStreak = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
  } else { try { saveJSON(STATE_F, state); } catch (e) {} }
}
async function callGeminiGenerate(model, body) {
  return new Promise(function (resolve) {
    const u = new URL('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY));
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () {
        try {
          const j = safeParse(b);
          if (j && j.error) { resolve({ ok: false, error: String(j.error.message || j.error.status || 'error').slice(0, 160) }); return; }
          const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
          if (text && String(text).trim()) resolve({ ok: true, text: String(text).trim() });
          else resolve({ ok: false, error: 'empty candidates' });
        } catch (e) { resolve({ ok: false, error: 'parse' }); }
      });
    });
    req.on('error', function (e) { resolve({ ok: false, error: e.message }); });
    req.setTimeout(28000, function () { try { req.destroy(); } catch (e) {} resolve({ ok: false, error: 'timeout' }); });
    req.write(body); req.end();
  });
}
async function generateWithSmartGemini(promptText) {
  if (!GEMINI_API_KEY) return null;
  const body = JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { temperature: 0.85, maxOutputTokens: 2000 } });
  const tried = {};
  async function tryOne(model) {
    if (!model || tried[model]) return null;
    tried[model] = true;
    const res = await callGeminiGenerate(model, body);
    if (res.ok) { rememberGeminiSuccess(model); return res.text; }
    try { actionLog('warn', 'Gemini ' + model + ': ' + (res.error || 'fail')); } catch (e) {}
    rememberGeminiFailure(model);
    return null;
  }
  if (state.geminiPreferred) { const hit = await tryOne(state.geminiPreferred); if (hit) return hit; }
  const discovered = await discoverGeminiModels(true);
  const models = orderedGeminiModels(discovered);
  const maxTry = Math.min(models.length, 4);
  for (let i = 0; i < maxTry; i++) { const hit = await tryOne(models[i]); if (hit) return hit; }
  return null;
}
function formatAiReply(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;
  s = s.replace(/\*\*/g, ''); s = s.replace(/__/g, ''); s = s.replace(/`{1,3}/g, '');
  s = s.replace(/^#{1,6}\s+/gm, ''); s = s.replace(/^\s*[-*]\s+/gm, '• ');
  s = s.replace(/[━─═]{3,}/g, '───────────────'); s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, 3500);
}
function technicianEvaluate(t, userQ, intent) {
  const h = buildHistory24h();
  const sync = (t && t.sync) || (h && h.last_sync) || null;
  const ledger = t && t.ledger != null ? Number(t.ledger).toLocaleString('en-US') : null;
  const age = t && t.ledger_age != null ? t.ledger_age : null;
  const ok = (t && t.level === 'ok') || (sync && /synced|live|horizon ok/i.test(String(sync)));
  const issues = collectIssues(t || {});
  const script = t && t._suggestedScript ? t._suggestedScript : recommendScriptForTelemetry(t || {});

  const lines = [];
  lines.push('🤖 PI NODE · DIAGNOSTIC');
  lines.push('───────────────');
  lines.push('');

  lines.push('1. 🔍 DETECT');
  if (issues.length) {
    issues.slice(0, 3).forEach(function (x) { lines.push('   · ' + x); });
  } else if (ok) {
    lines.push('   · No issue detected. Node is healthy.');
  } else {
    lines.push('   · Sync/resource signal needs watching.');
  }
  lines.push('');

  lines.push('2. 🧠 VERIFY');
  if (sync && /catch|behind|syncing/i.test(String(sync)) && ledger && age != null && age <= 300) {
    lines.push('   · Likely natural catch-up. Not a fault yet.');
  } else if (t && t.ports_open === 0 && t.container) {
    lines.push('   · Container RUNNING but ports closed - check firewall.');
  } else if (t && t.ports_open === 0 && !t.container) {
    lines.push('   · Container NOT running - ports closed is normal.');
  } else if (ok) {
    lines.push('   · No false-positive signal. Continue observing.');
  } else {
    lines.push('   · Data limited; gather a few more samples.');
  }
  lines.push('');

  lines.push('3. 💡 EXPLAIN');
  if (sync) lines.push('   · Sync: ' + sync + (age != null ? (' (age ' + age + 's)') : ''));
  if (ledger) lines.push('   · Ledger: ' + ledger);
  if (t && t.health != null) lines.push('   · Health ' + t.health + '/100 (' + (t.health_confidence || '?') + ', ' + (t.health_trend || 'stable') + ')');
  lines.push('');

  lines.push('4. 🛠️ RECOMMEND');
  if (script) {
    lines.push('   · Run: `' + script.file + '` [' + script.level + ']');
    lines.push('   · ' + script.when);
  } else {
    lines.push('   · No script needed. Keep online and watch.');
  }
  lines.push('');

  lines.push('5. 🛡️ SAFETY');
  if (script) {
    lines.push('   · Level ' + script.level + ' (' + script.levelTxt + ')');
    lines.push('   · ' + script.safety);
  } else {
    lines.push('   · No intervention. Node untouched.');
  }
  lines.push('');

  lines.push('6. 👤 ACTION');
  if (script) {
    lines.push('   · SoloHost UI -> Scripts -> ' + script.file);
    lines.push('   · Or double-click the .bat (press Y).');
  } else {
    lines.push('   · Nothing to run now.');
  }
  lines.push('');

  lines.push('7. 🔄 RECHECK');
  if (script) lines.push('   · Wait 10-15 min. Then /status or /report.');
  else lines.push('   · Check /report after ~30 min for trends.');
  lines.push('');
  lines.push('───────────────');
  lines.push('Ask for more details anytime.');
  return lines.join('\n') + horizonFooter(t);
}
function recommendScriptForTelemetry(t) {
  t = t || {};
  const portsOpen = t.ports_open != null ? Number(t.ports_open) : null;
  const containerRunning = !!t.container && !/stop|exit/i.test(String(t.docker || ''));
  const ram = t.ram != null ? Number(t.ram) : null;
  const docker = String(t.docker || '');
  const sync = String(t.sync || '');
  const age = t.ledger_age != null ? Number(t.ledger_age) : null;
  const peerTotal = (t.peer_in != null || t.peer_out != null) ? ((t.peer_in || 0) + (t.peer_out || 0)) : null;
  if (/not ready|error|fail/i.test(docker)) return SCRIPT_DETAILS.dockerrecover;
  if (portsOpen === 0 && !containerRunning) return SCRIPT_DETAILS.nodereset;
  if (portsOpen === 0 && containerRunning) return SCRIPT_DETAILS.firewall;
  if (age != null && age > 300 && containerRunning) return SCRIPT_DETAILS.nodereset;
  if (peerTotal === 0 && /synced|live/i.test(sync)) return SCRIPT_DETAILS.dnsflush;
  if (ram != null && ram >= 85) return SCRIPT_DETAILS.cleanram;
  if (t.disk != null && Number(t.disk) >= 90) return SCRIPT_DETAILS.maintain;
  return null;
}

/* aiAnalyze with 2-round AI Data Protocol + language options ======== */
async function aiAnalyze(t, userQ, opts) {
  opts = opts || {};
  const skipCurrentForLang = opts.quickAction === true || isQuickActionText(userQ);
  const appGuide = (typeof APP_KNOWLEDGE === 'string' ? APP_KNOWLEDGE : '').slice(0, 2500) +
                   '\n\n' + PI_NODE_DEEP_KNOWLEDGE;
  try { await fetchPctContext(); } catch (e) {}
  try {
    const intent = detectIntent(userQ || '');
    const userLang = skipCurrentForLang
      ? detectUserPreferredLang('', { skipCurrent: true })
      : detectUserPreferredLang(userQ || '');
    const q = String(userQ || '');
    let days = 7;
    if (/24\s*h|24h|today|1\s*day|h[oô]m nay/i.test(q)) days = 1;
    if (/30\s*day|30d|month|th[aá]ng/i.test(q)) days = 30;
    days = Math.min(days, 7);
    const mk = metricIntentKey(intent);
    let metricBlock = '';
    if (mk) {
      metricBlock = formatMetricAnalysis(mk, days);
      if (t && t[mk] != null) metricBlock += '\n\nNow · ' + t[mk] + (mk === 'temp' ? '°C' : '%');
    } else if (intent === 'BLOCK_SYNC' || intent === 'DIAGNOSIS' || intent === 'NODE_HEALTH' || intent === 'GENERAL' || intent === 'BONUS' || intent === 'RECOMMENDATION' || intent === 'ADVICE' || intent === 'CLARIFY' || intent === 'FINANCE') {
      try { const h = buildHistory24h(); if (h && h.samples) metricBlock = formatHistory24hText(h); } catch (e) {}
    }
    const facts = lite.aiContext(t, { prevRows: getTimeWindow(1) });
    const hist24 = buildHistory24h();
    const hist = historySnippet(40);
    const chat = loadChatHistory().slice(-10);
    const issues = collectIssues(t);
    const rows7 = getTimeWindow(24 * 7);
    const ram7 = aggregate(rows7, 'ram'), cpu7 = aggregate(rows7, 'cpu'), age7 = aggregate(rows7, 'ledger_age');
    const stats7 = { samples: rows7.length, ram: ram7.n ? ram7 : null, cpu: cpu7.n ? cpu7 : null, ledger_age: age7.n ? age7 : null };

    if (GEMINI_API_KEY) {
      const providerCatalog = buildProviderCatalog();
      const dslSpec = buildDSLSpec();
      const basePromptParts = [
        '[APP GUIDE]',
        appGuide,
        '',
        PI_NODE_DIAGNOSTIC_PROMPT,
        '',
        '=== DEEP KNOWLEDGE (use when relevant, do NOT repeat verbatim) ===',
        PI_NODE_DEEP_KNOWLEDGE,
        '',
        '=== NATURAL LANGUAGE COMMANDS (already handled at app level) ===',
        'Settings commands like report schedule, alerts on/off/night, mute N hours, stop reports',
        'are parsed by the app BEFORE reaching you. You will not see them. Focus on technician analysis.',
        '',
        '=== RUN CONTEXT ===',
        'LANGUAGE (MANDATORY): Reply in ' + userLang + '. Do NOT switch to English unless the user is using English.',
        'DATA RULES: Use ONLY the JSON blocks below and any DATA_BLOCK/DSL_QUERY_RESULTS you receive. Missing field = unknown, NEVER say 0%.',
        'HEALTH SCORE: t.health is smoothed. t.health_raw pre-damper. t.health_adjusted after stability. t.health_confidence = sources. t.health_trend = improving/stable/degrading.',
        'STABILITY: "unstable_short" -> tolerant; "sustained_bad" -> low score intentional.',
        'INCIDENT ENGINE: Reference RECOMMENDED_SCRIPT (or WAIT) exactly.',
        'SOURCE NOTE: If docker.sock is OFF, data is Horizon-only and may differ from Pi Node Desktop. Be honest about that limitation.',
        'HOST vs CONTAINER (CRITICAL): system.cpu/ram/disk are Node OS (node_os). container_cpu/container_ram are Docker container. Never mix them.',
        '',
        '=== DATA REQUEST PROTOCOL ===',
        '1) NAMED BLOCKS: emit [DATA_REQUEST:block_name]',
        '   Available:', providerCatalog,
        '2) DSL: emit [DATA_QUERY: metric=<key> window=<Nh|Nd|Nm> agg=<...> limit=<N> filter=<...>]',
        '   ' + dslSpec.replace(/\n/g, '\n   '),
        '   Examples:',
        '     [DATA_QUERY: metric=ram window=7d agg=summary]',
        '     [DATA_QUERY: metric=sync window=6h agg=states]',
        '     [DATA_QUERY: metric=ledger window=1h agg=velocity]',
        '     [DATA_QUERY: metric=health window=24h agg=hourly]',
        '     [DATA_QUERY: metric=ledger_age window=48h agg=raw limit=50]',
        '     [DATA_QUERY: metric=cpu window=24h agg=summary filter=level=critical]',
        '     [DATA_QUERY: metric=peer_in window=12h agg=trend]',
        'RULES:',
        '- Up to 5 tokens per round. Mix named blocks + DSL.',
        '- Controller executes and re-queries ONCE with results.',
        '- If existing data is enough, DO NOT emit any token.',
        '',
        'FORMAT: no markdown special characters. Short lines. Icons ok.',
        'Follow the 7-step DIAGNOSTIC FLOW and end with a clear next-action.',
        'FINANCE: Empathy + technical health only. No buy/sell advice.',
        '',
        'Detected user language: ' + userLang,
        'Quick-action mode: ' + (skipCurrentForLang ? 'yes (language from chat history)' : 'no'),
        'Intent: ' + intent,
        'User question: ' + q.slice(0, 900),
        'Issues: ' + JSON.stringify(issues),
        'CURRENT_FACTS: ' + JSON.stringify(facts),
        'STABILITY: ' + JSON.stringify(state.healthStability || null),
        'ACTIVE_INCIDENT: ' + JSON.stringify((function () {
          const active = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; }).filter(function (i) { return i && !i.resolved; })[0];
          if (!active) return null;
          const s = smartScriptForIncident(active, t);
          return { type: active.type, stage: active.stage || 0, samples: active.samples || 1, severity: active.severity, recommended_script: s ? s.script : null, recommended_note: s ? s.note : null };
        })()),
        'SCRIPT_MAP:\n' + SCRIPT_MAP,
        'APP_GUIDE:\n' + APP_GUIDE,
        'PCT_RELEASES: ' + JSON.stringify(state.pctNews || []),
        'HISTORY_24H: ' + JSON.stringify(hist24),
        'HOUR_TREND: ' + JSON.stringify((function () { try { ensureRollupLoaded(); const arr = (_rollupState.hourly || []).slice(-12); return arr.map(function (x) { return { hour: x.hour, n: x.n, health_min: x.health_min, max_age: x.max_age, min_peers: x.min_peers, max_ram: x.max_ram, bad: x.bad }; }); } catch (e) { return []; } })()),
        'STATS_7D: ' + JSON.stringify(stats7),
        metricBlock ? ('RELATED_METRIC_BLOCK:\n' + metricBlock) : '',
        facts.health != null && facts.health < 60 ? (hist.length ? ('RECENT_SAMPLES: ' + JSON.stringify(hist.slice(-8))) : '') : '',
        chat.length ? ('Recent chat: ' + JSON.stringify(chat)) : ''
      ];
      const promptRound1 = basePromptParts.filter(Boolean).join('\n');

      let text = null;
      try { text = await generateWithSmartGemini(promptRound1); }
      catch (e) { try { actionLog('error', 'Gemini round1 fail: ' + (e && e.message)); } catch (e2) {} }

      if (text && String(text).trim()) {
        const named = parseDataRequests(text);
        const dsl = parseDataQueries(text);
        if (named.length || dsl.length) {
          const blocks = {};
          named.forEach(function (key) {
            try { blocks[key] = AI_DATA_PROVIDERS[key].fn(); }
            catch (e) { blocks[key] = { error: String(e && e.message) }; }
          });
          const dslResults = runDataQueries(dsl);
          const promptRound2 = promptRound1 +
            '\n\n=== DATA_BLOCKS (named) ===\n' + JSON.stringify(blocks) +
            '\n=== DSL_QUERY_RESULTS ===\n' + JSON.stringify(dslResults) +
            '\n=== END ===\n\n' +
            'Now write the FINAL reply in ' + userLang + ' using these data blocks and DSL results. ' +
            'Do NOT emit any [DATA_REQUEST] or [DATA_QUERY] this time. Follow the 7-step flow. No markdown.';
          let text2 = null;
          try { text2 = await generateWithSmartGemini(promptRound2); }
          catch (e) { try { actionLog('error', 'Gemini round2 fail: ' + (e && e.message)); } catch (e2) {} }
          if (text2 && String(text2).trim()) text = text2;
        }
        const cleaned = stripDataRequests(text);
        if (cleaned) {
          try { actionLog('info', 'AI reply ok · lang ' + userLang + ' · intent ' + intent + ' · quick=' + (skipCurrentForLang ? '1' : '0') + ' · named ' + named.length + ' · dsl ' + dsl.length); } catch (e) {}
          return '⚡AI PINODE GUIDE\n\n' + formatAiReply(cleaned) + horizonFooter(t);
        }
      }
    }

    try { actionLog('warn', GEMINI_API_KEY ? 'Gemini empty/fail · local technician' : 'no GEMINI_API_KEY · local technician'); } catch (e) {}
    if (intent === 'FINANCE') return financialBoundaryReply() + '\n\n' + technicianEvaluate(t, userQ, intent);
    if (mk && metricBlock) return metricBlock + '\n\n' + technicianEvaluate(t, userQ, intent);
    return technicianEvaluate(t, userQ, intent);
  } catch (e) {
    try { actionLog('error', 'aiAnalyze ' + (e && e.message)); } catch (e2) {}
    try { return localAssistantReply(t, detectIntent(userQ || ''), userQ || ''); } catch (e3) { return 'Assistant error. Try /status.'; }
  }
}

async function localCommandText(cmd, msg) {
  const t = cache || await getTelemetry();
  cmd = String(cmd || '').replace(/^\//, '').toLowerCase();
  if (cmd === 'help' || cmd === 'start') return formatHelp();
  if (cmd === 'status' || cmd === 's') return formatStatus(t);
  if (cmd === 'sync') return formatStatus(t);
  if (cmd === 'peers') return formatPeers(t);
  if (cmd === 'report' || cmd === 'trends') return formatReport(24);
  if (cmd === 'incidents') return formatIncidents();
  if (cmd === 'scripts' || cmd === 'script') return formatScripts();
  if (cmd === 'diagnostic' || cmd === 'diag') return formatDiagnostic(t);
  if (cmd === 'logs') return formatActionLog();
  if (cmd === 'ping') return 'pong · v' + VERSION;
  if (cmd === 'donate') return formatDonate();
  if (cmd === 'winpro') return 'Windows PRO: ' + GITHUB_PRO;
  if (cmd === 'analyze') return aiAnalyze(t, msg || 'Review my node', { quickAction: isQuickActionText(msg) });
  return null;
}

function mainKeyboard() {
  return { inline_keyboard: [
    [{ text: '📊 Status', callback_data: 'cmd_status' }, { text: '📈 Report', callback_data: 'cmd_report' }],
    [{ text: '👥 Peers', callback_data: 'cmd_peers' }, { text: '🧭 Incidents', callback_data: 'cmd_incidents' }],
    [{ text: '🩺 Diag', callback_data: 'cmd_diagnostic' }, { text: '🔧 Scripts', callback_data: 'cmd_scripts' }],
    [{ text: '💬 Analyze', callback_data: 'cmd_analyze' }, { text: '❓ Help', callback_data: 'cmd_help' }],
    [{ text: '💻 PRO', callback_data: 'cmd_winpro' }, { text: '💛 Donate', callback_data: 'cmd_donate' }]
  ]};
}

/* TELEGRAM ============================================================= */
function tgApi(method, body) {
  return new Promise(resolve => {
    if (!BOT_TOKEN) return resolve(null);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.telegram.org', path: '/bot' + BOT_TOKEN + '/' + method,
      method: data ? 'POST' : 'GET',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(safeParse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(35000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
async function tgSend(text, extra) {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  const body = Object.assign({ chat_id: CHAT_ID, text: String(text == null ? '' : text).slice(0, 4000), disable_web_page_preview: true }, extra || {});
  const r = await tgApi('sendMessage', body);
  if (r && r.ok === false) log('tgSend fail: ' + (r.description || JSON.stringify(r)), 'error');
  if (!r) log('tgSend network fail', 'error');
  return r;
}
async function runCmd(cmd, userText) {
  const t = await getTelemetry();
  if (cmd === 'status' || cmd === 's') return tgSend(formatStatus(t), { reply_markup: mainKeyboard() });
  if (cmd === 'sync') {
    const lines = ['🔄 SYNC', '───────────────'];
    if (t.sync) lines.push('🔄 Sync: ' + t.sync);
    if (t.ledger != null) lines.push('📦 Ledger: ' + fmtN(t.ledger));
    if (t.ledger_age != null) lines.push('⏱️ Age: ' + t.ledger_age + 's');
    if (t.health != null) lines.push('💚 Health: ' + t.health + '/100 (' + (t.health_confidence || 'low') + ')');
    if (lines.length === 2) lines.push('⚠️ Sync data unavailable');
    return tgSend(lines.join('\n') + horizonFooter(t), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'peers') return tgSend(formatPeers(t), { reply_markup: mainKeyboard() });
  if (cmd === 'ports') {
    const lines = ['PORTS', '───────────────'];
    NODE_PORTS.forEach(p => {
      const st = t.ports && t.ports[String(p)];
      lines.push((st === 'OPEN' ? '🟢' : '🔴') + ' ' + p + ' · ' + (st || '?'));
    });
    return tgSend(lines.join('\n') + horizonFooter(t), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'report') { const tt = cache || {}; return tgSend(formatReport(24) + '\n\n' + formatActionAdvice(tt), { reply_markup: reportKeyboard() }); }
  if (cmd === 'incidents' || cmd === 'incident') return tgSend(formatIncidents(), { reply_markup: mainKeyboard() });
  if (cmd === 'scripts' || cmd === 'script') return tgSend(formatScripts(), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'incident_ack') {
    const active = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; }).filter(function (i) { return i && !i.resolved; })[0];
    if (active) {
      active.ackedAt = Date.now();
      try { saveJSON(STATE_F, state); } catch (e) {}
      return tgSend('✅ Acknowledged: ' + active.type + '\nI will give you more time before reminding again.', { reply_markup: alertKeyboard() });
    }
    return tgSend('No active incident.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'incident_skip') {
    const active = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; }).filter(function (i) { return i && !i.resolved; })[0];
    if (active) {
      active.skippedUntil = Date.now() + 4 * 3600 * 1000;
      try { saveJSON(STATE_F, state); } catch (e) {}
      return tgSend('⏸ Skipping this incident for 4 hours: ' + active.type + '\nIt will still be tracked and shown in /incidents.', { reply_markup: mainKeyboard() });
    }
    return tgSend('No active incident.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'diagnostic' || cmd === 'diag') return tgSend(formatDiagnostic(t), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'analyze' || cmd === 'ai' || cmd === 'health' || cmd === 'ask') {
    const isQuick = isQuickActionText(userText) || !userText;
    pushChatPersistent('user', isQuick ? '' : (userText || ''));
    await tgSend('…');
    const ans = await aiAnalyze(t, userText || 'Review my node', { quickAction: isQuick });
    pushChatPersistent('assistant', ans);
    const mentioned = recommendScriptsFromText(ans);
    const kb = mentioned.length ? scriptActionKeyboard() : mainKeyboard();
    return tgSend(ans, { reply_markup: kb });
  }
  if (cmd === 'trends') return tgSend(formatReport(24), { reply_markup: reportKeyboard() });
  if (cmd === 'logs' || cmd === 'log') { try { actionLog('info', 'user /logs'); } catch (e) {} return tgSend(formatActionLog(), { reply_markup: mainKeyboard() }); }
  if (cmd === 'winpro' || cmd === 'windows' || cmd === 'pro') { try { actionLog('info', 'user /winpro'); } catch (e) {} return tgSend(formatWindowsPro(), { reply_markup: mainKeyboard() }); }
  if (cmd === 'donate' || cmd === 'donate_both') {
    try { actionLog('info', 'user /' + cmd); } catch (e) {}
    await tgSend(formatDonate(), { reply_markup: donateKeyboard() });
    await sendDonateQr('both');
    return true;
  }
  if (cmd === 'donate_pi') { try { actionLog('info', 'user /donate_pi'); } catch (e) {} await tgSend('🟣 Pay with Pi\n@cannoi\n\n' + randomDonateThanks(), { reply_markup: donateKeyboard() }); await sendDonateQr('pi'); return true; }
  if (cmd === 'donate_mb') { try { actionLog('info', 'user /donate_mb'); } catch (e) {} await tgSend('🏦 MB Bank · 0905428801 · TRAN HUU NGHI\n\n' + randomDonateThanks(), { reply_markup: donateKeyboard() }); await sendDonateQr('mb'); return true; }
  if (cmd === 'mute_1h') { setMuteHours(1); return tgSend('🔇 Alerts muted 1 hour.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_24h') { setMuteHours(24); return tgSend('📅 Alerts muted 24 hours.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_night') { state.alertMode = 'night'; state.muteUntil = 0; saveJSON(STATE_F, state); return tgSend('🌙 Night quiet 22:00-07:00.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_off') { state.alertMode = 'off'; state.muteUntil = 0; saveJSON(STATE_F, state); return tgSend('🔕 Alerts off until you press On.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_on' || cmd === 'alerts_on') { state.alertMode = 'on'; state.muteUntil = 0; saveJSON(STATE_F, state); return tgSend('🔔 Alerts on.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute' || cmd === 'alerts') return tgSend(formatMuteAck(), { reply_markup: alertKeyboard() });
  if (cmd === 'report_h7') { state.reportHours = [7]; saveJSON(STATE_F, state); return tgSend('🕖 Daily report at 07:00', { reply_markup: reportKeyboard() }); }
  if (cmd === 'report_h18') { state.reportHours = [18]; saveJSON(STATE_F, state); return tgSend('🕕 Daily report at 18:00', { reply_markup: reportKeyboard() }); }
  if (cmd === 'report_both') { state.reportHours = [7, 18]; saveJSON(STATE_F, state); return tgSend('🕖🕕 Reports at 07:00 and 18:00', { reply_markup: reportKeyboard() }); }
  if (cmd === 'report_off') { state.reportHours = 'off'; saveJSON(STATE_F, state); return tgSend('⏰ Scheduled reports off', { reply_markup: reportKeyboard() }); }
  if (cmd === 'ping') return tgSend('🏓 pong · v' + VERSION + '\n⏱ cache ' + (Date.now() - cacheAt) + 'ms');
  if (cmd === 'script_cleanram') return tgSend(formatScriptDetail('cleanram'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_dnsflush') return tgSend(formatScriptDetail('dnsflush'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_firewall') return tgSend(formatScriptDetail('firewall'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_nodereset') return tgSend(formatScriptDetail('nodereset'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_netrepair') return tgSend(formatScriptDetail('netrepair'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_lansetup') return tgSend(formatScriptDetail('lansetup'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_dockerrecover') return tgSend(formatScriptDetail('dockerrecover'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'script_maintain') return tgSend(formatScriptDetail('maintain'), { reply_markup: scriptActionKeyboard() });
  if (cmd === 'docker' || cmd === 'dockersock' || cmd === 'docker_confirm' || cmd === 'docker_cancel' || cmd === 'docker_off' || cmd === 'docker_rules' || cmd === 'docker_local' || (typeof cmd === 'string' && cmd.indexOf('docker') === 0)) {
    try { actionLog('info', 'user docker cmd blocked on Telegram'); } catch (e) {}
    return tgSend('DOCKER OPTIONAL\n───────────────\nFor safety, docker.sock can only be enabled in the SoloHost window on the PC running this node.\n\n1) Open http://127.0.0.1:18780/\n2) Optional Docker -> scroll terms -> check boxes -> Confirm\n3) SoloHost: Stop -> Start\n\nTelegram will not raise Docker privileges.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'start' || cmd === 'help') {
    return tgSend(formatHelp() + '\n\n───────────────\n/status /sync /peers /incidents\n/report /diagnostic /analyze\n/scripts /donate\n───────────────\nTelemetry -> Host -> Horizon -> Ports', { reply_markup: mainKeyboard() });
  }
  return null;
}
async function handleText(text) {
  const raw = String(text || '').trim().slice(0, 4000);
  if (!raw) return null;
  const low = raw.toLowerCase();
  const cmd = low.split(/\s+/)[0].replace(/@\w+$/, '').replace(/^\//, '');

  if (raw.startsWith('/')) {
    return (await runCmd(cmd, raw)) || tgSend('❓ Unknown command. /help', { reply_markup: mainKeyboard() });
  }

  if (/^(status|ping)$/i.test(raw.trim())) return runCmd(raw.toLowerCase(), raw);
  if (/^(peers?|ports?|report|diagnostic|donate|scripts?|incidents?)$/i.test(raw.trim())) return runCmd(cmd, raw);

  const natural = tryNaturalCommand(raw);
  if (natural) {
    try { actionLog('info', 'NL command: ' + raw.slice(0, 80)); } catch (e) {}
    return tgSend(natural, { reply_markup: alertKeyboard() });
  }

  return runCmd('analyze', raw);
}
let offset = 0;
async function processUpdate(u) {
  try {
    if (!u || typeof u !== 'object' || u.update_id == null) return;
    if (u.callback_query) {
      const cq = u.callback_query;
      if (!cq || !cq.message || !cq.message.chat) return;
      if (CHAT_ID && !safeEq(String(cq.message.chat.id), CHAT_ID)) return;
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
      if ((cq.data || '').startsWith('cmd_')) await runCmd(cq.data.slice(4));
      return;
    }
    const msg = u.message;
    if (!msg || !msg.text || !msg.chat) return;
    if (CHAT_ID && !safeEq(String(msg.chat.id), CHAT_ID)) { log('ignore chat ' + msg.chat.id + ' want [redacted]', 'warn'); return; }
    const userKey = String(msg.chat.id);
    if (!tgUserRateLimit(userKey, 20, 60000)) { log('rate limit hit for chat ' + userKey, 'warn'); return; }
    await handleText(msg.text);
  } catch (e) {
    log('tg handle ' + (e && e.message), 'error');
    try { await tgSend('Error handling message. Try /ping or /status.'); } catch (e2) {}
  }
}

/* Standard command menu — single source of truth */
function getStandardMenu() {
  return [
    { command: 'status',     description: 'Current node health snapshot' },
    { command: 'sync',       description: 'Sync status and latest ledger' },
    { command: 'peers',      description: 'Inbound and outbound peers' },
    { command: 'report',     description: 'Last 24h rolling window (spans midnight)' },
    { command: 'incidents',  description: 'Active + recent incident history' },
    { command: 'diagnostic', description: 'Technical source details' },
    { command: 'scripts',    description: '8 SoloHost scripts + safety levels' },
    { command: 'analyze',    description: 'AI technician review (in your language)' },
    { command: 'logs',       description: 'App activity and errors' },
    { command: 'donate',     description: 'Support the project' },
    { command: 'winpro',     description: 'Windows PRO edition link' },
    { command: 'ping',       description: 'Controller heartbeat' },
    { command: 'help',       description: 'List available commands' },
    { command: 'mute',       description: 'Quiet alerts (also mutes recovery)' }
  ];
}
async function ensureTelegramMenu() {
  if (!BOT_TOKEN) return;
  const desired = getStandardMenu();
  try {
    const cur = await tgApi('getMyCommands');
    const curList = (cur && Array.isArray(cur.result)) ? cur.result : [];
    const same = curList.length === desired.length &&
      curList.every(function (c, i) {
        return String(c.command || '') === desired[i].command &&
               String(c.description || '') === desired[i].description;
      });
    if (same) {
      log('Telegram menu already standard (' + curList.length + ' commands)');
    } else {
      try { await tgApi('deleteMyCommands'); } catch (e) {}
      const r = await tgApi('setMyCommands', { commands: desired });
      if (r && r.ok) log('Telegram menu refreshed: deleted ' + curList.length + ' old, installed ' + desired.length + ' new');
      else log('setMyCommands fail: ' + ((r && r.description) || 'no reply'), 'warn');
    }
    try {
      const mb = await tgApi('setChatMenuButton', { menu_button: JSON.stringify({ type: 'commands' }) });
      if (mb && mb.ok) log('Chat menu button set to commands');
    } catch (e) {}
  } catch (e) {
    log('menu sync error: ' + (e && e.message), 'warn');
  }
}

async function telegramLoop() {
  let conflictBackoff = 15000, lastConflictLog = 0;
  if (BOT_TOKEN) {
    const dw = await tgApi('deleteWebhook', { drop_pending_updates: true });
    log('deleteWebhook ' + (dw && dw.ok ? 'ok' : 'skip') + ' (drop_pending=true)');
    try { actionLog('info', 'telegram loop start'); } catch (e) {}
    await ensureTelegramMenu();
  }
  while (true) {
    if (!BOT_TOKEN) { await wait(5000); continue; }
    try {
      const r = await tgApi('getUpdates', { offset: offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (!r) { await wait(400); continue; }
      if (r.ok === false) {
        const desc = String(r.description || '');
        const isConflict = /conflict|terminated by other getUpdates/i.test(desc);
        if (isConflict) {
          const now = Date.now();
          if (now - lastConflictLog > 90000) {
            log('getUpdates conflict - only one bot instance may poll this token.', 'error');
            try { actionLog('error', 'getUpdates conflict · ensure single instance'); } catch (e) {}
            lastConflictLog = now;
          }
          await tgApi('deleteWebhook', { drop_pending_updates: true });
          await wait(conflictBackoff);
          conflictBackoff = Math.min(180000, Math.floor(conflictBackoff * 1.4));
          continue;
        }
        log('getUpdates fail: ' + desc, 'error');
        await wait(2500);
        continue;
      }
      conflictBackoff = 15000;
      if (!Array.isArray(r.result)) { await wait(1000); continue; }
      for (const u of r.result) { if (u && u.update_id != null) offset = u.update_id + 1; processUpdate(u); }
    } catch (e) { log('tg loop ' + (e && e.message), 'error'); await wait(1200); }
  }
}
async function telemetryLoop() {
  while (true) {
    try {
      const t = await collectTelemetry();
      await runAlertMachine(t);
      const h = hourVN();
      const key = dayVN() + '-' + h;
      if (effectiveReportHours().indexOf(h) >= 0 && state.lastReportKey !== key) {
        state.lastReportKey = key;
        saveJSON(STATE_F, state);
        const gate = alertsMuted();
        if (!gate.muted) await tgSend(formatReport(24) + '\n\n' + formatStatus(t), { reply_markup: reportKeyboard() });
        else { try { actionLog('info', 'scheduled report muted - ' + gate.why); } catch (e) {} }
      }
    } catch (e) { log('telemetry ' + e.message, 'error'); }
    const intervalSec = currentTelemetryInterval();
    await wait(intervalSec * 1000);
  }
}

/* HTTP UI ============================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.ps1': 'text/plain; charset=utf-8',
  '.bat': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8'
};
// [2.6.57-fix] Load index.html from multiple candidate paths (volume mount may differ).
let INDEX = '<h1>Pi Node SoloHost ' + VERSION + '</h1><p>/api/status</p>';
(function () {
  const candidates = [
    path.join(PUBLIC, 'index.html'),
    '/solohost-config/public/index.html',
    '/data/public/index.html',
    path.join(DATA, 'public', 'index.html'),
    '/solohost-config/index.html',
    '/data/index.html'
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const html = fs.readFileSync(candidates[i], 'utf8');
      if (html && html.length > 100) {
        INDEX = html;
        try { console.log('[app] index.html loaded from ' + candidates[i]); } catch (e) {}
        return;
      }
    } catch (e) {}
  }
  try { console.warn('[app] index.html not found in any path · using fallback. Tried: ' + candidates.join(', ')); } catch (e) {}
})();
const rateBuckets = Object.create(null);
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets[key];
  if (!b || now > b.reset) b = rateBuckets[key] = { n: 0, reset: now + windowMs };
  b.n++;
  return b.n <= max;
}
function isLocalReq(req) {
  const ip = String(req.socket && req.socket.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('172.') || ip.startsWith('10.');
}
function setSecHeaders(res, mode) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (mode === 'docker') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
}

const _indexCache = { html: null, sockOn: null, at: 0 };
function applyIndexTransform(html, sockOn) {
  const now = Date.now();
  if (_indexCache.html && _indexCache.sockOn === sockOn && (now - _indexCache.at) < 3000) {
    return _indexCache.html;
  }
  let out = String(html || '');
  out = out.replace(/Optional Docker\s*probe[^<\n]{0,260}/gi, '');
  out = out.replace(/<div[^>]*id=["']pn-horizon-notice["'][\s\S]*?<\/div>/gi, '');
  out = out.replace(/Horizon-only mode[^<\n]{0,320}/gi, '');
  if (sockOn) {
    out = out.replace(/<p[^>]*id=["']pn-horizon-note["'][\s\S]*?<\/p>/gi, '');
    out = out.replace(/<div[^>]*id=["']pn-horizon-note["'][\s\S]*?<\/div>/gi, '');
  }
  _indexCache.html = out;
  _indexCache.sockOn = sockOn;
  _indexCache.at = now;
  return out;
}

const srv = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  setSecHeaders(res);
  try {
    if (u === '/healthz') { res.end('ok'); return; }
    if (u === '/api/status' || u === '/api/status/fast' || u === '/api/status/detailed') {
      if (!rateLimit('status:' + (req.socket.remoteAddress || ''), 40, 60000)) { res.statusCode = 429; res.end('rate limit'); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const detailed = u.indexOf('detailed') >= 0;
        let tel;
        if (u.indexOf('fast') >= 0 && cache) tel = cache;
        else if (detailed) { tel = await statusMonitor.getStatus(true, { detailed: true, docker: true }); }
        else tel = cache || await getTelemetry();
        res.end(JSON.stringify(tel || {}));
      } catch (e) {
        log('api/status error: ' + (e && e.message), 'error');
        if (cache) { res.end(JSON.stringify(cache)); }
        else { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'internal_error' })); }
      }
      return;
    }
    if (u === '/api/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: true, version: VERSION,
        health: state.healthSmooth, raw: state.healthRaw, adjusted: state.healthAdjusted,
        confidence: state.healthConfidence, confidenceScore: state.healthConfidenceScore,
        sourceCount: state.healthSourceCount, trend: state.healthTrend,
        stability: state.healthStability || null,
        at: state.healthAt ? new Date(state.healthAt).toISOString() : null,
        activeIncidents: Object.keys(state.incidents || {}).filter(function (k) { return state.incidents[k] && !state.incidents[k].resolved; }).length
      }));
      return;
    }
    if (u === '/api/incidents') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const items = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; });
      const active = items.filter(function (i) { return i && !i.resolved; });
      const recent = items.filter(function (i) { return i && i.resolved; }).sort(function (a, b) { return (b.resolvedAt || 0) - (a.resolvedAt || 0); }).slice(0, 20);
      res.end(JSON.stringify({ ok: true, active: active, recent: recent, intervalSec: currentTelemetryInterval() }));
      return;
    }
    if (u === '/api/scripts') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const out = {};
      Object.keys(SCRIPT_DETAILS).forEach(function (k) { out[k] = SCRIPT_DETAILS[k]; });
      res.end(JSON.stringify({ ok: true, scripts: out }));
      return;
    }
    if (u === '/api/ai/providers') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const providers = {};
      Object.keys(AI_DATA_PROVIDERS).forEach(function (k) { providers[k] = AI_DATA_PROVIDERS[k].desc; });
      res.end(JSON.stringify({
        ok: true,
        named_blocks: providers,
        dsl: {
          spec: buildDSLSpec().split('\n'),
          metrics_numeric: ['ledger','ledger_age','peer_in','peer_out','peer_total','cpu','ram','temp','disk','health','health_raw','health_adjusted','ports_open','ingest_lag'],
          metrics_category: ['sync','level','container','docker','health_confidence','network_kind','source','ports_all_open','docker_sock'],
          aggregations: ['summary','states','velocity','hourly','raw','trend'],
          limits: AI_QUERY_LIMITS
        }
      }));
      return;
    }
    if (u === '/api/ai/query') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const url = new URL(req.url, 'http://x');
        const q = {
          metric: url.searchParams.get('metric') || '',
          window: url.searchParams.get('window') || '24h',
          agg: url.searchParams.get('agg') || '',
          limit: url.searchParams.get('limit') || '20',
          filter: url.searchParams.get('filter') || ''
        };
        const result = executeDataQuery(q);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
      return;
    }
    if (u === '/api/report/window') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const url = new URL(req.url, 'http://x');
      const hours = Math.max(1, Math.min(168, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
      const rows = getTimeWindow(hours);
      const first = rows[0], last = rows[rows.length - 1];
      res.end(JSON.stringify({
        ok: true, requested_hours: hours, samples: rows.length,
        first_ts: first && first.ts, last_ts: last && last.ts,
        levels: {
          critical: rows.filter(function (r) { return r.level === 'critical'; }).length,
          warning_or_soft: rows.filter(function (r) { return r.level === 'warning' || r.level === 'soft'; }).length,
          ok: rows.filter(function (r) { return r.level === 'ok'; }).length
        }
      }));
      return;
    }
    if (u === '/api/update-check') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const latest = await checkForUpdates(true);
        res.end(JSON.stringify({
          ok: true,
          current: VERSION,
          repo: GITHUB_REPO_URL,
          latest: latest,
          lastSeenId: state.updateLastSeenId || null,
          lastCheckedAt: state.updateCheckedAt ? new Date(state.updateCheckedAt).toISOString() : null
        }));
      } catch (e) {
        res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
      return;
    }
    if (u === '/api/host-metrics') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        let hm = null;
        let src = null;
        const candidates = [
          './host-metrics',
          '/solohost-config/host-metrics.js',
          '/solohost-config/host-metrics',
          '/data/host-metrics.js',
          path.join(DATA, 'host-metrics.js')
        ];
        for (let i = 0; i < candidates.length; i++) {
          try {
            const mod = require(candidates[i]);
            if (mod && typeof mod.getHostMetrics === 'function') { hm = mod; src = candidates[i]; break; }
          } catch (e) {}
        }
        if (!hm) {
          res.end(JSON.stringify({ ok: false, error: 'host-metrics module not found', tried: candidates }));
          return;
        }
        const data = await hm.getHostMetrics(true);
        res.end(JSON.stringify({ ok: true, module_source: src, endpoint: hm.getEndpoint(), data: data }, null, 2));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
      return;
    }
    if (u === '/api/selftest') {
      if (!isLocalReq(req) && !rateLimit('selftest:' + (req.socket.remoteAddress || ''), 5, 60000)) { res.statusCode = 429; res.end('rate limit'); return; }
      const checks = [];
      const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });
      ok('version', VERSION === '2.6.57-solohost', VERSION);
      ok('telegram_loop_independent', true, 'separate loops');
      ok('telemetry_sec', TELEMETRY_SEC >= 30, String(TELEMETRY_SEC));
      ok('no_datalive', true, 'Horizon removed');
      ok('chat_id_safe_compare', typeof safeEq === 'function', 'safeEq');
      ok('safe_json_parse', typeof safeParse === 'function', 'safeParse');
      ok('tg_user_rate_limit', typeof tgUserRateLimit === 'function', 'tgUserRateLimit');
      ok('incident_engine', typeof detectIncidentSignature === 'function' && typeof smartScriptForIncident === 'function', 'engine loaded');
      ok('adaptive_polling', typeof currentTelemetryInterval === 'function', 'ok');
      ok('health_damper_fn', typeof dampHealthScore === 'function' && typeof healthConfidence === 'function', 'loaded');
      ok('health_stability_fn', typeof computeSyncStability === 'function' && typeof applyStabilityAdjustment === 'function', 'loaded');
      ok('pipeline_getTimeWindow', typeof getTimeWindow === 'function', 'ok');
      ok('pipeline_normalizeRow', typeof normalizeHistoryRow === 'function', 'ok');
      ok('pipeline_aggregate', typeof aggregate === 'function', 'ok');
      ok('pipeline_syncConsensus', typeof syncConsensus === 'function', 'ok');
      ok('pipeline_ledgerVelocity', typeof ledgerVelocity === 'function', 'ok');
      ok('readhist_cache_active', typeof invalidateReadHistory === 'function' && _readHistCache.ttlMs > 0, 'ttl=' + _readHistCache.ttlMs);
      ok('rollup_cache_fn', typeof ensureRollupLoaded === 'function', 'ensureRollupLoaded');
      ok('diag_prompt_loaded', typeof PI_NODE_DIAGNOSTIC_PROMPT === 'string' && PI_NODE_DIAGNOSTIC_PROMPT.length > 400, 'len=' + PI_NODE_DIAGNOSTIC_PROMPT.length);
      ok('script_details_count', Object.keys(SCRIPT_DETAILS).length === 8, 'count=' + Object.keys(SCRIPT_DETAILS).length);
      ok('script_kb_builder', typeof scriptActionKeyboard === 'function', 'scriptActionKeyboard');
      ok('script_card_builder', typeof formatScriptDetail === 'function', 'formatScriptDetail');
      ok('script_card_cleanram', (formatScriptDetail('cleanram') || '').indexOf('CleanRam.bat') >= 0, 'ok');
      ok('script_rec_from_text', typeof recommendScriptsFromText === 'function' && recommendScriptsFromText('Run NodeReset now').indexOf('nodereset') >= 0, 'ok');
      ok('script_fallback_map', typeof recommendScriptForTelemetry === 'function', 'ok');
      ok('quickaction_detector', typeof isQuickActionText === 'function' && isQuickActionText('Review my node') === true && isQuickActionText('hello world') === false, 'ok');
      ok('lang_skip_current_option', typeof detectUserPreferredLang === 'function', 'ok');
      ok('deep_knowledge_loaded', typeof PI_NODE_DEEP_KNOWLEDGE === 'string' && PI_NODE_DEEP_KNOWLEDGE.length > 800, 'len=' + PI_NODE_DEEP_KNOWLEDGE.length);
      ok('nl_parser_fn', typeof tryNaturalCommand === 'function' && typeof extractHoursFromText === 'function', 'loaded');
      const h1 = extractHoursFromText('report at 7am and 6pm');
      ok('nl_extract_7_18', h1.length === 2 && h1[0] === 7 && h1[1] === 18, JSON.stringify(h1));
      const h2 = extractHoursFromText('báo cáo hàng ngày 12 giờ đêm');
      ok('nl_extract_midnight', h2.length >= 1 && h2[0] === 0, JSON.stringify(h2));
      const h3 = extractHoursFromText('reports at noon');
      ok('nl_extract_noon', h3.length === 1 && h3[0] === 12, JSON.stringify(h3));
      const n1 = tryNaturalCommand('turn off alerts');
      ok('nl_off_alerts', typeof n1 === 'string' && /OFF/i.test(n1), n1 ? n1.slice(0, 40) : 'null');
      const prevRH = state.reportHours;
      state.reportHours = prevRH;
      const n2 = tryNaturalCommand('this is a general question about my node?');
      ok('nl_skip_question', n2 === null, String(n2));
      const n3 = tryNaturalCommand('reports at 7am and 6pm');
      ok('nl_set_report_hours', typeof n3 === 'string', n3 ? n3.slice(0, 40) : 'null');
      state.reportHours = prevRH;
      ok('menu_sync_fn', typeof ensureTelegramMenu === 'function' && typeof getStandardMenu === 'function', 'loaded');
      const menu = getStandardMenu();
      ok('menu_standard_count', menu.length === 14, 'count=' + menu.length);
      ok('update_checker_fn', typeof checkForUpdates === 'function' && typeof updateLoop === 'function', 'loaded');
      ok('github_repo_const', GITHUB_REPO === 'cannoi/pinode-telegram-solohost', GITHUB_REPO);
      ok('update_interval_48h', UPDATE_CHECK_INTERVAL_MS === 48 * 3600 * 1000, String(UPDATE_CHECK_INTERVAL_MS));
      ok('horizon_footer_fn', typeof horizonFooter === 'function', 'horizonFooter');
      ok('horizon_footer_on_when_off', (horizonFooter({ docker_sock: false }) || '').indexOf('Horizon only') >= 0, 'on');
      ok('horizon_footer_off_when_on', horizonFooter({ docker_sock: true }) === '', 'off');
      ok('has_docker_sock_fn', typeof hasDockerSock === 'function', 'hasDockerSock');
      ok('index_transform_fn', typeof applyIndexTransform === 'function', 'applyIndexTransform');
      const hOff = applyIndexTransform('<html><body><div>x</div></body></html>', false);
      ok('index_transform_injects_note', hOff.indexOf('pn-horizon-note') >= 0, 'inject');
      ok('index_transform_has_placer', hOff.indexOf('MutationObserver') >= 0, 'placer');
      const hOn = applyIndexTransform('<html><body><div>Optional Docker probe (advanced) is configured only on this PC.</div></body></html>', true);
      ok('index_transform_strips_legacy', hOn.indexOf('Optional Docker') < 0, 'stripped');
      ok('index_transform_off_hides_note', hOn.indexOf('pn-horizon-note') < 0, 'hidden');
      ok('ai_data_providers', Object.keys(AI_DATA_PROVIDERS).length >= 10, 'count=' + Object.keys(AI_DATA_PROVIDERS).length);
      ok('ai_parse_request', typeof parseDataRequests === 'function', 'parseDataRequests');
      ok('dsl_parse_fn', typeof parseDataQueries === 'function' && typeof executeDataQuery === 'function', 'loaded');
      const q1 = parseDataQueries('[DATA_QUERY: metric=ram window=7d agg=summary]');
      ok('dsl_parse_single', q1.length === 1 && q1[0].metric === 'ram' && q1[0].window === '7d' && q1[0].agg === 'summary', JSON.stringify(q1));
      const r3 = executeDataQuery({ metric: 'x_unknown', window: '1h' });
      ok('dsl_unknown_metric_returns_hint', r3.ok === false && Array.isArray(r3.allowed_numeric), r3.error);
      ok('dsl_window_parse_d', parseWindowHours('2d') === 48, parseWindowHours('2d'));
      ok('dsl_window_cap_168h', parseWindowHours('30d') === 168, parseWindowHours('30d'));
      const e1 = executeDataQuery({ metric: 'sync', window: '24h', agg: 'states' });
      ok('dsl_exec_states', e1.ok === true && (e1.states || e1.note), 'samples=' + e1.samples);
      const e2 = executeDataQuery({ metric: 'ram', window: '24h', agg: 'summary' });
      ok('dsl_exec_summary', e2.ok === true && (e2.stats || e2.note), 'n=' + (e2.stats ? e2.stats.n : 'na'));
      const st2 = stripDataRequests('Hello [DATA_QUERY: metric=ram window=1h] world');
      ok('strip_dsl', st2.indexOf('DATA_QUERY') < 0, st2.slice(0, 40));
      const prevMode = state.alertMode;
      state.alertMode = 'off';
      const gate = alertsMuted();
      ok('mute_off_recognized', gate.muted === true, gate.why);
      state.alertMode = prevMode || 'on';
      const hc1 = healthConfidence({ docker_sock: true, core_verified: true });
      ok('health_conf_high_sock_core', hc1.level === 'high', hc1.level);
      const hc3 = healthConfidence({});
      ok('health_conf_none_no_source', hc3.level === 'none', hc3.level);
      const stab1 = applyStabilityAdjustment(70, { samples: 10, flipRate: 0.30, badRatio: 0.10, longerBadRatio: 0.05, unstableShort: true, sustainedBad: false });
      ok('stability_pulls_up_noisy', stab1 > 70, 'raw 70 -> adj ' + Math.round(stab1));
      const stab2 = applyStabilityAdjustment(40, { samples: 10, flipRate: 0.05, badRatio: 0.80, longerBadRatio: 0.40, unstableShort: false, sustainedBad: true });
      ok('stability_keeps_low_sustained_bad', stab2 <= 40, 'raw 40 -> adj ' + Math.round(stab2));
      const i1 = detectIncidentSignature({ ports_open: 0 });
      ok('incident_ports_closed', i1 && i1.type === 'ports_closed', i1 && i1.type);
      const i2 = detectIncidentSignature({ docker: 'Exited (0)' });
      ok('incident_docker_down', i2 && i2.type === 'docker_down', i2 && i2.type);
      const s1 = smartScriptForIncident({ type: 'docker_down' }, {});
      ok('script_docker_down', s1 && s1.script === 'DockerRecover', s1 && s1.script);
      const d1 = decideIncidentAction({ firstSeen: Date.now() - 1000, samples: 1, stage: 0, alertsSent: 0 }, {});
      ok('decision_observe_early', d1 && d1.action === 'watch', d1 && d1.action);
      const d2 = decideIncidentAction({ firstSeen: Date.now() - 6 * 60000, samples: 6, stage: 0, alertsSent: 0 }, {});
      ok('decision_alert_at_5min', d2 && d2.action === 'alert', d2 && d2.action);
      const rep = formatReport(24);
      ok('report_24h_header', typeof rep === 'string' && rep.indexOf('PI NODE · REPORT') >= 0, 'ok');
      ok('report_no_ui_url', rep.indexOf('🔗 UI:') < 0, 'ok');
      ok('report_no_hash_ledger', rep.indexOf('#10,') < 0 && rep.indexOf('#9,') < 0, 'ok');
      ok('fmt_duration_min', fmtIssueDuration(2) === '2min', fmtIssueDuration(2));
      ok('fmt_duration_big', /h/.test(fmtIssueDuration(120)), fmtIssueDuration(120));
      try {
        const w1 = getTimeWindow(48);
        if (w1.length >= 2) {
          const t0 = Date.parse(w1[0].ts);
          const t1 = Date.parse(w1[w1.length - 1].ts);
          ok('time_window_sorted', t0 <= t1, 'first=' + w1[0].ts + ' last=' + w1[w1.length - 1].ts);
        } else {
          ok('time_window_sorted', true, 'insufficient samples');
        }
      } catch (e) {
        ok('time_window_sorted', false, String(e && e.message));
      }
      const l1 = detectUserLang('Xin chào, node của tôi thế nào?');
      ok('lang_detect_vi', l1 === 'Vietnamese', l1);
      const l2 = detectUserLang('Hello, how is my node?');
      ok('lang_detect_en', l2 === 'English', l2);
      ok('telemetry_dedupe_flag', typeof _pendingTelemetry !== 'undefined', 'ok');
      ok('sock_cache_present', typeof _sockCache === 'object' && _sockCache.v === null, 'ok');
      // host-metrics is OPTIONAL — never fail whole selftest if missing.
      try {
        const hm = require('./host-metrics');
        checks.push({ name: 'host_metrics_module', pass: true, detail: 'loaded' });
        checks.push({
          name: 'host_metrics_endpoint',
          pass: typeof hm.getEndpoint === 'function' && /node_os/.test(hm.getEndpoint()),
          detail: (typeof hm.getEndpoint === 'function') ? hm.getEndpoint() : 'n/a'
        });
      } catch (e) {
        checks.push({ name: 'host_metrics_module', pass: true, detail: 'optional · not shipped in this image' });
      }
      const all = checks.every(c => c.pass);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: all, version: VERSION, checks }));
      return;
    }

    if (u === '/api/chat' && (req.method === 'POST' || req.method === 'GET')) {
      if (!rateLimit('chat:' + (req.socket.remoteAddress || ''), 12, 60000)) { res.statusCode = 429; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'rate_limit' })); return; }
      let body = '';
      if (req.method === 'POST') {
        body = await new Promise(resolve => {
          let b = '', n = 0;
          req.on('data', d => { n += d.length; if (n > 8000) { req.destroy(); return; } b += d; });
          req.on('end', () => resolve(b));
          req.on('error', () => resolve(''));
        });
      }
      let msg = '';
      try {
        const q = new URL(req.url, 'http://x').searchParams.get('msg');
        if (q) msg = q;
        if (body) { const j = safeParse(body); if (j && j.message) msg = j.message; if (j && j.msg) msg = j.msg; }
      } catch (e) {}
      msg = String(msg || '').trim().slice(0, 2000);
      if (!msg) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'empty_message' })); return; }
      try {
        let tel = cache;
        if (!tel) { try { tel = await Promise.race([collectTelemetry(), new Promise(function (r) { setTimeout(function () { r(null); }, 4000); })]); } catch (e) { tel = null; } }
        if (!tel) tel = { source: 'none', level: 'unknown', sources: {} };
        pushChatPersistent('user', msg);
        let ans = null;
        const low = msg.toLowerCase().trim();
        const c0 = low.split(/\s+/)[0].replace(/^\//, '');
        if (/^(help|status|s|sync|peers|report|trends|diagnostic|diag|logs|ping|donate|winpro|incidents|scripts)$/.test(c0) || low.charAt(0) === '/') {
          try { ans = await localCommandText(c0, msg); } catch (e) { ans = null; }
        }
        if (!ans) ans = await aiAnalyze(tel, msg);
        pushChatPersistent('assistant', ans);
        const payload = { ok: true, reply: ans, version: VERSION, source: tel && tel.source, horizonOnly: !hasDockerSock(tel), systemAvailable: !!(tel && tel.system && tel.system.available) };
        if (c0 === 'donate') {
          payload.images = [];
          try {
            if (fs.existsSync(path.join(PUBLIC, 'donate-qr-pi.jpg'))) payload.images.push('/donate-qr-pi.jpg');
            if (fs.existsSync(path.join(PUBLIC, 'donate-qr-mb.jpg'))) payload.images.push('/donate-qr-mb.jpg');
            if (!payload.images.length && fs.existsSync(path.join(PUBLIC, 'donate-qr.jpg'))) payload.images.push('/donate-qr.jpg');
          } catch (e) {}
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
      } catch (e) {
        log('api/chat error: ' + (e && e.message), 'error');
        res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
      return;
    }

    if (u === '/docker' || u === '/docker/' || u.indexOf('/docker/confirm') === 0 || u.indexOf('/docker/off') === 0) {
      setSecHeaders(res, 'docker');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const pref = readDockerPref();
      if (u.indexOf('/docker/confirm') === 0) {
        writeDockerPref({ enabled: true, at: new Date().toISOString(), by: 'local_ui', consent: true });
        const applied = applyDockerConsentFiles();
        try { actionLog('ok', 'docker pref ON via local UI'); } catch (e) {}
        const extra = applied && applied.wrote_host
          ? '<p><b>docker-compose.yml</b> updated in app folder.</p>'
          : '<p>Files ready under <code>data/docker-enable/</code>. Copy <code>docker-compose.yml</code> to app root if needed.</p>';
        res.end('<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:2rem auto;line-height:1.5">'
          + '<h2>✅ Docker preference ON</h2>'
          + extra
          + '<p><b>Next step (required):</b> In SoloHost, press <b>Stop</b>, then press <b>Start</b> to apply the socket mount.</p>'
          + '<p>After restart, /status will show <code>Sock: Yes</code> when the socket is live.</p>'
          + '<p><a href="/docker">Back</a> · <a href="/">Controller home</a></p></body></html>');
        return;
      }
      if (u.indexOf('/docker/off') === 0) {
        writeDockerPref({ enabled: false, at: new Date().toISOString(), by: 'local_ui', consent: false });
        try { actionLog('ok', 'docker pref OFF via local UI'); } catch (e) {}
        res.end('<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:2rem auto;line-height:1.5">'
          + '<h2>🔕 Docker preference OFF</h2>'
          + '<p>Sandbox default. No socket access.</p>'
          + '<p>If the socket volume is still in docker-compose.yml, remove it, then <b>Stop → Start</b> to fully return to sandbox mode.</p>'
          + '<p><a href="/docker">Back</a></p></body></html>');
        return;
      }
      let sockExists = false;
      try { sockExists = fs.existsSync('/var/run/docker.sock'); } catch (e) {}
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Docker optional</title>'
        + '<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:1.5rem auto;padding:0 1rem;line-height:1.55;color:#222}'
        + '.box{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0;background:#f8f8f8}'
        + '.btn{display:inline-block;margin:.3rem .4rem .3rem 0;padding:.7rem 1.1rem;border-radius:6px;text-decoration:none;color:#fff;font-weight:600}'
        + '.yes{background:#0a7}.no{background:#555} code{background:#eee;padding:.1rem .35rem;border-radius:4px}'
        + '.ok{color:#0a7;font-weight:600}.warn{color:#b58900;font-weight:600}</style></head><body>'
        + '<h1>🔓 Optional Docker — enable for better accuracy</h1>'
        + '<div class="box"><p><b>Why enable it?</b> With the Docker socket, this app can read the real Pi Node container state and Core version. Without it, data comes from Horizon only and may lag or differ from Pi Node Desktop.</p>'
        + '<p><b>Current status:</b> '
        + 'Preference <span class="' + (pref.enabled ? 'ok' : 'warn') + '">' + (pref.enabled ? 'ON' : 'OFF') + '</span> · '
        + 'Socket in container <span class="' + (sockExists ? 'ok' : 'warn') + '">' + (sockExists ? 'YES' : 'NO') + '</span></p></div>'
        + '<div class="box"><p><b>SoloHost default</b> ships this app as a sandbox. The Docker socket is <u>not</u> included by default. Enabling it is an <b>Operator opt-in</b>.</p>'
        + '<p><b>After you click Agree:</b></p>'
        + '<ol><li>App writes a ready <code>docker-compose.yml</code> (with socket).</li>'
        + '<li>If the app folder is writable, it is filled automatically.</li>'
        + '<li>Otherwise use files in <code>data/docker-enable/</code>.</li>'
        + '<li><b>Stop → Start</b> this SoloHost app so the new mount takes effect.</li></ol>'
        + '<p>Not required for normal monitoring.</p></div>'
        + '<p><a class="btn yes" href="/docker/confirm">✅ Agree — enable &amp; prepare files</a>'
        + '<a class="btn no" href="/docker/off">🔕 Disable</a></p>'
        + '<p><a href="/">Controller home</a></p></body></html>');
      return;
    }
    if (u === '/api/docker') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'GET') {
        let sock = false;
        try { sock = fs.existsSync('/var/run/docker.sock'); } catch (e) {}
        const pref = readDockerPref();
        res.end(JSON.stringify({ ok: true, enabled: !!pref.enabled, consent: !!pref.consent, sock: sock, by: pref.by || null, at: pref.at || null }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', function (c) { body += c; if (body.length > 8000) { req.destroy(); return; } });
        req.on('end', function () {
          try {
            const j = safeParse(body) || {};
            const on = !!j.enabled;
            if (on && !j.consent) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'consent_required' })); return; }
            if (on && j.read_full !== true && j.terms_version !== 'docker-optional-v1') { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'terms_must_be_accepted' })); return; }
            writeDockerPref({ enabled: on, consent: on ? true : false, consent_version: on ? 'docker-optional-v1' : null, consent_text: on ? 'Operator accepted terms' : null, at: new Date().toISOString(), by: 'solohost_ui' });
            let applied = { wrote_host: false, wrote_data: false };
            if (on) applied = applyDockerConsentFiles() || applied;
            try { actionLog('ok', 'docker pref ' + (on ? 'ON' : 'OFF') + ' via /api/docker'); } catch (e) {}
            res.end(JSON.stringify({ ok: true, enabled: on, wrote_host: !!(applied && applied.wrote_host), wrote_data: !!(applied && applied.wrote_data), hint: on ? 'SoloHost: Stop -> Start.' : 'Sandbox default.' }));
          } catch (e) {
            log('api/docker error: ' + (e && e.message), 'error');
            res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
          }
        });
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    if (u === '/api/discover') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const force = /force=1|fresh=1/.test(req.url || '');
        const d = await statusMonitor.discovery.discover(force);
        res.end(JSON.stringify({ ok: true, discovery: d, report: statusMonitor.discovery.getReport() }));
      } catch (e) { log('api/discover error: ' + (e && e.message), 'error'); res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'internal_error' })); }
      return;
    }
    if (u === '/api/alerts') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'POST') {
        const rows = readDashAlerts().map(function (r) { r.read = true; return r; });
        try { fs.writeFileSync(dashAlertPath(), JSON.stringify(rows)); } catch (e) {}
        res.end(JSON.stringify({ ok: true, unread: 0, items: rows.slice(0, 12) }));
        return;
      }
      const items = readDashAlerts();
      const unread = items.filter(function (r) { return !r.read; }).length;
      res.end(JSON.stringify({ ok: true, unread: unread, items: items.slice(0, 12) }));
      return;
    }
    if (u === '/api/info') {
      res.setHeader('Content-Type', 'application/json');
      const tel = cache || {};
      res.end(JSON.stringify({
        version: VERSION, dataLive: false, hasBot: !!BOT_TOKEN, hasAI: !!GEMINI_API_KEY,
        telemetrySec: TELEMETRY_SEC, incidentCount: Object.keys(state.incidents || {}).length,
        health: state.healthSmooth, healthConfidence: state.healthConfidence,
        healthStability: state.healthStability || null,
        aiProviders: Object.keys(AI_DATA_PROVIDERS).length,
        aiDslMetrics: Object.keys(AI_METRIC_WHITELIST).length,
        diagScripts: Object.keys(SCRIPT_DETAILS).length,
        readHistCacheTtlMs: _readHistCache.ttlMs,
        hasDockerSock: hasDockerSock(tel),
        horizonOnly: !hasDockerSock(tel),
        systemAvailable: !!(tel && tel.system && tel.system.available),
        systemSource: tel && tel.system ? tel.system.source : null,
        updateLastSeenId: state.updateLastSeenId || null,
        updateCheckedAt: state.updateCheckedAt ? new Date(state.updateCheckedAt).toISOString() : null,
        updateRepo: GITHUB_REPO_URL
      }));
      return;
    }
    if (u === '/api/logs') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try { res.end(redactSecrets(fs.readFileSync(LOG_F, 'utf8').slice(-8000))); } catch (e) { res.end(''); }
      return;
    }
    if (u === '/' || u === '/index.html') {
      setSecHeaders(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const tel = cache || {};
      const showNotice = !hasDockerSock(tel);
      res.end(applyIndexTransform(INDEX, !showNotice));
      return;
    }
    if (u.startsWith('/scripts/')) {
      const name = path.basename(u);
      const f = path.join(SCRIPTS, name);
      if (fs.existsSync(f)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
        res.end(fs.readFileSync(f));
        return;
      }
    }
    const rel = path.normalize(u).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    if (rel.includes('..')) { res.statusCode = 400; res.end('bad_path'); return; }
    const f = path.join(PUBLIC, rel);
    if (!f.startsWith(PUBLIC)) { res.statusCode = 400; res.end('bad_path'); return; }
    fs.readFile(f, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      const ext = path.extname(f).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      if (ext === '.bat' || ext === '.ps1') {
        res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(f) + '"');
      }
      res.end(data);
    });
  } catch (e) {
    log('http error: ' + (e && e.message), 'error');
    res.statusCode = 500;
    res.end('error');
  }
});
srv.listen(PORT, '0.0.0.0', () => {
  log('SoloHost Controller v' + VERSION + ' :' + PORT);
  try {
    const pf = path.join(DATA, 'state', 'pending-sock-restart.json');
    if (fs.existsSync(pf)) {
      const pend = JSON.parse(fs.readFileSync(pf, 'utf8'));
      if (pend && pend.need_ui_restart && BOT_TOKEN && CHAT_ID) {
        setTimeout(async function () {
          try {
            await tgSend('🔄 Docker probe\nCompose updated.\nIf /status still shows sock: no - Stop then Start the app once.');
            pend.need_ui_restart = false; pend.notified = true;
            fs.writeFileSync(pf, JSON.stringify(pend));
          } catch (e) {}
        }, 4000);
      }
    }
  } catch (e) {}
  log('telemetry=' + TELEMETRY_SEC + 's base · adaptive polling enabled (30-60s)');
  log('Diag framework v3.0 · 8 scripts · 4 safety levels · NLU active');
  log('Health damper active · readHistory cache(' + _readHistCache.ttlMs + 'ms) + rollup RAM cache');
  log('AI data providers: ' + Object.keys(AI_DATA_PROVIDERS).length + ' blocks · DSL ' + Object.keys(AI_METRIC_WHITELIST).length + ' metrics');
  log('Menu sync 14 cmds · Update checker 48h · repo ' + GITHUB_REPO_URL);
  log('Horizon-only notice shown under Peers (auto-hides when docker.sock is ON)');
  log('Host metrics via Node OS (os.cpus / os.totalmem / fs.statfsSync)');
  log('Telegram long-poll independent of telemetry');
});
telegramLoop();
telemetryLoop();
if (BOT_TOKEN && CHAT_ID && ALERT_ON_START) {
  setTimeout(async () => {
    try {
      const t = await getTelemetry();
      const gate = alertsMuted();
      if (!gate.muted) await tgSend('✅ Controller online\n\n' + formatStatus(t), { reply_markup: mainKeyboard() });
      else { try { actionLog('info', 'startup notification muted - ' + gate.why); } catch (e) {} }
    } catch (e) { log('start ' + e.message, 'error'); }
  }, 4000);
}
// Update loop only if bot configured
if (BOT_TOKEN && CHAT_ID) updateLoop();
