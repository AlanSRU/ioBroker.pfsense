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
var features_exports = {};
__export(features_exports, {
  MAX_PROBES_PER_POLL: () => MAX_PROBES_PER_POLL,
  button: () => button,
  configuredMacs: () => configuredMacs,
  interfaceIdMap: () => interfaceIdMap,
  parseWatched: () => parseWatched,
  pollCarp: () => pollCarp,
  pollFirewallAliases: () => pollFirewallAliases,
  pollFirewallPending: () => pollFirewallPending,
  pollFirewallRules: () => pollFirewallRules,
  pollGateways: () => pollGateways,
  pollInterfaces: () => pollInterfaces,
  pollNetwork: () => pollNetwork,
  pollServices: () => pollServices,
  pollSystemInfo: () => pollSystemInfo,
  pollSystemStatus: () => pollSystemStatus,
  pollVpn: () => pollVpn,
  ruleMatches: () => ruleMatches,
  serviceKey: () => serviceKey,
  toggle: () => toggle
});
module.exports = __toCommonJS(features_exports);
var import_presence = require("./presence");
var import_util = require("./util");
const text = (name) => ({ name, type: "string", role: "text" });
const json = (name) => ({ name, type: "string", role: "json" });
const indicator = (name, role = "indicator") => ({ name, type: "boolean", role });
const num = (name, unit, role = "value") => ({
  name,
  type: "number",
  role,
  ...unit ? { unit } : {}
});
const percent = (name) => ({ ...num(name, "%"), min: 0, max: 100 });
const button = (name) => ({
  name,
  type: "boolean",
  role: "button",
  read: false,
  write: true
});
const toggle = (name, role = "switch") => ({ name, type: "boolean", role, write: true });
function uniqueKeys(items, keyOf) {
  const seen = /* @__PURE__ */ new Map();
  return items.map((item) => {
    var _a;
    const base = (0, import_util.sanitizeId)(keyOf(item));
    const n = ((_a = seen.get(base)) != null ? _a : 0) + 1;
    seen.set(base, n);
    return [n === 1 ? base : `${base}_${n}`, item];
  });
}
async function pollSystemInfo(ctx) {
  const { w } = ctx;
  const [version, api, host] = [
    await ctx.fetch("/api/v2/system/version"),
    await ctx.fetch("/api/v2/system/restapi/version"),
    await ctx.fetch("/api/v2/system/hostname")
  ];
  await w.channel("system", "System");
  if (version) {
    await w.state(
      "system.version",
      { name: "pfSense version", type: "string", role: "info.firmware" },
      (0, import_util.toStr)(version.version)
    );
    await w.state("system.buildTime", text("Build time"), (0, import_util.toStr)(version.buildtime));
  }
  if (api) {
    await w.state("system.apiVersion", text("REST API package version"), (0, import_util.toStr)(api.current_version));
    await w.state("system.apiLatestVersion", text("Latest REST API package version"), (0, import_util.toStr)(api.latest_version));
    await w.state(
      "system.apiUpdateAvailable",
      indicator("REST API package update available", "indicator.maintenance"),
      (0, import_util.toBool)(api.update_available)
    );
  }
  if (host) {
    const fqdn = [(0, import_util.toStr)(host.hostname), (0, import_util.toStr)(host.domain)].filter(Boolean).join(".");
    await w.state("system.hostname", { name: "Host name", type: "string", role: "info.name" }, fqdn || void 0);
  }
}
async function pollSystemStatus(ctx) {
  const { w } = ctx;
  const s = await ctx.fetch("/api/v2/status/system");
  if (!s) {
    return;
  }
  await w.channel("system", "System");
  await w.state("system.platform", text("Platform"), (0, import_util.toStr)(s.platform) || void 0);
  await w.state(
    "system.serial",
    { name: "Serial number", type: "string", role: "info.serial" },
    (0, import_util.toStr)(s.serial) || void 0
  );
  await w.state("system.netgateId", text("Netgate device ID"), (0, import_util.toStr)(s.netgate_id) || void 0);
  await w.state("system.cpuModel", text("CPU model"), (0, import_util.toStr)(s.cpu_model));
  await w.state("system.cpuCount", num("CPU cores"), (0, import_util.toNumber)(s.cpu_count));
  await w.state("system.cpuUsage", percent("CPU usage"), (0, import_util.toNumber)(s.cpu_usage));
  const load = Array.isArray(s.cpu_load_avg) ? s.cpu_load_avg : [];
  await w.state("system.load1", num("Load average (1 min)"), (0, import_util.toNumber)(load[0]));
  await w.state("system.load5", num("Load average (5 min)"), (0, import_util.toNumber)(load[1]));
  await w.state("system.load15", num("Load average (15 min)"), (0, import_util.toNumber)(load[2]));
  await w.state("system.memoryUsage", percent("Memory usage"), (0, import_util.toNumber)(s.mem_usage));
  await w.state("system.swapUsage", percent("Swap usage"), (0, import_util.toNumber)(s.swap_usage));
  await w.state("system.diskUsage", percent("Disk usage"), (0, import_util.toNumber)(s.disk_usage));
  await w.state("system.mbufUsage", percent("Network buffer (mbuf) usage"), (0, import_util.toNumber)(s.mbuf_usage));
  const temp = (0, import_util.toNumber)(s.temp_c);
  await w.state("system.temperature", num("Temperature", "\xB0C", "value.temperature"), temp ? temp : void 0);
  await w.state("system.uptime", num("Uptime", "s"), (0, import_util.parseUptime)(s.uptime));
  await w.state("system.uptimeText", text("Uptime (as reported)"), (0, import_util.toStr)(s.uptime));
  await w.state("system.biosVendor", text("BIOS vendor"), (0, import_util.toStr)(s.bios_vendor) || void 0);
  await w.state("system.biosVersion", text("BIOS version"), (0, import_util.toStr)(s.bios_version) || void 0);
  await w.state("system.biosDate", text("BIOS date"), (0, import_util.toStr)(s.bios_date) || void 0);
}
async function pollInterfaces(ctx) {
  const { w } = ctx;
  const list = await ctx.fetch("/api/v2/status/interfaces");
  if (!Array.isArray(list)) {
    return;
  }
  await w.folder("interfaces", "Interfaces");
  const keys = [];
  for (const [key, i] of uniqueKeys(list, (i2) => {
    var _a, _b;
    return (_b = (_a = i2.name) != null ? _a : i2.hwif) != null ? _b : "interface";
  })) {
    keys.push(key);
    const p = `interfaces.${key}`;
    await w.channel(p, (0, import_util.toStr)(i.descr) || (0, import_util.toStr)(i.name) || key);
    await w.state(`${p}.name`, text("Interface id"), (0, import_util.toStr)(i.name));
    await w.state(`${p}.description`, text("Description"), (0, import_util.toStr)(i.descr));
    await w.state(`${p}.device`, text("Hardware interface"), (0, import_util.toStr)(i.hwif));
    await w.state(`${p}.status`, text("Link status"), (0, import_util.toStr)(i.status));
    const status = (0, import_util.toStr)(i.status);
    await w.state(`${p}.up`, indicator("Link up"), status === void 0 ? void 0 : /^up$/i.test(status));
    await w.state(`${p}.ipv4`, { name: "IPv4 address", type: "string", role: "info.ip" }, (0, import_util.toStr)(i.ipaddr));
    await w.state(`${p}.subnetv4`, num("IPv4 prefix length"), (0, import_util.prefixLength)(i.subnet));
    await w.state(`${p}.ipv6`, text("IPv6 address"), (0, import_util.toStr)(i.ipaddrv6));
    await w.state(`${p}.subnetv6`, num("IPv6 prefix length"), (0, import_util.prefixLength)(i.subnetv6));
    await w.state(`${p}.mac`, { name: "MAC address", type: "string", role: "info.mac" }, (0, import_util.toStr)(i.macaddr));
    await w.state(`${p}.mtu`, num("MTU"), (0, import_util.toNumber)(i.mtu));
    await w.state(`${p}.media`, text("Media (speed/duplex)"), (0, import_util.toStr)(i.media));
    await w.state(`${p}.gateway`, text("IPv4 gateway"), (0, import_util.toStr)(i.gateway));
    const inBytes = (0, import_util.toNumber)(i.inbytes);
    const outBytes = (0, import_util.toNumber)(i.outbytes);
    await w.state(`${p}.rxBytes`, num("Received", "B"), inBytes);
    await w.state(`${p}.txBytes`, num("Sent", "B"), outBytes);
    await w.state(`${p}.rxPackets`, num("Packets received"), (0, import_util.toNumber)(i.inpkts));
    await w.state(`${p}.txPackets`, num("Packets sent"), (0, import_util.toNumber)(i.outpkts));
    await w.state(`${p}.rxErrors`, num("Receive errors"), (0, import_util.toNumber)(i.inerrs));
    await w.state(`${p}.txErrors`, num("Send errors"), (0, import_util.toNumber)(i.outerrs));
    await w.state(`${p}.collisions`, num("Collisions"), (0, import_util.toNumber)(i.collisions));
    await w.state(
      `${p}.rxRate`,
      num("Receive rate", "bit/s"),
      ctx.rates.bitsPerSecond(`${p}.rx`, inBytes, ctx.now)
    );
    await w.state(`${p}.txRate`, num("Send rate", "bit/s"), ctx.rates.bitsPerSecond(`${p}.tx`, outBytes, ctx.now));
  }
  for (const gone of await w.removeStale("interfaces", keys)) {
    ctx.rates.forget(`interfaces.${gone}.`);
  }
}
const GATEWAY_DOWN = /down|offline/i;
async function pollGateways(ctx) {
  var _a;
  const { w } = ctx;
  const list = await ctx.fetch("/api/v2/status/gateways");
  if (!Array.isArray(list)) {
    return;
  }
  await w.folder("gateways", "Gateways");
  const keys = [];
  for (const [key, g] of uniqueKeys(list, (g2) => {
    var _a2;
    return (_a2 = g2.name) != null ? _a2 : "gateway";
  })) {
    keys.push(key);
    const p = `gateways.${key}`;
    await w.channel(p, (0, import_util.toStr)(g.name) || key);
    const status = (0, import_util.toStr)(g.status);
    await w.state(`${p}.status`, text("Status"), status);
    await w.state(
      `${p}.online`,
      indicator("Online", "indicator.reachable"),
      status === void 0 ? void 0 : !GATEWAY_DOWN.test(status)
    );
    await w.state(`${p}.substatus`, text("Sub-status"), (0, import_util.toStr)(g.substatus));
    const measured = ((_a = (0, import_util.toNumber)(g.loss)) != null ? _a : 0) < 100;
    await w.state(`${p}.latency`, num("Latency", "ms"), measured ? (0, import_util.toNumber)(g.delay) : void 0);
    await w.state(
      `${p}.latencyStdDev`,
      num("Latency standard deviation", "ms"),
      measured ? (0, import_util.toNumber)(g.stddev) : void 0
    );
    await w.state(`${p}.packetLoss`, percent("Packet loss"), (0, import_util.toNumber)(g.loss));
    await w.state(`${p}.monitorIp`, text("Monitor IP"), (0, import_util.toStr)(g.monitorip));
    await w.state(`${p}.sourceIp`, text("Source IP"), (0, import_util.toStr)(g.srcip));
  }
  await w.removeStale("gateways", keys);
}
function serviceKey(s) {
  var _a;
  return (_a = s.name) != null ? _a : "service";
}
async function pollServices(ctx, allowControl) {
  const { w } = ctx;
  const list = await ctx.fetch("/api/v2/status/services");
  if (!Array.isArray(list)) {
    return void 0;
  }
  const index = /* @__PURE__ */ new Map();
  await w.folder("services", "Services");
  const names = list.map(serviceKey);
  const keyed = uniqueKeys(list, (s) => {
    const name = serviceKey(s);
    return names.filter((n) => n === name).length > 1 && s.description ? `${name}_${s.description}` : name;
  });
  for (const [key, s] of keyed) {
    index.set(key, { name: serviceKey(s), description: (0, import_util.toStr)(s.description) });
    const p = `services.${key}`;
    await w.channel(p, (0, import_util.toStr)(s.description) || serviceKey(s));
    await w.state(`${p}.name`, text("Service name"), (0, import_util.toStr)(s.name));
    await w.state(`${p}.description`, text("Description"), (0, import_util.toStr)(s.description));
    await w.state(`${p}.enabled`, indicator("Enabled"), (0, import_util.toBool)(s.enabled));
    await w.state(`${p}.running`, indicator("Running", "indicator.working"), (0, import_util.toBool)(s.status));
    const controllable = allowControl && names.filter((n) => n === serviceKey(s)).length === 1;
    for (const [action, label] of [
      ["start", "Start service"],
      ["stop", "Stop service"],
      ["restart", "Restart service"]
    ]) {
      if (controllable) {
        await w.defineState(`${p}.${action}`, button(label));
      } else if (w.has(`${p}.${action}`)) {
        await w.remove(`${p}.${action}`);
      }
    }
  }
  await w.removeStale("services", index.keys());
  return index;
}
const MAX_PROBES_PER_POLL = 3;
function interfaceIdMap(list) {
  const m = /* @__PURE__ */ new Map();
  for (const i of list) {
    const id = (0, import_util.toStr)(i.name);
    if (!id) {
      continue;
    }
    for (const label of [i.name, i.descr, i.hwif]) {
      if (typeof label === "string" && label) {
        m.set(label.toLowerCase(), id);
      }
    }
  }
  return m;
}
async function pollNetwork(ctx, opts) {
  var _a, _b, _c;
  const { w } = ctx;
  const leases = await ctx.fetch("/api/v2/status/dhcp_server/leases");
  let arp = await ctx.fetch("/api/v2/diagnostics/arp_table");
  if (!Array.isArray(leases) && !Array.isArray(arp)) {
    return void 0;
  }
  const ifaces = Array.isArray(arp) && arp.length ? await ctx.fetch("/api/v2/status/interfaces") : void 0;
  const ifaceIds = interfaceIdMap(Array.isArray(ifaces) ? ifaces : []);
  let sightings = (0, import_presence.collectSightings)(Array.isArray(leases) ? leases : [], Array.isArray(arp) ? arp : [], ifaceIds);
  if (opts.probe) {
    const candidates = opts.watched.filter((d) => {
      var _a2;
      return d.enabled && !((_a2 = sightings.get(d.mac)) == null ? void 0 : _a2.online) && opts.tracker.inGrace(d.mac, ctx.now);
    }).map((d) => {
      var _a2, _b2;
      return { mac: d.mac, ip: (_b2 = (_a2 = sightings.get(d.mac)) == null ? void 0 : _a2.ip) != null ? _b2 : opts.tracker.ipOf(d.mac) };
    }).filter((c) => !!c.ip).slice(0, MAX_PROBES_PER_POLL);
    const replied = /* @__PURE__ */ new Set();
    for (const c of candidates) {
      if (await opts.probe(c.ip)) {
        replied.add(c.mac);
      }
    }
    if (candidates.length) {
      const again = await ctx.fetch("/api/v2/diagnostics/arp_table");
      if (Array.isArray(again)) {
        arp = again;
      }
      sightings = (0, import_presence.collectSightings)(Array.isArray(leases) ? leases : [], Array.isArray(arp) ? arp : [], ifaceIds);
      for (const mac of replied) {
        const s = (_b = sightings.get(mac)) != null ? _b : { mac, online: false, ip: (_a = candidates.find((c) => c.mac === mac)) == null ? void 0 : _a.ip };
        s.online = true;
        sightings.set(mac, s);
      }
    }
  }
  for (const s of sightings.values()) {
    opts.tracker.noteIp(s.mac, s.ip);
  }
  const all = [...sightings.values()].sort((a, b) => a.mac.localeCompare(b.mac));
  await w.folder("network", "Network");
  if (Array.isArray(leases)) {
    await w.state("network.leaseCount", num("DHCP leases"), leases.length);
  }
  if (Array.isArray(arp)) {
    await w.state("network.arpCount", num("ARP table entries"), arp.length);
  }
  await w.state("network.onlineCount", num("Hosts online"), all.filter((s) => s.online).length);
  await w.state("network.hosts", json("Known hosts (JSON)"), JSON.stringify(all));
  const wake = /* @__PURE__ */ new Map();
  for (const s of all) {
    if (s.interface) {
      wake.set(s.mac, s.interface);
    }
  }
  const devices = /* @__PURE__ */ new Map();
  for (const d of opts.watched) {
    if (d.enabled) {
      devices.set(d.mac, { name: d.name, interface: d.interface, keepUserName: false });
    }
  }
  if (opts.trackAll) {
    for (const s of all) {
      if (!devices.has(s.mac) && !opts.watched.some((d) => d.mac === s.mac)) {
        devices.set(s.mac, { name: s.hostname || s.mac, interface: "", keepUserName: true });
      }
    }
  }
  if (devices.size) {
    await w.folder("devices", "Devices");
  }
  for (const [mac, d] of devices) {
    const s = sightings.get(mac);
    const iface = d.interface && ((_c = ifaceIds.get(d.interface.toLowerCase())) != null ? _c : d.interface) || (s == null ? void 0 : s.interface) || "";
    if (iface) {
      wake.set(mac, iface);
    }
    const p = `devices.${(0, import_util.macId)(mac)}`;
    await w.device(p, d.name, { mac }, d.keepUserName);
    const { present, lastSeen } = opts.tracker.update(mac, !!(s == null ? void 0 : s.online), ctx.now);
    await w.state(`${p}.present`, indicator("Present", "indicator.reachable"), present);
    await w.state(`${p}.lastSeen`, { name: "Last seen", type: "number", role: "date" }, lastSeen);
    await w.state(`${p}.mac`, { name: "MAC address", type: "string", role: "info.mac" }, mac);
    await w.state(`${p}.ip`, { name: "IP address", type: "string", role: "info.ip" }, s == null ? void 0 : s.ip);
    await w.state(`${p}.hostname`, text("Host name"), s == null ? void 0 : s.hostname);
    await w.state(`${p}.interface`, text("Interface"), iface || void 0);
    await w.state(
      `${p}.leaseEnds`,
      { name: "Lease ends", type: "number", role: "date" },
      (0, import_util.parseLeaseTime)(s == null ? void 0 : s.leaseEnds)
    );
    await w.defineState(`${p}.wake`, button("Wake-on-LAN"));
  }
  return { wake, sightings: all, ifaceIds };
}
function configuredMacs(watched) {
  return new Set(watched.map((d) => d.mac));
}
function parseWatched(rows) {
  var _a, _b, _c;
  if (!Array.isArray(rows)) {
    return [];
  }
  const out = [];
  for (const r of rows) {
    const mac = (0, import_util.normalizeMac)(r == null ? void 0 : r.mac);
    if (!mac || out.some((d) => d.mac === mac)) {
      continue;
    }
    out.push({
      enabled: r.enabled !== false,
      name: ((_a = (0, import_util.toStr)(r.name)) == null ? void 0 : _a.trim()) || mac,
      mac,
      interface: (_c = (_b = (0, import_util.toStr)(r.interface)) == null ? void 0 : _b.trim()) != null ? _c : ""
    });
  }
  return out;
}
const WG_HANDSHAKE_WINDOW_S = 180;
async function pollVpn(ctx) {
  var _a, _b, _c, _d, _e;
  const { w } = ctx;
  const ovpnServers = await ctx.fetch("/api/v2/status/openvpn/servers");
  const ovpnClients = await ctx.fetch("/api/v2/status/openvpn/clients");
  const wg = await ctx.fetch("/api/v2/status/wireguard/tunnels");
  const p1 = await ctx.fetch("/api/v2/vpn/ipsec/phase1s");
  const sas = Array.isArray(p1) && p1.length ? await ctx.fetch("/api/v2/status/ipsec/sas") : [];
  const any = [ovpnServers, ovpnClients, wg, p1].some((l) => Array.isArray(l) && l.length > 0);
  if (!any && !ctx.w.has("vpn")) {
    return;
  }
  await w.folder("vpn", "VPN");
  if (Array.isArray(ovpnServers) || Array.isArray(ovpnClients)) {
    await w.folder("vpn.openvpn", "OpenVPN");
  }
  if (Array.isArray(ovpnServers)) {
    await w.folder("vpn.openvpn.servers", "Servers");
    const keys = [];
    for (const s of ovpnServers) {
      const key = `server${(_b = (0, import_util.toNumber)(s.vpnid)) != null ? _b : (0, import_util.sanitizeId)((_a = s.name) != null ? _a : "x")}`;
      keys.push(key);
      const p = `vpn.openvpn.servers.${key}`;
      const conns = Array.isArray(s.conns) ? s.conns : [];
      await w.channel(p, (0, import_util.toStr)(s.name) || key);
      await w.state(`${p}.name`, text("Name"), (0, import_util.toStr)(s.name));
      await w.state(`${p}.mode`, text("Mode"), (0, import_util.toStr)(s.mode));
      await w.state(`${p}.port`, { name: "Port", type: "number", role: "info.port" }, (0, import_util.toNumber)(s.port));
      await w.state(`${p}.clientCount`, num("Connected clients"), conns.length);
      const clients = conns.map((c) => ({
        commonName: c.common_name,
        // certificate-only logins report the placeholder "UNDEF"
        user: c.user_name && c.user_name !== "UNDEF" ? c.user_name : void 0,
        remoteHost: c.remote_host,
        virtualAddress: c.virtual_addr,
        bytesReceived: c.bytes_recv,
        bytesSent: c.bytes_sent,
        connectedSince: (0, import_util.toNumber)(c.connect_time_unix) !== void 0 ? (0, import_util.toNumber)(c.connect_time_unix) * 1e3 : void 0
      }));
      await w.state(`${p}.clients`, json("Connected clients (JSON)"), JSON.stringify(clients));
    }
    await w.removeStale("vpn.openvpn.servers", keys);
  }
  if (Array.isArray(ovpnClients)) {
    await w.folder("vpn.openvpn.clients", "Clients");
    const keys = [];
    for (const c of ovpnClients) {
      const key = `client${(_d = (0, import_util.toNumber)(c.vpnid)) != null ? _d : (0, import_util.sanitizeId)((_c = c.name) != null ? _c : "x")}`;
      keys.push(key);
      const p = `vpn.openvpn.clients.${key}`;
      const state = (0, import_util.toStr)(c.state);
      await w.channel(p, (0, import_util.toStr)(c.name) || key);
      await w.state(`${p}.name`, text("Name"), (0, import_util.toStr)(c.name));
      await w.state(`${p}.status`, text("Status"), (0, import_util.toStr)(c.status));
      await w.state(`${p}.state`, text("State"), state);
      await w.state(`${p}.stateDetail`, text("State detail"), (0, import_util.toStr)(c.state_detail));
      await w.state(
        `${p}.connected`,
        indicator("Connected", "indicator.reachable"),
        state === void 0 ? void 0 : /^connected$/i.test(state)
      );
      await w.state(`${p}.connectedSince`, text("Connected since"), (0, import_util.toStr)(c.connect_time));
      await w.state(`${p}.virtualAddress`, text("Tunnel address"), (0, import_util.toStr)(c.virtual_addr));
      await w.state(`${p}.remoteHost`, text("Remote host"), (0, import_util.toStr)(c.remote_host));
    }
    await w.removeStale("vpn.openvpn.clients", keys);
  }
  if (Array.isArray(wg)) {
    await w.folder("vpn.wireguard", "WireGuard");
    const keys = [];
    for (const [key, t] of uniqueKeys(wg, (t2) => {
      var _a2;
      return (_a2 = t2.name) != null ? _a2 : "tunnel";
    })) {
      keys.push(key);
      const p = `vpn.wireguard.${key}`;
      const peers = Array.isArray(t.peers) ? t.peers : [];
      await w.channel(p, (0, import_util.toStr)(t.descr) || (0, import_util.toStr)(t.name) || key);
      await w.state(`${p}.description`, text("Description"), (0, import_util.toStr)(t.descr));
      await w.state(`${p}.up`, indicator("Tunnel up"), t.status === void 0 ? void 0 : t.status === "up");
      await w.state(
        `${p}.listenPort`,
        { name: "Listen port", type: "number", role: "info.port" },
        (0, import_util.toNumber)(t.listen_port)
      );
      await w.state(`${p}.rxBytes`, num("Received", "B"), (0, import_util.toNumber)(t.transfer_rx));
      await w.state(`${p}.txBytes`, num("Sent", "B"), (0, import_util.toNumber)(t.transfer_tx));
      await w.state(`${p}.peerCount`, num("Peers"), peers.length);
      const nowS = Math.floor(ctx.now / 1e3);
      await w.state(
        `${p}.connectedPeers`,
        num("Peers with recent handshake"),
        peers.filter((x) => {
          var _a2;
          return ((_a2 = (0, import_util.toNumber)(x.latest_handshake)) != null ? _a2 : 0) > nowS - WG_HANDSHAKE_WINDOW_S;
        }).length
      );
      await w.folder(`${p}.peers`, "Peers");
      const peerKeys = [];
      for (const [pk, peer] of uniqueKeys(peers, (x) => {
        var _a2;
        return ((_a2 = x.public_key) != null ? _a2 : "peer").slice(0, 16);
      })) {
        peerKeys.push(pk);
        const pp = `${p}.peers.${pk}`;
        const hs = (0, import_util.toNumber)(peer.latest_handshake);
        await w.channel(pp, (0, import_util.toStr)(peer.descr) || (0, import_util.toStr)(peer.public_key) || pk);
        await w.state(`${pp}.description`, text("Description"), (0, import_util.toStr)(peer.descr));
        await w.state(`${pp}.publicKey`, text("Public key"), (0, import_util.toStr)(peer.public_key));
        await w.state(`${pp}.endpoint`, text("Endpoint"), (0, import_util.toStr)(peer.endpoint));
        await w.state(
          `${pp}.connected`,
          indicator("Connected (recent handshake)", "indicator.reachable"),
          hs === void 0 ? void 0 : hs > nowS - WG_HANDSHAKE_WINDOW_S
        );
        await w.state(
          `${pp}.latestHandshake`,
          { name: "Latest handshake", type: "number", role: "date" },
          hs ? hs * 1e3 : void 0
        );
        await w.state(`${pp}.rxBytes`, num("Received", "B"), (0, import_util.toNumber)(peer.transfer_rx));
        await w.state(`${pp}.txBytes`, num("Sent", "B"), (0, import_util.toNumber)(peer.transfer_tx));
        await w.state(
          `${pp}.allowedIps`,
          text("Allowed IPs"),
          Array.isArray(peer.allowed_ips) ? peer.allowed_ips.join(", ") : void 0
        );
      }
      await w.removeStale(`${p}.peers`, peerKeys);
    }
    await w.removeStale("vpn.wireguard", keys);
  }
  if (Array.isArray(p1)) {
    await w.folder("vpn.ipsec", "IPsec");
    const keys = [];
    const saList = Array.isArray(sas) ? sas : [];
    for (const t of p1) {
      const ikeid = (0, import_util.toNumber)(t.ikeid);
      if (ikeid === void 0) {
        continue;
      }
      const key = `con${ikeid}`;
      keys.push(key);
      const p = `vpn.ipsec.${key}`;
      const sa = saList.find((x) => {
        var _a2;
        return x.con_id === key || ((_a2 = x.con_id) == null ? void 0 : _a2.startsWith(`${key}_`));
      });
      const state = (0, import_util.toStr)(sa == null ? void 0 : sa.state);
      await w.channel(p, (0, import_util.toStr)(t.descr) || key);
      await w.state(`${p}.description`, text("Description"), (0, import_util.toStr)(t.descr));
      await w.state(`${p}.enabled`, indicator("Enabled"), t.disabled === void 0 ? void 0 : !t.disabled);
      await w.state(`${p}.remoteGateway`, text("Remote gateway"), (0, import_util.toStr)(t.remote_gateway));
      await w.state(`${p}.state`, text("IKE state"), state != null ? state : Array.isArray(sas) ? "DOWN" : void 0);
      await w.state(
        `${p}.connected`,
        indicator("Connected", "indicator.reachable"),
        Array.isArray(sas) ? state === "ESTABLISHED" : void 0
      );
      await w.state(
        `${p}.establishedFor`,
        num("Established for", "s"),
        Array.isArray(sas) ? (_e = (0, import_util.toNumber)(sa == null ? void 0 : sa.established)) != null ? _e : 0 : void 0
      );
      await w.state(
        `${p}.childSaCount`,
        num("Child SAs"),
        Array.isArray(sas) ? Array.isArray(sa == null ? void 0 : sa.child_sas) ? sa.child_sas.length : 0 : void 0
      );
      const children = Array.isArray(sa == null ? void 0 : sa.child_sas) ? sa.child_sas : [];
      const sum = (k) => Array.isArray(sas) ? children.reduce((n, c) => {
        var _a2;
        return n + ((_a2 = (0, import_util.toNumber)(c[k])) != null ? _a2 : 0);
      }, 0) : void 0;
      await w.state(`${p}.rxBytes`, num("Received (current SAs)", "B"), sum("bytes_in"));
      await w.state(`${p}.txBytes`, num("Sent (current SAs)", "B"), sum("bytes_out"));
    }
    await w.removeStale("vpn.ipsec", keys);
  }
}
async function pollCarp(ctx) {
  var _a, _b, _c;
  const { w } = ctx;
  const vips = await ctx.fetch("/api/v2/firewall/virtual_ips");
  const carpVips = Array.isArray(vips) ? vips.filter((v) => v.mode === "carp") : [];
  if (!carpVips.length && !w.has("carp")) {
    return;
  }
  const carp = await ctx.fetch("/api/v2/status/carp");
  await w.channel("carp", "CARP (high availability)");
  if (carp) {
    await w.state("carp.enabled", toggle("CARP enabled", "switch.enable"), (0, import_util.toBool)(carp.enable));
    await w.state("carp.maintenanceMode", toggle("Persistent maintenance mode"), (0, import_util.toBool)(carp.maintenance_mode));
  }
  if (!Array.isArray(vips)) {
    return;
  }
  await w.folder("carp.vips", "CARP virtual IPs");
  const keys = [];
  for (const [key, v] of uniqueKeys(carpVips, (v2) => {
    var _a2, _b2;
    return `${(_a2 = v2.interface) != null ? _a2 : "if"}_vhid${(_b2 = v2.vhid) != null ? _b2 : ""}`;
  })) {
    keys.push(key);
    const p = `carp.vips.${key}`;
    const status = (0, import_util.toStr)((_a = v.carp_status) != null ? _a : void 0);
    await w.channel(p, (0, import_util.toStr)(v.descr) || `${(_b = v.subnet) != null ? _b : ""} (VHID ${(_c = v.vhid) != null ? _c : "?"})`);
    await w.state(`${p}.address`, text("Virtual IP"), (0, import_util.toStr)(v.subnet));
    await w.state(`${p}.interface`, text("Interface"), (0, import_util.toStr)(v.interface));
    await w.state(`${p}.vhid`, num("VHID"), (0, import_util.toNumber)(v.vhid));
    await w.state(`${p}.status`, text("CARP status"), status);
    await w.state(
      `${p}.master`,
      indicator("This node is master"),
      status === void 0 ? void 0 : /^master$/i.test(status)
    );
  }
  await w.removeStale("carp.vips", keys);
}
function ruleMatches(rule, filter) {
  var _a;
  if (!filter) {
    return true;
  }
  return ((_a = rule.descr) != null ? _a : "").toLowerCase().includes(filter.toLowerCase());
}
async function pollFirewallRules(ctx, filter) {
  const { w } = ctx;
  const rules = await ctx.fetch("/api/v2/firewall/rules");
  if (!Array.isArray(rules)) {
    return;
  }
  await w.folder("firewall", "Firewall");
  await w.folder("firewall.rules", "Rules");
  const keys = [];
  for (const r of rules) {
    const tracker = (0, import_util.toNumber)(r.tracker);
    if (tracker === void 0 || !ruleMatches(r, filter)) {
      continue;
    }
    const key = String(tracker);
    keys.push(key);
    const p = `firewall.rules.${key}`;
    const iface = Array.isArray(r.interface) ? r.interface.join(", ") : (0, import_util.toStr)(r.interface);
    await w.channel(p, (0, import_util.toStr)(r.descr) || `Rule ${key}`);
    await w.state(`${p}.description`, text("Description"), (0, import_util.toStr)(r.descr));
    await w.state(`${p}.interface`, text("Interface"), iface);
    await w.state(`${p}.action`, text("Action"), (0, import_util.toStr)(r.type));
    await w.state(`${p}.floating`, indicator("Floating rule"), (0, import_util.toBool)(r.floating));
    await w.state(
      `${p}.enabled`,
      toggle("Rule enabled", "switch.enable"),
      r.disabled === void 0 ? true : !r.disabled
    );
  }
  await w.removeStale("firewall.rules", keys);
}
async function pollFirewallAliases(ctx) {
  const { w } = ctx;
  const aliases = await ctx.fetch("/api/v2/firewall/aliases");
  if (!Array.isArray(aliases)) {
    return;
  }
  await w.folder("firewall", "Firewall");
  await w.folder("firewall.aliases", "Aliases");
  const keys = [];
  for (const [key, a] of uniqueKeys(aliases, (a2) => {
    var _a;
    return (_a = a2.name) != null ? _a : "alias";
  })) {
    keys.push(key);
    const p = `firewall.aliases.${key}`;
    const addresses = Array.isArray(a.address) ? a.address : [];
    await w.channel(p, (0, import_util.toStr)(a.descr) || (0, import_util.toStr)(a.name) || key);
    await w.state(`${p}.name`, text("Alias name"), (0, import_util.toStr)(a.name));
    await w.state(`${p}.type`, text("Type"), (0, import_util.toStr)(a.type));
    await w.state(`${p}.description`, text("Description"), (0, import_util.toStr)(a.descr));
    await w.state(`${p}.entries`, json("Entries (JSON array)"), JSON.stringify(addresses));
    await w.state(`${p}.entryCount`, num("Entries"), addresses.length);
  }
  await w.removeStale("firewall.aliases", keys);
}
async function pollFirewallPending(ctx) {
  const a = await ctx.fetch("/api/v2/firewall/apply");
  if (!a) {
    return;
  }
  await ctx.w.folder("firewall", "Firewall");
  await ctx.w.state(
    "firewall.pendingChanges",
    indicator("Changes waiting to be applied"),
    a.applied === void 0 ? void 0 : !a.applied
  );
  await ctx.w.defineState("firewall.apply", button("Apply pending firewall changes"));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_PROBES_PER_POLL,
  button,
  configuredMacs,
  interfaceIdMap,
  parseWatched,
  pollCarp,
  pollFirewallAliases,
  pollFirewallPending,
  pollFirewallRules,
  pollGateways,
  pollInterfaces,
  pollNetwork,
  pollServices,
  pollSystemInfo,
  pollSystemStatus,
  pollVpn,
  ruleMatches,
  serviceKey,
  toggle
});
//# sourceMappingURL=features.js.map
