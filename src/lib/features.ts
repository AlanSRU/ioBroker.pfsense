import type { Query } from './client';
import type { ObjectWriter, StateSpec } from './objects';
import { collectSightings, type PresenceTracker, type Sighting } from './presence';
import type * as T from './types';
import {
    macId,
    normalizeMac,
    parseLeaseTime,
    parseUptime,
    prefixLength,
    type RateTracker,
    sanitizeId,
    toBool,
    toNumber,
    toStr,
} from './util';

/** What a feature poller needs from the adapter. */
export interface FeatureContext {
    w: ObjectWriter;
    /** GET an endpoint. Resolves undefined when the endpoint is not available on this firewall. */
    fetch<R>(path: string, query?: Query): Promise<R | undefined>;
    rates: RateTracker;
    now: number;
}

// ---- shared state specs -----------------------------------------------------------------

const text = (name: string): StateSpec => ({ name, type: 'string', role: 'text' });
const json = (name: string): StateSpec => ({ name, type: 'string', role: 'json' });
const indicator = (name: string, role = 'indicator'): StateSpec => ({ name, type: 'boolean', role });
const num = (name: string, unit?: string, role = 'value'): StateSpec => ({
    name,
    type: 'number',
    role,
    ...(unit ? { unit } : {}),
});
const percent = (name: string): StateSpec => ({ ...num(name, '%'), min: 0, max: 100 });
export const button = (name: string): StateSpec => ({
    name,
    type: 'boolean',
    role: 'button',
    read: false,
    write: true,
});
export const toggle = (name: string, role = 'switch'): StateSpec => ({ name, type: 'boolean', role, write: true });

/** Gives each item a unique, stable id segment; duplicates get a numeric suffix in list order. */
function uniqueKeys<I>(items: I[], keyOf: (i: I) => string): Array<[string, I]> {
    const seen = new Map<string, number>();
    return items.map(item => {
        const base = sanitizeId(keyOf(item));
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return [n === 1 ? base : `${base}_${n}`, item];
    });
}

// ---- system ---------------------------------------------------------------------------------

/** Slow-changing system facts: pfSense and REST API package versions, host name. */
export async function pollSystemInfo(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const [version, api, host] = [
        await ctx.fetch<T.SystemVersion>('/api/v2/system/version'),
        await ctx.fetch<T.RestApiVersion>('/api/v2/system/restapi/version'),
        await ctx.fetch<T.SystemHostname>('/api/v2/system/hostname'),
    ];
    await w.channel('system', 'System');
    if (version) {
        await w.state(
            'system.version',
            { name: 'pfSense version', type: 'string', role: 'info.firmware' },
            toStr(version.version),
        );
        await w.state('system.buildTime', text('Build time'), toStr(version.buildtime));
    }
    if (api) {
        await w.state('system.apiVersion', text('REST API package version'), toStr(api.current_version));
        await w.state('system.apiLatestVersion', text('Latest REST API package version'), toStr(api.latest_version));
        await w.state(
            'system.apiUpdateAvailable',
            indicator('REST API package update available', 'indicator.maintenance'),
            toBool(api.update_available),
        );
    }
    if (host) {
        const fqdn = [toStr(host.hostname), toStr(host.domain)].filter(Boolean).join('.');
        await w.state('system.hostname', { name: 'Host name', type: 'string', role: 'info.name' }, fqdn || undefined);
    }
}

