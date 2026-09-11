'use strict';
/**
 * Host Metrics Reader (v2.6.57)
 * Đọc CPU/RAM/Disk/Uptime của Windows Host qua HTTP read-only từ DataLive/System Agent.
 * KHÔNG dùng Docker, KHÔNG đọc container, KHÔNG fake dữ liệu.
 *
 * Endpoint mặc định: http://host.docker.internal:18790/v1/status
 * Override: HOST_METRICS_URL env
 * Tắt hẳn:  HOST_METRICS_DISABLED=1
 */

const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://host.docker.internal:18790/v1/status';
const HOST_METRICS_URL = (process.env.HOST_METRICS_URL || DEFAULT_URL).trim();
const DISABLED = String(process.env.HOST_METRICS_DISABLED || '0').toLowerCase();
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.HOST_METRICS_TIMEOUT_MS || '2500', 10) || 2500);
const CACHE_TTL_MS = Math.max(5000, parseInt(process.env.HOST_METRICS_CACHE_MS || '25000', 10) || 25000);

const _cache = { at: 0, data: null, inflight: null };

function isDisabled() {
  return DISABLED === '1' || DISABLED === 'true' || DISABLED === 'yes' || DISABLED === 'on';
}

function httpGetJson(urlStr, timeoutMs) {
  return new Promise(function (resolve) {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'Accept': 'application/json', 'User-Agent': 'pinode-solohost-host-metrics' }
      }, function (res) {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { b += c; });
        res.on('end', function () {
          if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
          try { resolve(JSON.parse(b)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', function () { resolve(null); });
      req.on('timeout', function () { try { req.destroy(); } catch (e) {} resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}

function pickNum() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return null;
}
function pickStr() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v == null || v === '') continue;
    return String(v);
  }
  return null;
}
function firstObject() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const root = firstObject(raw.data, raw.payload, raw.status, raw.metrics, raw) || raw;
  const sys = firstObject(root.system, root.sys, root.host, root) || {};
  const cpuObj = firstObject(root.cpu, sys.cpu, root.cpu_info, null);
  const memObj = firstObject(root.memory, root.mem, root.ram_info, sys.memory, sys.mem, null);
  const diskObj = firstObject(root.disk, root.storage, root.disk_c, sys.disk, sys.storage, null);

  let cpu_percent = pickNum(
    typeof cpuObj === 'object' ? (cpuObj.usage_percent ?? cpuObj.usagePercent ?? cpuObj.percent ?? cpuObj.load_percent ?? cpuObj.load) : cpuObj,
    sys.cpu_percent, sys.cpuPercent, root.cpu_percent, root.cpuPercent, root.cpuUsage, root.cpu_usage
  );
  if (cpu_percent != null) cpu_percent = Math.max(0, Math.min(100, Math.round(cpu_percent * 10) / 10));

  const mem_total_bytes = memObj ? pickNum(memObj.total_bytes, memObj.totalBytes, memObj.total, memObj.total_mb != null ? memObj.total_mb * 1048576 : null) : null;
  const mem_free_bytes = memObj ? pickNum(memObj.free_bytes, memObj.freeBytes, memObj.free, memObj.free_mb != null ? memObj.free_mb * 1048576 : null) : null;
  let mem_used_bytes = memObj ? pickNum(memObj.used_bytes, memObj.usedBytes, memObj.used, memObj.used_mb != null ? memObj.used_mb * 1048576 : null) : null;
  let mem_used_percent = memObj ? pickNum(memObj.used_percent, memObj.usedPercent, memObj.percent, memObj.usage_percent, sys.memory_percent, sys.mem_percent, root.memory_percent, root.mem_percent) : pickNum(sys.memory_percent, sys.mem_percent, root.memory_percent, root.mem_percent);
  if (mem_used_bytes == null && mem_total_bytes != null && mem_free_bytes != null) mem_used_bytes = mem_total_bytes - mem_free_bytes;
  if (mem_used_percent == null && mem_used_bytes != null && mem_total_bytes && mem_total_bytes > 0) mem_used_percent = mem_used_bytes / mem_total_bytes * 100;
  if (mem_used_percent != null) mem_used_percent = Math.max(0, Math.min(100, Math.round(mem_used_percent * 10) / 10));

  let disk_drive = null, disk_used_percent = null, disk_total_bytes = null, disk_used_bytes = null, disk_free_bytes = null;
  let dObj = diskObj;
  if (dObj && !Array.isArray(dObj) && typeof dObj === 'object' &&
      !('used_percent' in dObj) && !('usedPercent' in dObj) && !('percent' in dObj) &&
      !('total_bytes' in dObj) && !('totalBytes' in dObj)) {
    const keys = Object.keys(dObj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (/^[A-Za-z]:?$/.test(k) || /system|primary|main|boot/i.test(k)) { dObj = dObj[k]; disk_drive = k; break; }
    }
    if (!dObj || typeof dObj !== 'object') dObj = null;
    if (!disk_drive && keys.length) { disk_drive = keys[0]; dObj = diskObj[keys[0]]; }
  }
  if (Array.isArray(diskObj) && diskObj.length) {
    dObj = diskObj[0];
    if (dObj && dObj.drive) disk_drive = String(dObj.drive);
  }
  if (dObj && typeof dObj === 'object') {
    disk_drive = disk_drive || pickStr(dObj.drive, dObj.mount, dObj.mount_point, dObj.name, dObj.path);
    disk_total_bytes = pickNum(dObj.total_bytes, dObj.totalBytes, dObj.total, dObj.total_gb != null ? dObj.total_gb * 1073741824 : null);
    disk_free_bytes = pickNum(dObj.free_bytes, dObj.freeBytes, dObj.free, dObj.free_gb != null ? dObj.free_gb * 1073741824 : null);
    disk_used_bytes = pickNum(dObj.used_bytes, dObj.usedBytes, dObj.used);
    disk_used_percent = pickNum(dObj.used_percent, dObj.usedPercent, dObj.percent, dObj.usage_percent);
  }
  if (disk_drive == null) disk_drive = pickStr(sys.disk_drive, root.disk_drive, root.diskDrive);
  if (disk_used_percent == null) disk_used_percent = pickNum(sys.disk_percent, root.disk_percent);
  if (disk_used_bytes == null && disk_total_bytes != null && disk_free_bytes != null) disk_used_bytes = disk_total_bytes - disk_free_bytes;
  if (disk_used_percent == null && disk_used_bytes != null && disk_total_bytes && disk_total_bytes > 0) disk_used_percent = disk_used_bytes / disk_total_bytes * 100;
  if (disk_used_percent != null) disk_used_percent = Math.max(0, Math.min(100, Math.round(disk_used_percent * 10) / 10));

  let uptime_seconds = pickNum(
    sys.uptime_seconds, sys.uptimeSeconds, sys.uptime,
    root.uptime_seconds, root.uptimeSeconds, root.uptime, root.boot_seconds
  );
  if (uptime_seconds != null && uptime_seconds < 0) uptime_seconds = null;

  if (cpu_percent == null && mem_used_percent == null && disk_used_percent == null && uptime_seconds == null) return null;

  return {
    available: true,
    source: 'windows_host',
    timestamp: new Date().toISOString(),
    cpu: { usage_percent: cpu_percent },
    memory: {
      used_percent: mem_used_percent,
      used_bytes: mem_used_bytes,
      total_bytes: mem_total_bytes,
      free_bytes: mem_free_bytes
    },
    disk: {
      drive: disk_drive || null,
      used_percent: disk_used_percent,
      used_bytes: disk_used_bytes,
      total_bytes: disk_total_bytes,
      free_bytes: disk_free_bytes
    },
    uptime_seconds: uptime_seconds
  };
}

async function fetchRaw() {
  const raw = await httpGetJson(HOST_METRICS_URL, TIMEOUT_MS);
  if (!raw) return null;
  return normalize(raw);
}

async function getHostMetrics(forceFresh) {
  if (isDisabled()) {
    return { available: false, source: 'windows_host', reason: 'disabled' };
  }
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
      const parsed = await fetchRaw();
      if (parsed) {
        result = parsed;
      } else {
        result = { available: false, source: 'windows_host', error: 'unreachable_or_invalid', url: HOST_METRICS_URL };
      }
    } catch (e) {
      result = { available: false, source: 'windows_host', error: String(e && e.message || 'error') };
    }
    result.timestamp = result.timestamp || new Date().toISOString();
    _cache.data = result;
    _cache.at = Date.now();
    _cache.inflight = null;
    return Object.assign({}, result, { age_seconds: 0, from_cache: false });
  })();
  return _cache.inflight;
}

function getEndpoint() { return HOST_METRICS_URL; }
function isHostMetricsDisabled() { return isDisabled(); }

module.exports = { getHostMetrics, getEndpoint, isHostMetricsDisabled, normalize };
