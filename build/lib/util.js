"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var util_exports = {};
__export(util_exports, {
  RateTracker: () => RateTracker,
  clamp: () => clamp,
  errorMessage: () => errorMessage,
  macId: () => macId,
  normalizeMac: () => normalizeMac,
  parseLeaseTime: () => parseLeaseTime,
  parseUptime: () => parseUptime,
  sanitizeId: () => sanitizeId,
  toBool: () => toBool,
  toNumber: () => toNumber,
  toStr: () => toStr
});
module.exports = __toCommonJS(util_exports);
function sanitizeId(raw) {
  const id = raw.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return id || "_";
}
function normalizeMac(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) {
    return "";
  }
  return hex.match(/.{2}/g).join(":");
}
function macId(mac) {
  return mac.replace(/:/g, "_");
}
function toNumber(v) {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : void 0;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : void 0;
  }
  return void 0;
}
function toStr(v) {
  return typeof v === "string" ? v : void 0;
}
function toBool(v) {
  return typeof v === "boolean" ? v : void 0;
}
const UPTIME_UNITS = {
  year: 31536e3,
  week: 604800,
  day: 86400,
  hour: 3600,
  minute: 60,
  second: 1
};
function parseUptime(text) {
  if (typeof text !== "string" || !text.trim()) {
    return void 0;
  }
  let total = 0;
  let found = false;
  const unitRe = /(\d+)\s*(year|week|day|hour|minute|second)s?/gi;
  for (const m of text.matchAll(unitRe)) {
    total += Number(m[1]) * UPTIME_UNITS[m[2].toLowerCase()];
    found = true;
  }
  const clock = /(\d+):(\d{2}):(\d{2})/.exec(text);
  if (clock) {
    total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    found = true;
  }
  return found ? total : void 0;
}
function parseLeaseTime(text) {
  if (typeof text !== "string") {
    return void 0;
  }
  const t = text.trim();
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(t);
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  if (m) {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : void 0;
  }
  return void 0;
}
function clamp(value, min, max, def) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    return def;
  }
  return Math.min(max, Math.max(min, n));
}
class RateTracker {
  last = /* @__PURE__ */ new Map();
  /** Records a counter sample and returns the rate since the previous one. */
  bitsPerSecond(key, bytes, at) {
    if (bytes === void 0) {
      return void 0;
    }
    const prev = this.last.get(key);
    this.last.set(key, { bytes, at });
    if (!prev || at <= prev.at || bytes < prev.bytes) {
      return void 0;
    }
    return Math.round((bytes - prev.bytes) * 8 * 1e3 / (at - prev.at));
  }
  /** Drops samples whose key starts with `prefix` (entity removed). */
  forget(prefix) {
    for (const key of this.last.keys()) {
      if (key.startsWith(prefix)) {
        this.last.delete(key);
      }
    }
  }
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RateTracker,
  clamp,
  errorMessage,
  macId,
  normalizeMac,
  parseLeaseTime,
  parseUptime,
  sanitizeId,
  toBool,
  toNumber,
  toStr
});
//# sourceMappingURL=util.js.map