/** Polls system health. Returns false when the endpoint is unavailable (it is the liveness probe). */
export async function pollSystemStatus(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const s = await ctx.fetch<T.SystemStatus>('/api/v2/status/system');
    if (!s) {
        return;
    }
    await w.channel('system', 'System');
    // virtual machines report an empty serial: blanks are left out rather than shown
    await w.state('system.platform', text('Platform'), toStr(s.platform) || undefined);
    await w.state(
        'system.serial',
        { name: 'Serial number', type: 'string', role: 'info.serial' },
        toStr(s.serial) || undefined,
    );
    await w.state('system.netgateId', text('Netgate device ID'), toStr(s.netgate_id) || undefined);
    await w.state('system.cpuModel', text('CPU model'), toStr(s.cpu_model));
    await w.state('system.cpuCount', num('CPU cores'), toNumber(s.cpu_count));
    await w.state('system.cpuUsage', percent('CPU usage'), toNumber(s.cpu_usage));
    const load = Array.isArray(s.cpu_load_avg) ? s.cpu_load_avg : [];
    await w.state('system.load1', num('Load average (1 min)'), toNumber(load[0]));
    await w.state('system.load5', num('Load average (5 min)'), toNumber(load[1]));
    await w.state('system.load15', num('Load average (15 min)'), toNumber(load[2]));
    await w.state('system.memoryUsage', percent('Memory usage'), toNumber(s.mem_usage));
    await w.state('system.swapUsage', percent('Swap usage'), toNumber(s.swap_usage));
    await w.state('system.diskUsage', percent('Disk usage'), toNumber(s.disk_usage));
    await w.state('system.mbufUsage', percent('Network buffer (mbuf) usage'), toNumber(s.mbuf_usage));
    // Boxes without a sensor report 0 or null; neither is a temperature.
    const temp = toNumber(s.temp_c);
    await w.state('system.temperature', num('Temperature', '°C', 'value.temperature'), temp ? temp : undefined);
    await w.state('system.uptime', num('Uptime', 's'), parseUptime(s.uptime));
    await w.state('system.uptimeText', text('Uptime (as reported)'), toStr(s.uptime));
    await w.state('system.biosVendor', text('BIOS vendor'), toStr(s.bios_vendor) || undefined);
    await w.state('system.biosVersion', text('BIOS version'), toStr(s.bios_version) || undefined);
    await w.state('system.biosDate', text('BIOS date'), toStr(s.bios_date) || undefined);
}

// ---- interfaces & gateways -------------------------------------------------------------------

/** Interface status, addresses, counters and computed traffic rates. */
export async function pollInterfaces(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const list = await ctx.fetch<T.InterfaceStats[]>('/api/v2/status/interfaces');
    if (!Array.isArray(list)) {
        return;
    }
    await w.folder('interfaces', 'Interfaces');
    const keys: string[] = [];
    for (const [key, i] of uniqueKeys(list, i => i.name ?? i.hwif ?? 'interface')) {
        keys.push(key);
        const p = `interfaces.${key}`;
        await w.channel(p, toStr(i.descr) || toStr(i.name) || key);
        await w.state(`${p}.name`, text('Interface id'), toStr(i.name));
        await w.state(`${p}.description`, text('Description'), toStr(i.descr));
        await w.state(`${p}.device`, text('Hardware interface'), toStr(i.hwif));
        // `enable` is unreliable in the API (false on interfaces that are clearly in use), so it is not exposed
        await w.state(`${p}.status`, text('Link status'), toStr(i.status));
        const status = toStr(i.status);
        await w.state(`${p}.up`, indicator('Link up'), status === undefined ? undefined : /^up$/i.test(status));
        await w.state(`${p}.ipv4`, { name: 'IPv4 address', type: 'string', role: 'info.ip' }, toStr(i.ipaddr));
        await w.state(`${p}.subnetv4`, num('IPv4 prefix length'), prefixLength(i.subnet));
        await w.state(`${p}.ipv6`, text('IPv6 address'), toStr(i.ipaddrv6));
        await w.state(`${p}.subnetv6`, num('IPv6 prefix length'), prefixLength(i.subnetv6));
        await w.state(`${p}.mac`, { name: 'MAC address', type: 'string', role: 'info.mac' }, toStr(i.macaddr));
        await w.state(`${p}.mtu`, num('MTU'), toNumber(i.mtu));
        await w.state(`${p}.media`, text('Media (speed/duplex)'), toStr(i.media));
        await w.state(`${p}.gateway`, text('IPv4 gateway'), toStr(i.gateway));
        const inBytes = toNumber(i.inbytes);
        const outBytes = toNumber(i.outbytes);
        await w.state(`${p}.rxBytes`, num('Received', 'B'), inBytes);
        await w.state(`${p}.txBytes`, num('Sent', 'B'), outBytes);
        await w.state(`${p}.rxPackets`, num('Packets received'), toNumber(i.inpkts));
        await w.state(`${p}.txPackets`, num('Packets sent'), toNumber(i.outpkts));
        await w.state(`${p}.rxErrors`, num('Receive errors'), toNumber(i.inerrs));
        await w.state(`${p}.txErrors`, num('Send errors'), toNumber(i.outerrs));
        await w.state(`${p}.collisions`, num('Collisions'), toNumber(i.collisions));
        await w.state(
            `${p}.rxRate`,
            num('Receive rate', 'bit/s'),
            ctx.rates.bitsPerSecond(`${p}.rx`, inBytes, ctx.now),
        );
        await w.state(`${p}.txRate`, num('Send rate', 'bit/s'), ctx.rates.bitsPerSecond(`${p}.tx`, outBytes, ctx.now));
    }
    for (const gone of await w.removeStale('interfaces', keys)) {
        ctx.rates.forget(`interfaces.${gone}.`);
    }
}

