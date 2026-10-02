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
var config_exports = {};
__export(config_exports, {
  LIMITS: () => LIMITS,
  cleanHost: () => cleanHost,
  parseSettings: () => parseSettings
});
module.exports = __toCommonJS(config_exports);
var import_client = require("./client");
var import_features = require("./features");
var import_util = require("./util");
const LIMITS = {
  requestTimeout: { min: 2, max: 60, def: 10 },
  intervalFast: { min: 5, max: 3600, def: 10 },
  intervalStatus: { min: 10, max: 3600, def: 30 },
  intervalNetwork: { min: 15, max: 3600, def: 60 },
  intervalConfig: { min: 60, max: 86400, def: 300 },
  presenceGrace: { min: 0, max: 86400, def: 180 }
};
function lim(cfg, key) {
  const l = LIMITS[key];
  return (0, import_util.clamp)(cfg[key], l.min, l.max, l.def);
}
function cleanHost(raw) {
  var _a;
  let h = ((_a = (0, import_util.toStr)(raw)) != null ? _a : "").trim();
  h = h.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) {
    return v6[1];
  }
  if (/^[^:]+:\d+$/.test(h)) {
    h = h.replace(/:\d+$/, "");
  }
  return h;
}
function parseSettings(raw) {
  var _a, _b, _c, _d, _e;
  const cfg = raw;
  const errors = [];
  const host = cleanHost(cfg.host);
  if (!host) {
    errors.push("No firewall address configured.");
  }
  const protocol = cfg.protocol === "http" ? "http" : "https";
  const port = (0, import_util.clamp)(cfg.port, 1, 65535, protocol === "http" ? 80 : 443);
  const tlsMode = cfg.tlsMode === "verify" || cfg.tlsMode === "insecure" ? cfg.tlsMode : "fingerprint";
  const fingerprint = (0, import_client.normalizeFingerprint)((_a = (0, import_util.toStr)(cfg.certFingerprint)) != null ? _a : "");
  if (protocol === "https" && tlsMode === "fingerprint" && fingerprint.length !== 95) {
    errors.push(
      'Certificate pinning is selected but no valid SHA-256 fingerprint is configured. Use "Read certificate fingerprint" in the instance settings.'
    );
  }
  let auth;
  if (cfg.authMode === "basic") {
    const username = ((_b = (0, import_util.toStr)(cfg.username)) != null ? _b : "").trim();
    const password = (_c = (0, import_util.toStr)(cfg.password)) != null ? _c : "";
    if (!username || !password) {
      errors.push("Basic authentication is selected but user name or password is missing.");
    }
    auth = { kind: "basic", username, password };
  } else {
    const apiKey = ((_d = (0, import_util.toStr)(cfg.apiKey)) != null ? _d : "").trim();
    if (!apiKey) {
      errors.push("No API key configured.");
    }
    auth = { kind: "key", apiKey };
  }
  if (errors.length) {
    return { errors };
  }
  const flag = (k, def) => typeof cfg[k] === "boolean" ? cfg[k] : def;
  return {
    errors,
    settings: {
      client: {
        host,
        port,
        protocol,
        tlsMode,
        fingerprint,
        auth,
        timeoutMs: lim(cfg, "requestTimeout") * 1e3
      },
      intervals: {
        fast: lim(cfg, "intervalFast") * 1e3,
        status: lim(cfg, "intervalStatus") * 1e3,
        network: lim(cfg, "intervalNetwork") * 1e3,
        config: lim(cfg, "intervalConfig") * 1e3
      },
      interfaces: flag("enableInterfaces", true),
      gateways: flag("enableGateways", true),
      services: flag("enableServices", true),
      serviceControl: flag("allowServiceControl", true),
      network: flag("enableNetwork", true),
      trackAllHosts: flag("trackAllHosts", false),
      presenceProbe: flag("presenceProbe", true),
      presenceGraceMs: lim(cfg, "presenceGrace") * 1e3,
      watched: (0, import_features.parseWatched)(cfg.presenceDevices),
      vpn: flag("enableVpn", true),
      carp: flag("enableCarp", true),
      firewallRules: flag("enableFirewallRules", false),
      ruleFilter: ((_e = (0, import_util.toStr)(cfg.ruleFilter)) != null ? _e : "").trim(),
      aliases: flag("enableAliases", false),
      powerControl: flag("allowPowerControl", false)
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIMITS,
  cleanHost,
  parseSettings
});
//# sourceMappingURL=config.js.map
