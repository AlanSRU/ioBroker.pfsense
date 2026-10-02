"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_client = require("./lib/client");
var import_config = require("./lib/config");
var F = __toESM(require("./lib/features"));
var import_objects = require("./lib/objects");
var import_presence = require("./lib/presence");
var import_util = require("./lib/util");
const UNAVAILABLE_RETRY_MS = 30 * 6e4;
const MAX_BACKOFF_MS = 5 * 6e4;
const FAILURES_BEFORE_OFFLINE = 2;
const TIMEOUT_RETRY_MS = 10 * 6e4;
const PROBE_PATH = "/api/v2/status/system";
const ENDPOINT_KINDS = /* @__PURE__ */ new Set(["forbidden", "notFound", "dependency"]);
class Pfsense extends utils.Adapter {
  settings;
  client;
  writer;
  rates = new import_util.RateTracker();
  presence = new import_presence.PresenceTracker(0);
  tiers = /* @__PURE__ */ new Map();
  unloaded = false;
  /** Serialises all API calls: pfSense's PHP backend handles one request at a time best. */
  queue = Promise.resolve();
  isConnected = false;
  failures = 0;
  lastErrorText = "";
  unavailable = /* @__PURE__ */ new Map();
  /** Consecutive timeouts per path, and paths skipped because of them (cleared on reconnect). */
  timeouts = /* @__PURE__ */ new Map();
  skippedForTimeouts = /* @__PURE__ */ new Set();
  /** When the firewall last answered anything, and when any call last timed out. */
  lastAnswerAt = 0;
  lastTimeoutAt = 0;
  /**
   * Failures of the liveness probe while the firewall still answers (missing privilege, missing
   * package, server error). Counted separately: only a probe success resets them, so other endpoints
   * answering cannot hide a broken probe.
   */
  probeFailures = 0;
  lastProbeErrorText = "";
  lastProbeOkAt = 0;
  /** When a path last gave a non-API answer; it counts as missing only if that repeats after a good probe. */
  noApiSeenAt = /* @__PURE__ */ new Map();
  reported = /* @__PURE__ */ new Set();
  services = /* @__PURE__ */ new Map();
  wake = /* @__PURE__ */ new Map();
  /** Interface description/hardware name → id, for Wake-on-LAN requests that name the interface loosely. */
  ifaceIds = /* @__PURE__ */ new Map();
  hosts = [];
  constructor(options = {}) {
    super({ ...options, name: "pfsense" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  // ---- lifecycle --------------------------------------------------------------------------
  async onReady() {
    this.writer = new import_objects.ObjectWriter(this, () => this.unloaded);
    await this.setState("info.connection", false, true);
    const { settings, errors } = (0, import_config.parseSettings)(this.config);
    if (!settings) {
      for (const e of errors) {
        this.log.error(`Configuration: ${e}`);
      }
      this.log.error("Polling not started. Fix the instance settings and save them.");
      return;
    }
    this.settings = settings;
    if (settings.client.protocol === "https" && settings.client.tlsMode === "insecure") {
      this.log.warn(
        "Certificate verification is turned off. Anyone on the network path could read the API credentials; prefer certificate pinning."
      );
    }
    if (settings.client.protocol === "http") {
      this.log.warn("Using plain HTTP: API credentials are sent unencrypted.");
    }
    this.presence = new import_presence.PresenceTracker(settings.presenceGraceMs);
    await this.writer.load();
    if (this.unloaded) {
      return;
    }
    await this.cleanUpDisabledParts(settings);
    if (this.unloaded) {
      return;
    }
    await this.restorePresence();
    if (this.unloaded) {
      return;
    }
    if (settings.powerControl) {
      await this.writer.channel("control", "Control");
      await this.writer.defineState("control.reboot", F.button("Reboot the firewall"));
      await this.writer.defineState("control.halt", F.button("Shut down the firewall"));
    }
    this.subscribeStates("services.*.start");
    this.subscribeStates("services.*.stop");
    this.subscribeStates("services.*.restart");
    this.subscribeStates("firewall.rules.*.enabled");
    this.subscribeStates("firewall.apply");
    this.subscribeStates("carp.enabled");
    this.subscribeStates("carp.maintenanceMode");
    this.subscribeStates("control.*");
    this.subscribeStates("devices.*.wake");
    if (this.unloaded) {
      return;
    }
    this.client = new import_client.PfSenseClient(settings.client);
    this.log.info(
      `Connecting to pfSense at ${settings.client.protocol}://${settings.client.host}:${settings.client.port}`
    );
    this.buildTiers(settings);
    let delay = 0;
    for (const name of ["config", "status", "fast", "network"]) {
      const tier = this.tiers.get(name);
      if (tier) {
        tier.timer = this.setTimeout(() => void this.runTier(tier), delay);
        delay += 500;
      }
    }
  }
  onUnload(callback) {
    var _a;
    this.unloaded = true;
    try {
      for (const tier of this.tiers.values()) {
        if (tier.timer) {
          this.clearTimeout(tier.timer);
        }
      }
      (_a = this.client) == null ? void 0 : _a.close();
      void this.setState("info.connection", false, true);
    } catch {
    }
    callback();
  }
  /** Removes objects for things the user switched off where keeping them would mislead (controls). */
  async cleanUpDisabledParts(s) {
    var _a;
    const w = this.writer;
    if (!s.powerControl && w.has("control")) {
      await w.remove("control");
    }
    if (!s.serviceControl) {
      for (const key of w.childKeys("services")) {
        for (const action of ["start", "stop", "restart"]) {
          if (w.has(`services.${key}.${action}`)) {
            await w.remove(`services.${key}.${action}`);
          }
        }
      }
    }
    if (!s.trackAllHosts) {
      const configured = F.configuredMacs(s.watched);
      for (const key of w.childKeys("devices")) {
        const obj = await this.getObjectAsync(`devices.${key}`);
        const mac = (0, import_util.normalizeMac)((_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.mac);
        if ((obj == null ? void 0 : obj.type) === "device" && mac && !configured.has(mac)) {
          this.log.info(`Removing device ${mac}: no longer in the presence list`);
          await w.remove(`devices.${key}`);
        }
      }
    }
  }
  /** Seeds the presence debounce from the last run so a restart does not report everyone as gone. */
  async restorePresence() {
    var _a;
    for (const key of this.writer.childKeys("devices")) {
      const st = await this.getStateAsync(`devices.${key}.lastSeen`);
      const obj = await this.getObjectAsync(`devices.${key}`);
      const mac = (0, import_util.normalizeMac)((_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.mac);
      if (mac && typeof (st == null ? void 0 : st.val) === "number") {
        this.presence.seed(mac, st.val);
      }
    }
  }
  // ---- polling ----------------------------------------------------------------------------
  buildTiers(s) {
    const add = (name, jobs) => {
      if (jobs.length) {
        this.tiers.set(name, { name, jobs, running: false, again: false });
      }
    };
    const fast = [];
    if (s.interfaces) {
      fast.push(F.pollInterfaces);
    }
    if (s.gateways) {
      fast.push(F.pollGateways);
    }
    const status = [F.pollSystemStatus];
    if (s.services) {
      status.push(async (ctx) => {
        const idx = await F.pollServices(ctx, s.serviceControl);
        if (idx) {
          this.services = idx;
        }
      });
    }
    if (s.vpn) {
      status.push(F.pollVpn);
    }
    if (s.carp) {
      status.push(F.pollCarp);
    }
    if (s.firewallRules || s.aliases) {
      status.push(F.pollFirewallPending);
    }
    const network = [];
    if (s.network) {
      network.push(async (ctx) => {
        const r = await F.pollNetwork(ctx, {
          watched: s.watched,
          trackAll: s.trackAllHosts,
          tracker: this.presence
        });
        if (r) {
          this.wake = r.wake;
          this.ifaceIds = r.ifaceIds;
          this.hosts = r.sightings;
        }
      });
    }
    const config = [F.pollSystemInfo];
    if (s.firewallRules) {
      config.push((ctx) => F.pollFirewallRules(ctx, s.ruleFilter));
    }
    if (s.aliases) {
      config.push(F.pollFirewallAliases);
    }
    add("fast", fast);
    add("status", status);
    add("network", network);
    add("config", config);
  }
  async runTier(tier) {
    tier.timer = void 0;
    if (this.unloaded) {
      return;
    }
    tier.running = true;
    const ctx = {
      w: this.writer,
      rates: this.rates,
      now: Date.now(),
      fetch: async (path, query) => {
        const data = await this.fetch(path, query);
        ctx.now = Date.now();
        return data;
      }
    };
    for (const job of tier.jobs) {
      if (this.unloaded) {
        break;
      }
      try {
        await job(ctx);
      } catch (err) {
        if (!(err instanceof import_client.ApiError && err.isConnectionLevel)) {
          this.logOnce(
            `job:${tier.name}:${(0, import_util.errorMessage)(err)}`,
            "warn",
            `Updating ${tier.name} data failed: ${(0, import_util.errorMessage)(err)}`
          );
        }
        if (err instanceof import_client.ApiError && err.isConnectionLevel) {
          break;
        }
      }
    }
    tier.running = false;
    if (this.unloaded) {
      return;
    }
    const delay = tier.again ? 0 : this.nextDelay(tier.name);
    tier.again = false;
    tier.timer = this.setTimeout(() => void this.runTier(tier), delay);
  }
  /** Runs a tier soon (after a command), without waiting for its regular period. */
  refresh(name) {
    const tier = this.tiers.get(name);
    if (!tier || this.unloaded) {
      return;
    }
    if (tier.running) {
      tier.again = true;
      return;
    }
    if (tier.timer) {
      this.clearTimeout(tier.timer);
    }
    tier.timer = this.setTimeout(() => void this.runTier(tier), 1e3);
  }
  nextDelay(name) {
    const base = this.settings.intervals[name];
    if (this.failures < FAILURES_BEFORE_OFFLINE) {
      return base;
    }
    const factor = 2 ** Math.min(6, this.failures - FAILURES_BEFORE_OFFLINE + 1);
    return Math.max(base, Math.min(MAX_BACKOFF_MS, this.settings.intervals.fast * factor));
  }
  /** Puts an API call into the queue. */
  call(fn) {
    const run = () => {
      if (this.unloaded || !this.client) {
        return Promise.reject(new import_client.ApiError("network", "Adapter is stopping"));
      }
      return fn(this.client);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => void 0);
    return p;
  }
  /**
   * GET for pollers. Resolves undefined when the endpoint gave no usable data:
   * - not offered / not permitted / package missing: skipped for a while, logged once;
   * - transient server or validation error: retried on the next poll;
   * - repeated timeouts on one endpoint while the firewall answers others: skipped for a while.
   * Failures that mean the firewall is unreachable are counted against the connection and rethrown.
   */
  async fetch(path, query) {
    var _a;
    const until = this.unavailable.get(path);
    if (until !== void 0 && Date.now() < until) {
      return void 0;
    }
    try {
      const data = await this.call((c) => c.get(path, query));
      this.unavailable.delete(path);
      this.timeouts.delete(path);
      this.noApiSeenAt.delete(path);
      for (const key of [...this.reported]) {
        if (key.endsWith(`:${path}`) || key.startsWith(`unavailable:${path}:`)) {
          this.reported.delete(key);
        }
      }
      this.onSuccess(path === PROBE_PATH);
      return data;
    } catch (err) {
      if (!(err instanceof import_client.ApiError) || this.unloaded) {
        throw err;
      }
      const probe = path === PROBE_PATH;
      if (probe && (ENDPOINT_KINDS.has(err.kind) || err.kind === "noApi" || err.kind === "server" || err.kind === "validation")) {
        this.onProbeFailure(
          err.kind === "forbidden" ? `The API user lacks the privilege api-v2-status-system-get, which the adapter needs to check the connection. Grant it on the firewall.` : err.kind === "noApi" ? describe(err) : `${PROBE_PATH} failed: ${err.message}`
        );
        return void 0;
      }
      if (err.kind === "noApi" && !probe && this.isConnected) {
        const prev = this.noApiSeenAt.get(path);
        if (prev === void 0 || this.lastProbeOkAt <= prev) {
          this.noApiSeenAt.set(path, Date.now());
          this.log.debug(`${path}: ${err.message}`);
          return void 0;
        }
        this.noApiSeenAt.delete(path);
        this.unavailable.set(path, Date.now() + UNAVAILABLE_RETRY_MS);
        this.reportUnavailable(path, err);
        return void 0;
      }
      if (ENDPOINT_KINDS.has(err.kind)) {
        this.onSuccess();
        this.unavailable.set(path, Date.now() + UNAVAILABLE_RETRY_MS);
        this.reportUnavailable(path, err);
        return void 0;
      }
      if (err.kind === "server" || err.kind === "validation") {
        this.logOnce(`transient:${path}`, "warn", `${path} failed: ${err.message}. Retrying on the next poll.`);
        return void 0;
      }
      const firewallAnswering = this.lastAnswerAt > this.lastTimeoutAt;
      if (err.kind === "timeout") {
        this.lastTimeoutAt = Date.now();
      }
      if (err.kind === "timeout" && !probe && this.isConnected && firewallAnswering) {
        const n = ((_a = this.timeouts.get(path)) != null ? _a : 0) + 1;
        this.timeouts.set(path, n);
        if (n >= 2) {
          this.timeouts.delete(path);
          this.unavailable.set(path, Date.now() + TIMEOUT_RETRY_MS);
          this.skippedForTimeouts.add(path);
          this.logOnce(
            `timeout:${path}`,
            "warn",
            `${path} keeps timing out while the firewall answers other requests; skipping it for ${TIMEOUT_RETRY_MS / 6e4} minutes. Raise the request timeout if this repeats.`
          );
        } else {
          this.log.debug(`${path} timed out`);
        }
        return void 0;
      }
      this.log.debug(`${path}: ${err.message}`);
      this.onFailure(err);
      throw err;
    }
  }
  reportUnavailable(path, err) {
    const key = `unavailable:${path}:${err.kind}`;
    if (err.kind === "forbidden") {
      this.logOnce(
        key,
        "warn",
        `The API user may not read ${path} (${err.message}). Grant the privilege on the firewall or disable the feature.`
      );
    } else if (err.kind === "dependency") {
      this.logOnce(
        key,
        "info",
        `${path} is not available: ${err.message} (a required pfSense package is not installed).`
      );
    } else if (err.kind === "notFound" || err.kind === "noApi") {
      this.logOnce(
        key,
        "info",
        err.kind === "notFound" && err.message ? `${path} is not available: ${err.message}` : `${path} is not offered by this REST API package version. Updating the package enables it.`
      );
    } else {
      this.logOnce(key, "warn", `${path} failed: ${err.message}`);
    }
  }
  onSuccess(probe = false) {
    this.lastAnswerAt = Date.now();
    this.failures = 0;
    this.lastErrorText = "";
    if (probe) {
      this.lastProbeOkAt = Date.now();
      if (this.probeFailures) {
        this.log.info(`${PROBE_PATH} answers again`);
      }
      this.probeFailures = 0;
      this.lastProbeErrorText = "";
    }
    this.updateConnection();
  }
  /** A failure that means the firewall is unreachable or rejects us: counted, logged once per distinct message. */
  onFailure(err) {
    this.failures++;
    const text = describe(err);
    if (text !== this.lastErrorText) {
      this.lastErrorText = text;
      if (err.kind === "auth") {
        this.log.error(text);
      } else {
        this.log.warn(text);
      }
    } else {
      this.log.debug(text);
    }
    this.updateConnection();
  }
  onProbeFailure(text) {
    this.probeFailures++;
    if (text !== this.lastProbeErrorText) {
      this.lastProbeErrorText = text;
      this.log.error(text);
    } else {
      this.log.debug(text);
    }
    this.updateConnection();
  }
  /** Derives info.connection from both failure counters and logs the transitions once. */
  updateConnection() {
    if (this.unloaded) {
      return;
    }
    const ok = this.failures < FAILURES_BEFORE_OFFLINE && this.probeFailures < FAILURES_BEFORE_OFFLINE;
    if (ok && !this.isConnected) {
      this.isConnected = true;
      for (const p of this.skippedForTimeouts) {
        this.unavailable.delete(p);
      }
      this.skippedForTimeouts.clear();
      void this.setState("info.connection", true, true);
      this.log.info(
        this.reported.has("connection-lost") ? "Connection to pfSense restored" : "Connected to pfSense"
      );
      this.reported.delete("connection-lost");
    } else if (!ok && this.isConnected) {
      this.isConnected = false;
      void this.setState("info.connection", false, true);
      this.reported.add("connection-lost");
      this.log.warn(
        this.failures >= FAILURES_BEFORE_OFFLINE ? "Connection to pfSense lost; retrying with back-off" : "pfSense answers, but its status endpoint does not; reporting the connection as down"
      );
    }
  }
  logOnce(key, level, text) {
    if (this.reported.has(key)) {
      this.log.debug(text);
      return;
    }
    this.reported.add(key);
    this.log[level](text);
  }
  // ---- commands ---------------------------------------------------------------------------
  async onStateChange(id, state) {
    if (!state || state.ack || this.unloaded || !this.client) {
      return;
    }
    const rel = id.slice(this.namespace.length + 1);
    try {
      const handled = await this.command(rel, state.val);
      if (!handled) {
        this.log.debug(`No handler for ${rel}`);
      }
    } catch (err) {
      this.log.warn(`Command ${rel} failed: ${(0, import_util.errorMessage)(err)}`);
      if (rel.startsWith("firewall.")) {
        this.refresh("config");
      }
      this.refresh("status");
    }
  }
  /** Executes a command written to a state. Returns false when the id is not a command. */
  async command(rel, val) {
    var _a, _b, _c;
    let m;
    if (m = /^services\.([^.]+)\.(start|stop|restart)$/.exec(rel)) {
      if (!((_a = this.settings) == null ? void 0 : _a.serviceControl)) {
        return false;
      }
      await this.serviceAction(m[1], m[2]);
      await this.setState(rel, { val, ack: true });
      this.refresh("status");
      return true;
    }
    if (m = /^firewall\.rules\.(\d+)\.enabled$/.exec(rel)) {
      await this.setRuleEnabled(Number(m[1]), !!val);
      await this.setState(rel, { val: !!val, ack: true });
      this.refresh("status");
      return true;
    }
    if (rel === "firewall.apply") {
      await this.applyFirewall();
      await this.setState(rel, { val, ack: true });
      this.refresh("status");
      return true;
    }
    if (rel === "carp.enabled" || rel === "carp.maintenanceMode") {
      const cur = await this.call((c) => c.get("/api/v2/status/carp"));
      const body = {
        enable: rel === "carp.enabled" ? !!val : !!cur.enable,
        maintenance_mode: rel === "carp.maintenanceMode" ? !!val : !!cur.maintenance_mode
      };
      await this.call((c) => c.patch("/api/v2/status/carp", body));
      await this.setState(rel, { val: !!val, ack: true });
      this.refresh("status");
      return true;
    }
    if (rel === "control.reboot" || rel === "control.halt") {
      if (!((_b = this.settings) == null ? void 0 : _b.powerControl)) {
        return false;
      }
      this.log.warn(`${rel === "control.reboot" ? "Rebooting" : "Shutting down"} the firewall on request`);
      await this.call(
        (c) => c.post(rel === "control.reboot" ? "/api/v2/diagnostics/reboot" : "/api/v2/diagnostics/halt_system", {})
      );
      await this.setState(rel, { val, ack: true });
      return true;
    }
    if (m = /^devices\.([^.]+)\.wake$/.exec(rel)) {
      const obj = await this.getObjectAsync(`devices.${m[1]}`);
      const mac = (0, import_util.normalizeMac)((_c = obj == null ? void 0 : obj.native) == null ? void 0 : _c.mac);
      if (!mac) {
        throw new Error("device has no MAC address");
      }
      await this.wakeOnLan(mac);
      await this.setState(rel, { val, ack: true });
      return true;
    }
    return false;
  }
  async serviceAction(key, action) {
    var _a, _b;
    const svc = this.services.get(key);
    if (!svc) {
      throw new Error(`unknown service ${key}`);
    }
    const list = await this.call((c) => c.get("/api/v2/status/services"));
    const current = Array.isArray(list) ? list.filter(
      (s) => s.name === svc.name && (svc.description === void 0 || s.description === svc.description)
    ) : [];
    if (Array.isArray(list) && list.filter((s) => s.name === svc.name).length > 1) {
      throw new Error(
        `the REST API cannot control "${svc.name}" while several services share that name (e.g. multiple OpenVPN instances)`
      );
    }
    if (current.length !== 1 || (0, import_util.toNumber)(current[0].id) === void 0) {
      throw new Error(`service ${(_a = svc.description) != null ? _a : svc.name} not found on the firewall (any more)`);
    }
    this.log.info(`Service ${(_b = svc.description) != null ? _b : svc.name}: ${action}`);
    await this.call((c) => c.post("/api/v2/status/service", { id: current[0].id, action }));
  }
  /** Looks a rule up by its tracker (the stable identity), changes it and applies. */
  async setRuleEnabled(tracker, enabled) {
    var _a;
    const rules = await this.call((c) => c.get("/api/v2/firewall/rules", { tracker }));
    const rule = Array.isArray(rules) ? rules.find((r) => (0, import_util.toNumber)(r.tracker) === tracker) : void 0;
    if (!rule || (0, import_util.toNumber)(rule.id) === void 0) {
      throw new Error(`firewall rule with tracker ${tracker} not found`);
    }
    this.log.info(`Firewall rule "${(_a = rule.descr) != null ? _a : tracker}": ${enabled ? "enable" : "disable"}`);
    await this.call((c) => c.patch("/api/v2/firewall/rule", { id: rule.id, disabled: !enabled }));
    await this.applyFirewall();
  }
  async applyFirewall() {
    await this.call((c) => c.post("/api/v2/firewall/apply", {}));
  }
  async wakeOnLan(mac, iface) {
    var _a;
    const target = iface && ((_a = this.ifaceIds.get(iface.toLowerCase())) != null ? _a : iface) || this.wake.get(mac);
    if (!target) {
      throw new Error(`no interface known for ${mac}; set it in the presence list or pass it to the command`);
    }
    this.log.info(`Wake-on-LAN for ${mac} on ${target}`);
    await this.call((c) => c.post("/api/v2/services/wake_on_lan/send", { interface: target, mac_addr: mac }));
  }
  async changeAlias(name, entry, detail, add) {
    const list = await this.call((c) => c.get("/api/v2/firewall/aliases", { name }));
    const alias = Array.isArray(list) ? list.find((a) => a.name === name) : void 0;
    if (!alias || (0, import_util.toNumber)(alias.id) === void 0) {
      throw new Error(`alias ${name} not found`);
    }
    const address = Array.isArray(alias.address) ? [...alias.address] : [];
    const details = Array.isArray(alias.detail) ? [...alias.detail] : [];
    while (details.length < address.length) {
      details.push("");
    }
    details.length = address.length;
    const at = address.indexOf(entry);
    if (add) {
      if (at >= 0) {
        return alias;
      }
      address.push(entry);
      details.push(detail != null ? detail : "Added by ioBroker");
    } else {
      if (at < 0) {
        return alias;
      }
      address.splice(at, 1);
      details.splice(at, 1);
    }
    const updated = await this.call(
      (c) => c.patch("/api/v2/firewall/alias", { id: alias.id, address, detail: details })
    );
    await this.applyFirewall();
    this.refresh("config");
    return updated;
  }
  // ---- messages ---------------------------------------------------------------------------
  async onMessage(obj) {
    var _a, _b, _c;
    if (!obj || typeof obj !== "object") {
      return;
    }
    const reply = (res) => {
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, res, obj.callback);
      }
    };
    const msg = obj.message && typeof obj.message === "object" ? obj.message : {};
    try {
      switch (obj.command) {
        case "testConnection":
          return reply({ result: await this.testConnection(msg) });
        case "readFingerprint": {
          const host = (0, import_config.cleanHost)(msg.host);
          if (!host) {
            return reply({ error: "Enter the firewall address first" });
          }
          const fp = await (0, import_client.fetchFingerprint)(host, (_a = (0, import_util.toNumber)(msg.port)) != null ? _a : 443, 1e4);
          return reply({ native: { certFingerprint: fp }, result: fp });
        }
      }
      if (!this.client) {
        return reply({ error: "Not connected: the adapter is not configured or still starting" });
      }
      switch (obj.command) {
        case "wakeOnLan": {
          const mac = (0, import_util.normalizeMac)(msg.mac);
          if (!mac) {
            return reply({ error: "mac is missing or invalid" });
          }
          await this.wakeOnLan(mac, typeof msg.interface === "string" ? msg.interface : void 0);
          return reply({ result: "ok" });
        }
        case "serviceAction": {
          const action = msg.action;
          if (action !== "start" && action !== "stop" && action !== "restart") {
            return reply({ error: "action must be start, stop or restart" });
          }
          if (!((_b = this.settings) == null ? void 0 : _b.serviceControl)) {
            return reply({ error: "Service control is disabled in the instance settings" });
          }
          await this.serviceAction(typeof msg.service === "string" ? msg.service : "", action);
          this.refresh("status");
          return reply({ result: "ok" });
        }
        case "setRuleEnabled": {
          const tracker = (0, import_util.toNumber)(msg.tracker);
          if (tracker === void 0 || typeof msg.enabled !== "boolean") {
            return reply({ error: "tracker (number) and enabled (boolean) are required" });
          }
          await this.setRuleEnabled(tracker, msg.enabled);
          this.refresh("config");
          return reply({ result: "ok" });
        }
        case "applyFirewall":
          await this.applyFirewall();
          this.refresh("status");
          return reply({ result: "ok" });
        case "aliasAddEntry":
        case "aliasRemoveEntry": {
          if (typeof msg.alias !== "string" || typeof msg.entry !== "string" || !msg.entry.trim()) {
            return reply({ error: "alias and entry are required" });
          }
          const a = await this.changeAlias(
            msg.alias,
            msg.entry.trim(),
            typeof msg.detail === "string" ? msg.detail : void 0,
            obj.command === "aliasAddEntry"
          );
          return reply({ result: { name: a.name, entries: (_c = a.address) != null ? _c : [] } });
        }
        case "getHosts":
          return reply({ result: this.hosts });
        default:
          return reply({ error: `Unknown command ${obj.command}` });
      }
    } catch (err) {
      reply({ error: (0, import_util.errorMessage)(err) });
    }
  }
  /** "Test connection" in the instance settings: uses the values in the form, not the saved ones. */
  async testConnection(form) {
    var _a, _b;
    const merged = { ...this.config, ...form };
    const { settings, errors } = (0, import_config.parseSettings)(merged);
    if (!settings) {
      throw new Error(errors.join(" "));
    }
    const opts = { ...settings.client };
    const client = new import_client.PfSenseClient(opts);
    try {
      const version = await client.get("/api/v2/system/version");
      let api = "";
      try {
        api = (_a = (await client.get("/api/v2/system/restapi/version")).current_version) != null ? _a : "";
      } catch {
      }
      await client.get("/api/v2/status/system");
      return `Connected: pfSense ${(_b = version.version) != null ? _b : "?"}${api ? `, REST API ${api}` : ""}`;
    } catch (err) {
      throw new Error(err instanceof import_client.ApiError ? describe(err) : (0, import_util.errorMessage)(err));
    } finally {
      client.close();
    }
  }
}
function describe(err) {
  switch (err.kind) {
    case "auth":
      return `Authentication failed (${err.message}). Check the API key or user name and password, and that the authentication method is enabled under System > REST API.`;
    case "tls":
      return err.message;
    case "timeout":
      return `pfSense did not answer in time (${err.message}).`;
    case "noApi":
      return err.message;
    default:
      return `Cannot reach pfSense: ${err.message}`;
  }
}
if (require.main !== module) {
  module.exports = (options) => new Pfsense(options);
} else {
  (() => new Pfsense())();
}
//# sourceMappingURL=main.js.map