/** Gateway states that pfSense uses for a gateway it considers unusable. */
const GATEWAY_DOWN = /down|offline/i;

/** Gateway monitoring: status, latency, packet loss. */
export async function pollGateways(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const list = await ctx.fetch<T.GatewayStatus[]>('/api/v2/status/gateways');
    if (!Array.isArray(list)) {
        return;
    }
    await w.folder('gateways', 'Gateways');
    const keys: string[] = [];
    for (const [key, g] of uniqueKeys(list, g => g.name ?? 'gateway')) {
        keys.push(key);
        const p = `gateways.${key}`;
        await w.channel(p, toStr(g.name) || key);
        const status = toStr(g.status);
        await w.state(`${p}.status`, text('Status'), status);
        await w.state(
            `${p}.online`,
            indicator('Online', 'indicator.reachable'),
            status === undefined ? undefined : !GATEWAY_DOWN.test(status),
        );
        await w.state(`${p}.substatus`, text('Sub-status'), toStr(g.substatus));
        await w.state(`${p}.latency`, num('Latency', 'ms'), toNumber(g.delay));
        await w.state(`${p}.latencyStdDev`, num('Latency standard deviation', 'ms'), toNumber(g.stddev));
        await w.state(`${p}.packetLoss`, percent('Packet loss'), toNumber(g.loss));
        await w.state(`${p}.monitorIp`, text('Monitor IP'), toStr(g.monitorip));
        await w.state(`${p}.sourceIp`, text('Source IP'), toStr(g.srcip));
    }
    await w.removeStale('gateways', keys);
}

// ---- services -----------------------------------------------------------------------------

/** Maps the object key of a service to what the API needs to address it. */
export type ServiceIndex = Map<
    string,
    {
        id?: number;
        name: string;
        description?: string;
    }
>;

/** Base object key of a service (its daemon name). */
export function serviceKey(s: T.Service): string {
    return s.name ?? 'service';
}

/** Service list with running state, and start/stop/restart buttons when control is allowed. */
export async function pollServices(ctx: FeatureContext, allowControl: boolean): Promise<ServiceIndex | undefined> {
    const { w } = ctx;
    const list = await ctx.fetch<T.Service[]>('/api/v2/status/services');
    if (!Array.isArray(list)) {
        return undefined;
    }
    const index: ServiceIndex = new Map();
    await w.folder('services', 'Services');
    // Several instances of one daemon (e.g. two OpenVPN servers) share a name; the description tells them apart.
    const names = list.map(serviceKey);
    const keyed = uniqueKeys(list, s => {
        const name = serviceKey(s);
        return names.filter(n => n === name).length > 1 && s.description ? `${name}_${s.description}` : name;
    });
    for (const [key, s] of keyed) {
        index.set(key, { id: toNumber(s.id), name: serviceKey(s), description: toStr(s.description) });
        const p = `services.${key}`;
        await w.channel(p, toStr(s.description) || serviceKey(s));
        await w.state(`${p}.name`, text('Service name'), toStr(s.name));
        await w.state(`${p}.description`, text('Description'), toStr(s.description));
        await w.state(`${p}.enabled`, indicator('Enabled'), toBool(s.enabled));
        await w.state(`${p}.running`, indicator('Running', 'indicator.working'), toBool(s.status));
        if (allowControl) {
            await w.defineState(`${p}.start`, button('Start service'));
            await w.defineState(`${p}.stop`, button('Stop service'));
            await w.defineState(`${p}.restart`, button('Restart service'));
        }
    }
    await w.removeStale('services', index.keys());
    return index;
}

