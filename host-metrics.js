'use strict';
/**
 * Host Metrics Reader (v2.6.57 — Node OS)
 *
 * Nguồn dữ liệu (native, không HTTP, không DataLive, không docker.sock):
 *   - CPU  : os.cpus() delta (idle vs total) → usage_percent
 *            os.loadavg() cung cấp thêm load[1m,5m,15m] (bonus)
 *   - RAM  : os.totalmem() / os.freemem()
 *   - Disk : fs.statfsSync("/")  → blocks/bfree/bavail
 *   - Uptime: os.uptime()
 *
 * Nguyên tắc:
 *   - Không fake/random/mock. Lỗi → available:false, giá trị = null.
 *   - Giá trị 0 là HỢP LỆ (0% CPU, 0% disk used, ...).
 *   - Cache nội bộ 10s để tránh spam os.cpus() delta quá nhanh.
 *   - Sample CPU đầu tiên cần delta 150ms; các lần sau dùng delta tự nhiên.
 *
 * Caveat: app chạy trong Linux container (SoloHost). os.* phản ánh
 * namespace của container/WSL2 VM, không phải Windows host trực tiếp.
 * os.uptime() vẫn là kernel uptime (chung với host), nên chính xác.
 */

const os = require('os');
const fs = require('fs');

const CACHE_TTL_MS = Math.max(2000, parseInt(process.env.HOST_METRICS_CACHE_MS || '10000', 10) || 10000);
const DISK_MOUNT = (process.env.HOST_METRICS_DISK_MOUNT || '/').trim() || '/';

const _cache = { at: 0, data: null, inflight: null };
let _lastCpuSample = null;

function _sampleCpu() {
  try {
    const cpus = os.cpus();
    if (!Array.isArray(cpus) || !cpus.length) return null;
    let idle = 0, total = 0;
    for (let i = 0; i < cpus.length; i++) {
      const t = (cpus[i] && cpus[i].times) || {};
      const u = Number(t.user) || 0;
      const n = Number(t.nice) || 0;
      const s = Number(t.sys) || 0;
      const id = Number(t.idle) || 0;
      const ir = Number(t.irq) || 0;
      idle += id;
      total += u + n + s + id + ir;
    }
    if (total <= 0) return null;
    return { idle, total, ts: Date.now() };
  } catch (e) { return null; }
}

async function _getCpuPercent() {
  let cur = _sampleCpu();
  if (!cur) return null;

  // First ever call: take a paired sample 150ms apart for a valid delta.
  if (!_lastCpuSample) {
    _lastCpuSample = cur;
    await new Promise(function (r) { setTimeout(r, 150); });
    cur = _sampleCpu();
    if (!cur) return null;
  }

  const dTotal = cur.total - _lastCpuSample.total;
  const dIdle = cur.idle - _lastCpuSample.idle;
  _lastCpuSample = cur;

  if (dTotal <= 0) return null;
  const usage = (1 - dIdle / dTotal) * 100;
  if (!isFinite(usage)) return null;
  // Clamp 0..100, round 1 decimal; 0 is valid.
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
}

function _getLoadAvg() {
  try {
    const la = os.loadavg();
    if (!Array.isArray(la) || la.length < 3) return null;
    const out = [];
    for (let i = 0; i < 3; i++) {
      const n = Number(la[i]);
      out.push(isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null);
    }
    if (out[0] == null && out[1] == null && out[2] == null) return null;
    return { '1m': out[0], '5m': out[1], '15m': out[2] };
  } catch (e) { return null; }
}

function _getMemory() {
  try {
    const total = Number(os.totalmem());
    const free = Number(os.freemem());
    if (!isFinite(total) || total <= 0) return null;
    if (!isFinite(free) || free < 0) return null;
    const used = total - free;
    const pct = used / total * 100;
    return {
      used_percent: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)),
      used_bytes: used,
      total_bytes: total,
      free_bytes: free
    };
  } catch (e) { return null; }
}

function _getDisk(mountPath) {
  mountPath = mountPath || DISK_MOUNT;
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(mountPath);
    if (!st) return null;
    const bsize = Number(st.bsize) || 0;
    const blocks = Number(st.blocks) || 0;
    const bfree = Number(st.bfree) || 0;
    const bavail = (st.bavail != null) ? Number(st.bavail) : bfree;
    const total = bsize * blocks;
    const freeAll = bsize * bfree;      // total free (incl. reserved)
    const freeAvail = bsize * bavail;   // available to non-root
    if (!isFinite(total) || total <= 0) return null;
    const used = total - freeAll;
    const usedPct = used / total * 100;
    return {
      drive: mountPath,
      used_percent: Math.max(0, Math.min(100, Math.round(usedPct * 10) / 10)),
      used_bytes: used,
      total_bytes: total,
      free_bytes: freeAvail,
      free_bytes_reserved: freeAll - freeAvail
    };
  } catch (e) { return null; }
}

function _getUptime() {
  try {
    const u = Number(os.uptime());
    if (!isFinite(u) || u < 0) return null;
    return u;
  } catch (e) { return null; }
}

function _getHostInfo() {
  try {
    return {
      hostname: os.hostname() || null,
      platform: os.platform() || null,
      arch: os.arch() || null,
      release: os.release() || null,
      cpu_count: Array.isArray(os.cpus()) ? os.cpus().length : null
    };
  } catch (e) { return null; }
}

async function getHostMetrics(forceFresh) {
  const now = Date.now();
  if (!forceFresh && _cache.data && (now - _cache.at) < CACHE_TTL_MS) {
    const c = Object.assign({}, _cache.data);
    c.age_seconds = Math.round((now - _cache.at) / 1000);
    c.from_cache = true;
    return c;
  }
  if (_cache.inflight) return _cache.inflight;

  _cache.inflight = (async function () {
    let result;
    try {
      const cpu_percent = await _getCpuPercent();
      const loadavg = _getLoadAvg();
      const memory = _getMemory();
      const disk = _getDisk(DISK_MOUNT);
      const uptime_seconds = _getUptime();
      const host_info = _getHostInfo();

      const anyData = (
        cpu_percent != null ||
        memory != null ||
        disk != null ||
        uptime_seconds != null
      );

      if (!anyData) {
        result = {
          available: false,
          source: 'node_os',
          error: 'no_metrics_available'
        };
      } else {
        result = {
          available: true,
          source: 'node_os',
          timestamp: new Date().toISOString(),
          cpu: {
            usage_percent: cpu_percent,
            loadavg: loadavg
          },
          memory: memory || {
            used_percent: null,
            used_bytes: null,
            total_bytes: null,
            free_bytes: null
          },
          disk: disk || {
            drive: DISK_MOUNT,
            used_percent: null,
            used_bytes: null,
            total_bytes: null,
            free_bytes: null
          },
          uptime_seconds: uptime_seconds,
          host_info: host_info
        };
      }
    } catch (e) {
      result = {
        available: false,
        source: 'node_os',
        error: String(e && e.message || 'error')
      };
    }
    result.timestamp = result.timestamp || new Date().toISOString();
    _cache.data = result;
    _cache.at = Date.now();
    _cache.inflight = null;
    return Object.assign({}, result, { age_seconds: 0, from_cache: false });
  })();

  return _cache.inflight;
}

function getEndpoint() { return 'node_os:os+fs'; }
function isHostMetricsDisabled() { return false; }

module.exports = {
  getHostMetrics,
  getEndpoint,
  isHostMetricsDisabled,
  // exported for tests / debug
  _getCpuPercent,
  _getMemory,
  _getDisk,
  _getUptime,
  _getLoadAvg
};
