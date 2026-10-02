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
var presence_exports = {};
__export(presence_exports, {
  PresenceTracker: () => PresenceTracker,
  collectSightings: () => collectSightings
});
module.exports = __toCommonJS(presence_exports);
var import_util = require("./util");
function collectSightings(leases, arp) {
  var _a, _b, _c, _d, _e, _f, _g;
  const out = /* @__PURE__ */ new Map();
  for (const l of leases) {
    const mac = (0, import_util.normalizeMac)(l.mac);
    if (!mac) {
      continue;
    }
    const s = (_a = out.get(mac)) != null ? _a : { mac, online: false };
    (_b = s.ip) != null ? _b : s.ip = l.ip || void 0;
    (_c = s.hostname) != null ? _c : s.hostname = l.hostname || void 0;
    (_d = s.interface) != null ? _d : s.interface = l.if || void 0;
    (_e = s.leaseEnds) != null ? _e : s.leaseEnds = l.ends || void 0;
    if (typeof l.online_status === "string" && /^online$/i.test(l.online_status.trim())) {
      s.online = true;
    }
    out.set(mac, s);
  }
  for (const a of arp) {
    const mac = (0, import_util.normalizeMac)(a.mac_address);
    if (!mac || a.permanent) {
      continue;
    }
    const s = (_f = out.get(mac)) != null ? _f : { mac, online: false };
    s.online = true;
    s.ip = a.ip_address || s.ip;
    if (a.hostname && a.hostname !== "?") {
      (_g = s.hostname) != null ? _g : s.hostname = a.hostname;
    }
    out.set(mac, s);
  }
  return out;
}
class PresenceTracker {
  /** @param graceMs - how long a device stays present after it was last seen */
  constructor(graceMs) {
    this.graceMs = graceMs;
  }
  lastSeen = /* @__PURE__ */ new Map();
  /** Restores a last-seen time from a previous run so a restart does not flip everyone to absent. */
  seed(mac, lastSeen) {
    if (Number.isFinite(lastSeen) && lastSeen > 0 && !this.lastSeen.has(mac)) {
      this.lastSeen.set(mac, lastSeen);
    }
  }
  /** Records a poll result and returns the debounced presence. */
  update(mac, onlineNow, now) {
    if (onlineNow) {
      this.lastSeen.set(mac, now);
    }
    const seen = this.lastSeen.get(mac);
    return { present: seen !== void 0 && now - seen <= this.graceMs, lastSeen: seen };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PresenceTracker,
  collectSightings
});
//# sourceMappingURL=presence.js.map