// ---- DHCP, ARP and presence ----------------------------------------------------------------

/** A row of the presence list in the instance settings. */
export interface WatchedDevice {
    enabled: boolean;
    name: string;
    mac: string;
    interface: string;
}

/** Presence settings and state passed to {@link pollNetwork}. */
export interface PresenceOptions {
    watched: WatchedDevice[];
    trackAll: boolean;
    tracker: PresenceTracker;
}

/** What Wake-on-LAN needs: the pfSense interface a MAC was last seen on. */
export type WakeIndex = Map<string, string>;

/** Maps interface id, description and hardware name (case-insensitive) to the pfSense interface id. */
export function interfaceIdMap(list: T.InterfaceStats[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const i of list) {
        const id = toStr(i.name);
        if (!id) {
            continue;
        }
        for (const label of [i.name, i.descr, i.hwif]) {
            if (typeof label === 'string' && label) {
                m.set(label.toLowerCase(), id);
            }
        }
    }
    return m;
}

/** DHCP leases and ARP table: host summary, presence devices and the Wake-on-LAN lookup. */
export async function pollNetwork(
    ctx: FeatureContext,
    opts: PresenceOptions,
): Promise<
    | {
          wake: WakeIndex;
          sightings: Sighting[];
          ifaceIds: Map<string, string>;
      }
    | undefined
> {
    const { w } = ctx;
    const leases = await ctx.fetch<T.DhcpLease[]>('/api/v2/status/dhcp_server/leases');
    const arp = await ctx.fetch<T.ArpEntry[]>('/api/v2/diagnostics/arp_table');
    if (!Array.isArray(leases) && !Array.isArray(arp)) {
        return undefined;
    }
    // The ARP table names interfaces by description ("LAN"); Wake-on-LAN needs the id ("lan").
    const ifaces =
        Array.isArray(arp) && arp.length ? await ctx.fetch<T.InterfaceStats[]>('/api/v2/status/interfaces') : undefined;
    const ifaceIds = interfaceIdMap(Array.isArray(ifaces) ? ifaces : []);
    const sightings = collectSightings(Array.isArray(leases) ? leases : [], Array.isArray(arp) ? arp : [], ifaceIds);
    const all = [...sightings.values()].sort((a, b) => a.mac.localeCompare(b.mac));

    await w.folder('network', 'Network');
    if (Array.isArray(leases)) {
        await w.state('network.leaseCount', num('DHCP leases'), leases.length);
    }
    if (Array.isArray(arp)) {
        await w.state('network.arpCount', num('ARP table entries'), arp.length);
    }
    await w.state('network.onlineCount', num('Hosts online'), all.filter(s => s.online).length);
    await w.state('network.hosts', json('Known hosts (JSON)'), JSON.stringify(all));

    const wake: WakeIndex = new Map();
    for (const s of all) {
        if (s.interface) {
            wake.set(s.mac, s.interface);
        }
    }

    // Watched devices first (their name and interface come from the configuration), then every other host if asked.
    const devices = new Map<
        string,
        {
            name: string;
            interface: string;
            keepUserName: boolean;
        }
    >();
    for (const d of opts.watched) {
        if (d.enabled) {
            devices.set(d.mac, { name: d.name, interface: d.interface, keepUserName: false });
        }
    }
    if (opts.trackAll) {
        for (const s of all) {
            if (!devices.has(s.mac) && !opts.watched.some(d => d.mac === s.mac)) {
                devices.set(s.mac, { name: s.hostname || s.mac, interface: '', keepUserName: true });
            }
        }
    }
    if (devices.size) {
        await w.folder('devices', 'Devices');
    }
    for (const [mac, d] of devices) {
        const s = sightings.get(mac);
        const iface = (d.interface && (ifaceIds.get(d.interface.toLowerCase()) ?? d.interface)) || s?.interface || '';
        if (iface) {
            wake.set(mac, iface);
        }
        const p = `devices.${macId(mac)}`;
        await w.device(p, d.name, { mac }, d.keepUserName);
        const { present, lastSeen } = opts.tracker.update(mac, !!s?.online, ctx.now);
        await w.state(`${p}.present`, indicator('Present', 'indicator.reachable'), present);
        await w.state(`${p}.lastSeen`, { name: 'Last seen', type: 'number', role: 'date' }, lastSeen);
        await w.state(`${p}.mac`, { name: 'MAC address', type: 'string', role: 'info.mac' }, mac);
        await w.state(`${p}.ip`, { name: 'IP address', type: 'string', role: 'info.ip' }, s?.ip);
        await w.state(`${p}.hostname`, text('Host name'), s?.hostname);
        await w.state(`${p}.interface`, text('Interface'), iface || undefined);
        await w.state(
            `${p}.leaseEnds`,
            { name: 'Lease ends', type: 'number', role: 'date' },
            parseLeaseTime(s?.leaseEnds),
        );
        await w.defineState(`${p}.wake`, button('Wake-on-LAN'));
    }
    return { wake, sightings: all, ifaceIds };
}

/** MACs of configured devices; anything else under `devices` was removed from the list (or auto-tracked). */
export function configuredMacs(watched: WatchedDevice[]): Set<string> {
    return new Set(watched.map(d => d.mac));
}

/** Validates the presence list from the configuration: drops rows without a valid MAC and duplicates. */
export function parseWatched(rows: unknown): WatchedDevice[] {
    if (!Array.isArray(rows)) {
        return [];
    }
    const out: WatchedDevice[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
        const mac = normalizeMac(r?.mac);
        if (!mac || out.some(d => d.mac === mac)) {
            continue;
        }
        out.push({
            enabled: r.enabled !== false,
            name: toStr(r.name)?.trim() || mac,
            mac,
            interface: toStr(r.interface)?.trim() ?? '',
        });
    }
    return out;
}

// ---- VPN ------------------------------------------------------------------------------------

/** A WireGuard peer counts as connected when it completed a handshake within this window (WireGuard rekeys every 2 minutes). */
const WG_HANDSHAKE_WINDOW_S = 180;

/** OpenVPN servers and clients, WireGuard tunnels and peers, IPsec tunnels. */
export async function pollVpn(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const ovpnServers = await ctx.fetch<T.OpenVpnServerStatus[]>('/api/v2/status/openvpn/servers');
    const ovpnClients = await ctx.fetch<T.OpenVpnClientStatus[]>('/api/v2/status/openvpn/clients');
    const wg = await ctx.fetch<T.WireGuardTunnelStatus[]>('/api/v2/status/wireguard/tunnels');
    const p1 = await ctx.fetch<T.IpsecPhase1[]>('/api/v2/vpn/ipsec/phase1s');
    const sas = Array.isArray(p1) && p1.length ? await ctx.fetch<T.IpsecSa[]>('/api/v2/status/ipsec/sas') : [];

    const any = [ovpnServers, ovpnClients, wg, p1].some(l => Array.isArray(l) && l.length > 0);
    if (!any && !ctx.w.has('vpn')) {
        return;
    }
    await w.folder('vpn', 'VPN');

    if (Array.isArray(ovpnServers) || Array.isArray(ovpnClients)) {
        await w.folder('vpn.openvpn', 'OpenVPN');
    }
    if (Array.isArray(ovpnServers)) {
        await w.folder('vpn.openvpn.servers', 'Servers');
        const keys: string[] = [];
        for (const s of ovpnServers) {
            const key = `server${toNumber(s.vpnid) ?? sanitizeId(s.name ?? 'x')}`;
            keys.push(key);
            const p = `vpn.openvpn.servers.${key}`;
            const conns = Array.isArray(s.conns) ? s.conns : [];
            await w.channel(p, toStr(s.name) || key);
            await w.state(`${p}.name`, text('Name'), toStr(s.name));
            await w.state(`${p}.mode`, text('Mode'), toStr(s.mode));
            await w.state(`${p}.port`, { name: 'Port', type: 'number', role: 'info.port' }, toNumber(s.port));
            await w.state(`${p}.clientCount`, num('Connected clients'), conns.length);
            const clients = conns.map(c => ({
                commonName: c.common_name,
                user: c.user_name,
                remoteHost: c.remote_host,
                virtualAddress: c.virtual_addr,
                bytesReceived: c.bytes_recv,
                bytesSent: c.bytes_sent,
                connectedSince:
                    toNumber(c.connect_time_unix) !== undefined ? toNumber(c.connect_time_unix)! * 1000 : undefined,
            }));
            await w.state(`${p}.clients`, json('Connected clients (JSON)'), JSON.stringify(clients));
        }
        await w.removeStale('vpn.openvpn.servers', keys);
    }
    if (Array.isArray(ovpnClients)) {
        await w.folder('vpn.openvpn.clients', 'Clients');
        const keys: string[] = [];
        for (const c of ovpnClients) {
            const key = `client${toNumber(c.vpnid) ?? sanitizeId(c.name ?? 'x')}`;
            keys.push(key);
            const p = `vpn.openvpn.clients.${key}`;
            const state = toStr(c.state);
            await w.channel(p, toStr(c.name) || key);
            await w.state(`${p}.name`, text('Name'), toStr(c.name));
            await w.state(`${p}.status`, text('Status'), toStr(c.status));
            await w.state(`${p}.state`, text('State'), state);
            await w.state(`${p}.stateDetail`, text('State detail'), toStr(c.state_detail));
            await w.state(
                `${p}.connected`,
                indicator('Connected', 'indicator.reachable'),
                state === undefined ? undefined : /^connected$/i.test(state),
            );
            await w.state(`${p}.connectedSince`, text('Connected since'), toStr(c.connect_time));
            await w.state(`${p}.virtualAddress`, text('Tunnel address'), toStr(c.virtual_addr));
            await w.state(`${p}.remoteHost`, text('Remote host'), toStr(c.remote_host));
        }
        await w.removeStale('vpn.openvpn.clients', keys);
    }

    if (Array.isArray(wg)) {
        await w.folder('vpn.wireguard', 'WireGuard');
        const keys: string[] = [];
        for (const [key, t] of uniqueKeys(wg, t => t.name ?? 'tunnel')) {
            keys.push(key);
            const p = `vpn.wireguard.${key}`;
            const peers = Array.isArray(t.peers) ? t.peers : [];
            await w.channel(p, toStr(t.descr) || toStr(t.name) || key);
            await w.state(`${p}.description`, text('Description'), toStr(t.descr));
            await w.state(`${p}.up`, indicator('Tunnel up'), t.status === undefined ? undefined : t.status === 'up');
            await w.state(
                `${p}.listenPort`,
                { name: 'Listen port', type: 'number', role: 'info.port' },
                toNumber(t.listen_port),
            );
            await w.state(`${p}.rxBytes`, num('Received', 'B'), toNumber(t.transfer_rx));
            await w.state(`${p}.txBytes`, num('Sent', 'B'), toNumber(t.transfer_tx));
            await w.state(`${p}.peerCount`, num('Peers'), peers.length);
            const nowS = Math.floor(ctx.now / 1000);
            await w.state(
                `${p}.connectedPeers`,
                num('Peers with recent handshake'),
                peers.filter(x => (toNumber(x.latest_handshake) ?? 0) > nowS - WG_HANDSHAKE_WINDOW_S).length,
            );
            await w.folder(`${p}.peers`, 'Peers');
            const peerKeys: string[] = [];
            // The public key is the only stable identity of a peer; its first 16 characters are unique in practice.
            for (const [pk, peer] of uniqueKeys(peers, x => (x.public_key ?? 'peer').slice(0, 16))) {
                peerKeys.push(pk);
                const pp = `${p}.peers.${pk}`;
                const hs = toNumber(peer.latest_handshake);
                await w.channel(pp, toStr(peer.descr) || toStr(peer.public_key) || pk);
                await w.state(`${pp}.description`, text('Description'), toStr(peer.descr));
                await w.state(`${pp}.publicKey`, text('Public key'), toStr(peer.public_key));
                await w.state(`${pp}.endpoint`, text('Endpoint'), toStr(peer.endpoint));
                await w.state(
                    `${pp}.connected`,
                    indicator('Connected (recent handshake)', 'indicator.reachable'),
                    hs === undefined ? undefined : hs > nowS - WG_HANDSHAKE_WINDOW_S,
                );
                await w.state(
                    `${pp}.latestHandshake`,
                    { name: 'Latest handshake', type: 'number', role: 'date' },
                    hs ? hs * 1000 : undefined,
                );
                await w.state(`${pp}.rxBytes`, num('Received', 'B'), toNumber(peer.transfer_rx));
                await w.state(`${pp}.txBytes`, num('Sent', 'B'), toNumber(peer.transfer_tx));
                await w.state(
                    `${pp}.allowedIps`,
                    text('Allowed IPs'),
                    Array.isArray(peer.allowed_ips) ? peer.allowed_ips.join(', ') : undefined,
                );
            }
            await w.removeStale(`${p}.peers`, peerKeys);
        }
        await w.removeStale('vpn.wireguard', keys);
    }

    if (Array.isArray(p1)) {
        await w.folder('vpn.ipsec', 'IPsec');
        const keys: string[] = [];
        const saList = Array.isArray(sas) ? sas : [];
        for (const t of p1) {
            const ikeid = toNumber(t.ikeid);
            if (ikeid === undefined) {
                continue;
            }
            const key = `con${ikeid}`;
            keys.push(key);
            const p = `vpn.ipsec.${key}`;
            // Only established tunnels have an SA; a configured tunnel without one is down.
            const sa = saList.find(x => x.con_id === key || x.con_id?.startsWith(`${key}_`));
            const state = toStr(sa?.state);
            await w.channel(p, toStr(t.descr) || key);
            await w.state(`${p}.description`, text('Description'), toStr(t.descr));
            await w.state(`${p}.enabled`, indicator('Enabled'), t.disabled === undefined ? undefined : !t.disabled);
            await w.state(`${p}.remoteGateway`, text('Remote gateway'), toStr(t.remote_gateway));
            await w.state(`${p}.state`, text('IKE state'), state ?? (Array.isArray(sas) ? 'DOWN' : undefined));
            await w.state(
                `${p}.connected`,
                indicator('Connected', 'indicator.reachable'),
                Array.isArray(sas) ? state === 'ESTABLISHED' : undefined,
            );
            await w.state(
                `${p}.establishedFor`,
                num('Established for', 's'),
                Array.isArray(sas) ? (toNumber(sa?.established) ?? 0) : undefined,
            );
            await w.state(
                `${p}.childSaCount`,
                num('Child SAs'),
                Array.isArray(sas) ? (Array.isArray(sa?.child_sas) ? sa.child_sas.length : 0) : undefined,
            );
        }
        await w.removeStale('vpn.ipsec', keys);
    }
}

// ---- CARP -----------------------------------------------------------------------------------

/** CARP: global switches and per-VIP master/backup status. Skipped when the firewall has no CARP VIPs. */
export async function pollCarp(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const vips = await ctx.fetch<T.VirtualIp[]>('/api/v2/firewall/virtual_ips');
    const carpVips = Array.isArray(vips) ? vips.filter(v => v.mode === 'carp') : [];
    if (!carpVips.length && !w.has('carp')) {
        return; // no CARP on this firewall: keep the tree clean
    }
    const carp = await ctx.fetch<T.Carp>('/api/v2/status/carp');
    await w.channel('carp', 'CARP (high availability)');
    if (carp) {
        await w.state('carp.enabled', toggle('CARP enabled', 'switch.enable'), toBool(carp.enable));
        await w.state('carp.maintenanceMode', toggle('Persistent maintenance mode'), toBool(carp.maintenance_mode));
    }
    if (!Array.isArray(vips)) {
        return;
    }
    await w.folder('carp.vips', 'CARP virtual IPs');
    const keys: string[] = [];
    for (const [key, v] of uniqueKeys(carpVips, v => `${v.interface ?? 'if'}_vhid${v.vhid ?? ''}`)) {
        keys.push(key);
        const p = `carp.vips.${key}`;
        const status = toStr(v.carp_status ?? undefined);
        await w.channel(p, toStr(v.descr) || `${v.subnet ?? ''} (VHID ${v.vhid ?? '?'})`);
        await w.state(`${p}.address`, text('Virtual IP'), toStr(v.subnet));
        await w.state(`${p}.interface`, text('Interface'), toStr(v.interface));
        await w.state(`${p}.vhid`, num('VHID'), toNumber(v.vhid));
        await w.state(`${p}.status`, text('CARP status'), status);
        await w.state(
            `${p}.master`,
            indicator('This node is master'),
            status === undefined ? undefined : /^master$/i.test(status),
        );
    }
    await w.removeStale('carp.vips', keys);
}

// ---- firewall -------------------------------------------------------------------------------

/** True when the rule description contains the filter text (case-insensitive); an empty filter matches all. */
export function ruleMatches(rule: T.FirewallRule, filter: string): boolean {
    if (!filter) {
        return true;
    }
    return (rule.descr ?? '').toLowerCase().includes(filter.toLowerCase());
}

/** Firewall rules, keyed by tracker, each with an enable switch. */
export async function pollFirewallRules(ctx: FeatureContext, filter: string): Promise<void> {
    const { w } = ctx;
    const rules = await ctx.fetch<T.FirewallRule[]>('/api/v2/firewall/rules');
    if (!Array.isArray(rules)) {
        return;
    }
    await w.folder('firewall', 'Firewall');
    await w.folder('firewall.rules', 'Rules');
    const keys: string[] = [];
    for (const r of rules) {
        const tracker = toNumber(r.tracker);
        // The tracker is the only stable rule identity (the API id is the list position); rules without one cannot be addressed.
        if (tracker === undefined || !ruleMatches(r, filter)) {
            continue;
        }
        const key = String(tracker);
        keys.push(key);
        const p = `firewall.rules.${key}`;
        const iface = Array.isArray(r.interface) ? r.interface.join(', ') : toStr(r.interface);
        await w.channel(p, toStr(r.descr) || `Rule ${key}`);
        await w.state(`${p}.description`, text('Description'), toStr(r.descr));
        await w.state(`${p}.interface`, text('Interface'), iface);
        await w.state(`${p}.action`, text('Action'), toStr(r.type));
        await w.state(`${p}.floating`, indicator('Floating rule'), toBool(r.floating));
        await w.state(
            `${p}.enabled`,
            toggle('Rule enabled', 'switch.enable'),
            r.disabled === undefined ? true : !r.disabled,
        );
    }
    await w.removeStale('firewall.rules', keys);
}

/** Firewall aliases and their entries. */
export async function pollFirewallAliases(ctx: FeatureContext): Promise<void> {
    const { w } = ctx;
    const aliases = await ctx.fetch<T.FirewallAlias[]>('/api/v2/firewall/aliases');
    if (!Array.isArray(aliases)) {
        return;
    }
    await w.folder('firewall', 'Firewall');
    await w.folder('firewall.aliases', 'Aliases');
    const keys: string[] = [];
    for (const [key, a] of uniqueKeys(aliases, a => a.name ?? 'alias')) {
        keys.push(key);
        const p = `firewall.aliases.${key}`;
        const addresses = Array.isArray(a.address) ? a.address : [];
        await w.channel(p, toStr(a.descr) || toStr(a.name) || key);
        await w.state(`${p}.name`, text('Alias name'), toStr(a.name));
        await w.state(`${p}.type`, text('Type'), toStr(a.type));
        await w.state(`${p}.description`, text('Description'), toStr(a.descr));
        await w.state(`${p}.entries`, json('Entries (JSON array)'), JSON.stringify(addresses));
        await w.state(`${p}.entryCount`, num('Entries'), addresses.length);
    }
    await w.removeStale('firewall.aliases', keys);
}

/** Whether firewall changes are waiting to be applied, and the apply button. */
export async function pollFirewallPending(ctx: FeatureContext): Promise<void> {
    const a = await ctx.fetch<T.FirewallApply>('/api/v2/firewall/apply');
    if (!a) {
        return;
    }
    await ctx.w.folder('firewall', 'Firewall');
    await ctx.w.state(
        'firewall.pendingChanges',
        indicator('Changes waiting to be applied'),
        a.applied === undefined ? undefined : !a.applied,
    );
    await ctx.w.defineState('firewall.apply', button('Apply pending firewall changes'));
}
