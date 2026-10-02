import { expect } from 'chai';
import { FakeAdapter } from '../../test/fake-adapter';
import { fixtureData } from '../../test/fixtures/data';
import type { Query } from './client';
import * as F from './features';
import { ObjectWriter } from './objects';
import { PresenceTracker } from './presence';
import { RateTracker } from './util';

/**
 * Role constraints from ioBroker.repochecker lib/config_StateRoles.js (2026-10-02) for every role
 * the adapter uses. A role missing here fails the test: check the checker before adding one.
 */
const ROLES: Record<string, { types: string[]; read?: boolean; write?: boolean }> = {
    text: { types: ['string'] },
    json: { types: ['string', 'json'] },
    indicator: { types: ['boolean'], read: true, write: false },
    'indicator.reachable': { types: ['boolean'], read: true, write: false },
    'indicator.working': { types: ['boolean'], read: true, write: false },
    'indicator.maintenance': { types: ['boolean'], read: true, write: false },
    value: { types: ['number'], read: true, write: false },
    'value.temperature': { types: ['number'], read: true, write: false },
    button: { types: ['boolean'], read: false, write: true },
    switch: { types: ['boolean'], read: true, write: true },
    'switch.enable': { types: ['boolean'], read: true, write: true },
    date: { types: ['string', 'number'], read: true },
    'info.firmware': { types: ['string'], read: true, write: false },
    'info.name': { types: ['string'], read: true, write: false },
    'info.serial': { types: ['string'], read: true, write: false },
    'info.ip': { types: ['string'], read: true, write: false },
    'info.mac': { types: ['string'], read: true, write: false },
    'info.port': { types: ['number'], read: true, write: false },
};

function ctxFor(fa: FakeAdapter, data: Record<string, unknown>, now = Date.now()): F.FeatureContext {
    return {
        w: new ObjectWriter(fa.asAdapter(), () => false),
        rates: new RateTracker(),
        now,
        fetch: <R>(path: string, query?: Query): Promise<R | undefined> => {
            let d = data[path];
            if (Array.isArray(d) && query) {
                d = d.filter((x: Record<string, unknown>) =>
                    Object.entries(query).every(([k, v]) => String(x[k]) === String(v)),
                );
            }
            return Promise.resolve(d as R | undefined);
        },
    };
}

async function pollEverything(fa: FakeAdapter, data = fixtureData(), now = Date.now()): Promise<F.FeatureContext> {
    const ctx = ctxFor(fa, data, now);
    await F.pollSystemInfo(ctx);
    await F.pollSystemStatus(ctx);
    await F.pollInterfaces(ctx);
    await F.pollGateways(ctx);
    await F.pollServices(ctx, true);
    await F.pollNetwork(ctx, {
        watched: F.parseWatched([
            { enabled: true, name: 'Phone', mac: 'AA:BB:CC:00:00:01', interface: '' },
            { enabled: true, name: 'Laptop', mac: 'aa:bb:cc:00:00:02', interface: '' },
        ]),
        trackAll: true,
        tracker: new PresenceTracker(0),
    });
    await F.pollVpn(ctx);
    await F.pollCarp(ctx);
    await F.pollFirewallRules(ctx, '');
    await F.pollFirewallAliases(ctx);
    await F.pollFirewallPending(ctx);
    return ctx;
}

describe('features', () => {
    describe('object tree audit (E3009 and roles)', () => {
        let fa: FakeAdapter;
        before(async () => {
            fa = new FakeAdapter();
            // io-package instanceObjects
            fa.objects.set('info', { type: 'channel', common: { name: 'Information' }, native: {} });
            fa.objects.set('info.connection', {
                type: 'state',
                common: {
                    name: 'c',
                    type: 'boolean',
                    role: 'indicator.connected',
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            const data = fixtureData();
            data['/api/v2/firewall/virtual_ips'] = [
                {
                    mode: 'carp',
                    interface: 'lan',
                    subnet: '10.9.0.254',
                    vhid: 1,
                    carp_status: 'master',
                    carp_mode: 'mcast',
                },
            ];
            await pollEverything(fa, data);
        });

        it('creates a parent object for every dotted id', () => {
            const missing: string[] = [];
            for (const id of fa.objects.keys()) {
                const parts = id.split('.');
                for (let i = 1; i < parts.length; i++) {
                    const parent = parts.slice(0, i).join('.');
                    if (!fa.objects.has(parent)) {
                        missing.push(`${parent} (for ${id})`);
                    }
                }
            }
            expect(missing).to.deep.equal([]);
        });

        it('never puts a device below a channel, nor children below a state', () => {
            for (const [id, obj] of fa.objects) {
                const parts = id.split('.');
                const ancestors = parts.slice(1).map((_, i) => fa.objects.get(parts.slice(0, i + 1).join('.'))?.type);
                if (obj.type === 'device') {
                    expect(ancestors, id).to.not.include('channel');
                    expect(ancestors, id).to.not.include('device');
                }
                expect(ancestors, id).to.not.include('state');
            }
        });

        it('uses only valid roles with matching type and read/write', () => {
            for (const [id, obj] of fa.objects) {
                if (obj.type !== 'state' || id === 'info.connection') {
                    continue;
                }
                const c = obj.common;
                const rule = ROLES[c.role];
                expect(rule, `${id}: role ${c.role}`).to.not.equal(undefined);
                expect(rule.types, `${id}: type`).to.include(c.type);
                if (rule.read !== undefined) {
                    expect(c.read, `${id}: read`).to.equal(rule.read);
                }
                if (rule.write !== undefined) {
                    expect(c.write, `${id}: write`).to.equal(rule.write);
                }
            }
        });

        it('gives every string and boolean state a default', () => {
            for (const [id, obj] of fa.objects) {
                const c = obj.common as ioBroker.StateCommon;
                if (obj.type === 'state' && c.role !== 'button' && (c.type === 'string' || c.type === 'boolean')) {
                    expect(c.def, id).to.not.equal(undefined);
                }
            }
        });

        it('reports CARP master state from the lower-case API value', () => {
            expect(fa.states.get('carp.vips.lan_vhid1.master')).to.equal(true);
            expect(fa.states.get('carp.vips.lan_vhid1.status')).to.equal('master');
        });

        it('only uses safe characters in ids', () => {
            for (const id of fa.objects.keys()) {
                expect(id).to.match(/^[A-Za-z0-9_.-]+$/);
            }
        });
    });

    describe('values', () => {
        let fa: FakeAdapter;
        before(async () => {
            fa = new FakeAdapter();
            await pollEverything(fa);
        });

        it('reports system health', () => {
            expect(fa.states.get('system.version')).to.equal('2.8.1-RELEASE');
            expect(fa.states.get('system.hostname')).to.equal('fw.example.lan');
            expect(fa.states.get('system.uptime')).to.equal(3 * 86400 + 4 * 3600 + 12 * 60 + 5);
            expect(fa.states.get('system.load5')).to.equal(0.2);
            expect(fa.states.get('system.swapUsage')).to.equal(0); // a real zero stays
        });

        it('does not invent a temperature on boxes without a sensor', () => {
            expect(fa.objects.has('system.temperature')).to.equal(false);
        });

        it('leaves out blank and unreliable fields', () => {
            expect(fa.objects.has('system.serial')).to.equal(false); // '' on virtual machines
            expect(fa.objects.has('interfaces.wan.enabled')).to.equal(false);
        });

        it('turns netmasks into prefix lengths', () => {
            expect(fa.states.get('interfaces.wan.subnetv4')).to.equal(24);
            expect(fa.states.get('interfaces.wan.subnetv6')).to.equal(64);
            expect(fa.objects.has('interfaces.lan.subnetv6')).to.equal(false);
        });

        it('resolves the ARP interface description to the id Wake-on-LAN needs', () => {
            expect(fa.states.get('devices.aa_bb_cc_00_00_03.interface')).to.equal('lan');
            expect(fa.states.get('devices.aa_bb_cc_00_00_03.present')).to.equal(true);
        });

        it('keys duplicate service names by description', () => {
            expect(fa.states.get('services.unbound.running')).to.equal(true);
            expect(fa.states.get('services.openvpn_OpenVPN_server_Road_Warrior.running')).to.equal(true);
            expect(fa.states.get('services.openvpn_OpenVPN_client_Office.running')).to.equal(false);
        });

        it('tracks presence from ARP and lease state', () => {
            expect(fa.states.get('devices.aa_bb_cc_00_00_01.present')).to.equal(true);
            expect(fa.states.get('devices.aa_bb_cc_00_00_02.present')).to.equal(false);
            expect(fa.states.get('devices.aa_bb_cc_00_00_01.interface')).to.equal('lan');
            // the firewall's own interface MAC (permanent ARP entry) is not a host
            expect(fa.objects.has('devices.bc_24_11_00_00_02')).to.equal(false);
        });

        it('reports VPN status', () => {
            expect(fa.states.get('vpn.openvpn.servers.server1.clientCount')).to.equal(1);
            expect(fa.states.get('vpn.openvpn.clients.client2.connected')).to.equal(true);
            expect(fa.states.get('vpn.ipsec.con1.connected')).to.equal(true);
            expect(fa.states.get('vpn.wireguard.tun_wg0.up')).to.equal(true);
            expect(fa.states.get('vpn.wireguard.tun_wg0.peers.Abc_def_ghiJKLmn.connected')).to.equal(false);
        });

        it('does not report a latency for a gateway with every probe lost', () => {
            expect(fa.states.get('gateways.TEST_DEAD.online')).to.equal(false);
            expect(fa.states.get('gateways.TEST_DEAD.packetLoss')).to.equal(100);
            expect(fa.objects.has('gateways.TEST_DEAD.latency')).to.equal(false);
            expect(fa.states.get('gateways.WAN_DHCP.latency')).to.equal(0.42);
        });

        it('hides the UNDEF user of certificate-only OpenVPN logins and sums IPsec traffic', () => {
            const clients = JSON.parse(fa.states.get('vpn.openvpn.servers.server1.clients') as string);
            expect(clients[0]).to.not.have.property('user');
            expect(fa.states.get('vpn.ipsec.con1.rxBytes')).to.equal(1000);
            expect(fa.states.get('vpn.ipsec.con1.txBytes')).to.equal(2500);
        });

        it('keys rules by tracker and maps disabled to enabled=false', () => {
            expect(fa.states.get('firewall.rules.1000000101.enabled')).to.equal(true);
            expect(fa.states.get('firewall.rules.1000000102.enabled')).to.equal(false);
        });

        it('skips CARP when there are no CARP VIPs', () => {
            expect(fa.objects.has('carp')).to.equal(false);
        });
    });

    describe('dynamic changes', () => {
        it('computes interface rates across polls', async () => {
            const fa = new FakeAdapter();
            const data = fixtureData();
            const ctx = ctxFor(fa, data, 0);
            await F.pollInterfaces(ctx);
            expect(fa.objects.has('interfaces.wan.rxRate')).to.equal(false);
            (data['/api/v2/status/interfaces'] as Array<{ inbytes: number }>)[0].inbytes += 125_000;
            ctx.now = 10_000;
            await F.pollInterfaces(ctx);
            expect(fa.states.get('interfaces.wan.rxRate')).to.equal(100_000);
        });

        it('removes entities that disappeared from the firewall', async () => {
            const fa = new FakeAdapter();
            const data = fixtureData();
            const ctx = ctxFor(fa, data);
            await F.pollGateways(ctx);
            expect(fa.objects.has('gateways.WAN_DHCP.online')).to.equal(true);
            data['/api/v2/status/gateways'] = [];
            await F.pollGateways(ctx);
            expect(fa.objects.has('gateways.WAN_DHCP')).to.equal(false);
            expect(fa.objects.has('gateways.WAN_DHCP.online')).to.equal(false);
        });

        it('leaves everything alone when an endpoint is unavailable', async () => {
            const fa = new FakeAdapter();
            const data = fixtureData();
            const ctx = ctxFor(fa, data);
            await F.pollGateways(ctx);
            delete data['/api/v2/status/gateways'];
            await F.pollGateways(ctx);
            expect(fa.objects.has('gateways.WAN_DHCP.online')).to.equal(true);
        });

        it('marks a configured IPsec tunnel down when its SA vanishes', async () => {
            const fa = new FakeAdapter();
            const data = fixtureData();
            const ctx = ctxFor(fa, data);
            await F.pollVpn(ctx);
            data['/api/v2/status/ipsec/sas'] = [];
            await F.pollVpn(ctx);
            expect(fa.states.get('vpn.ipsec.con1.connected')).to.equal(false);
            expect(fa.states.get('vpn.ipsec.con1.state')).to.equal('DOWN');
        });

        it('creates no buttons for services the API cannot control (duplicate names)', async () => {
            const fa = new FakeAdapter();
            await F.pollServices(ctxFor(fa, fixtureData()), true);
            expect(fa.objects.has('services.unbound.restart')).to.equal(true);
            expect(fa.objects.has('services.openvpn_OpenVPN_server_Road_Warrior.restart')).to.equal(false);
            expect(fa.states.get('services.openvpn_OpenVPN_server_Road_Warrior.running')).to.equal(true);
        });

        describe('presence probing', () => {
            const MAC = 'aa:bb:cc:00:00:01';
            const opts = (tracker: PresenceTracker, probe?: (ip: string) => Promise<boolean>): F.PresenceOptions => ({
                watched: F.parseWatched([{ enabled: true, name: 'Phone', mac: MAC, interface: 'lan' }]),
                trackAll: false,
                tracker,
                probe,
            });
            const quiet = (): Record<string, unknown> => {
                const d = fixtureData();
                d['/api/v2/status/dhcp_server/leases'] = [];
                d['/api/v2/diagnostics/arp_table'] = [];
                return d;
            };

            it('probes a device in its grace period and keeps it present when it answers', async () => {
                const fa = new FakeAdapter();
                const tracker = new PresenceTracker(120_000);
                await F.pollNetwork(ctxFor(fa, fixtureData(), 0), opts(tracker));
                const probed: string[] = [];
                await F.pollNetwork(
                    ctxFor(fa, quiet(), 60_000),
                    opts(tracker, ip => {
                        probed.push(ip);
                        return Promise.resolve(true);
                    }),
                );
                expect(probed).to.deep.equal(['10.9.0.100']);
                expect(fa.states.get('devices.aa_bb_cc_00_00_01.present')).to.equal(true);
                expect(fa.states.get('devices.aa_bb_cc_00_00_01.lastSeen')).to.equal(60_000);
            });

            it('reports the device away once the grace period ends without an answer', async () => {
                const fa = new FakeAdapter();
                const tracker = new PresenceTracker(120_000);
                await F.pollNetwork(ctxFor(fa, fixtureData(), 0), opts(tracker));
                const probe = (): Promise<boolean> => Promise.resolve(false);
                await F.pollNetwork(ctxFor(fa, quiet(), 60_000), opts(tracker, probe));
                expect(fa.states.get('devices.aa_bb_cc_00_00_01.present')).to.equal(true);
                let calls = 0;
                await F.pollNetwork(
                    ctxFor(fa, quiet(), 200_000),
                    opts(tracker, () => {
                        calls++;
                        return Promise.resolve(false);
                    }),
                );
                expect(fa.states.get('devices.aa_bb_cc_00_00_01.present')).to.equal(false);
                expect(calls, 'no probe once the device is away').to.equal(0);
            });

            it('does not probe devices that are seen, and probes at most a few per poll', async () => {
                const tracker = new PresenceTracker(120_000);
                const many = F.parseWatched(
                    Array.from({ length: 6 }, (_, i) => ({
                        enabled: true,
                        name: `d${i}`,
                        mac: `02:00:00:00:00:0${i}`,
                    })),
                );
                for (const d of many) {
                    tracker.seed(d.mac, 1, `10.0.0.${10 + Number(d.mac.slice(-1))}`);
                }
                let calls = 0;
                const fa = new FakeAdapter();
                await F.pollNetwork(ctxFor(fa, fixtureData(), 50_000), {
                    watched: many,
                    trackAll: false,
                    tracker,
                    probe: () => {
                        calls++;
                        return Promise.resolve(false);
                    },
                });
                expect(calls).to.equal(F.MAX_PROBES_PER_POLL);
                let seenCalls = 0;
                await F.pollNetwork(
                    ctxFor(fa, fixtureData(), 60_000),
                    opts(new PresenceTracker(120_000), () => {
                        seenCalls++;
                        return Promise.resolve(true);
                    }),
                );
                expect(seenCalls, 'device online in ARP is not probed').to.equal(0);
            });
        });

        it('creates no service buttons when control is off', async () => {
            const fa = new FakeAdapter();
            await F.pollServices(ctxFor(fa, fixtureData()), false);
            expect(fa.objects.has('services.unbound.restart')).to.equal(false);
        });

        it('filters rules by description', async () => {
            const fa = new FakeAdapter();
            await F.pollFirewallRules(ctxFor(fa, fixtureData()), '[IOB]');
            expect(fa.objects.has('firewall.rules.1000000102')).to.equal(true);
            expect(fa.objects.has('firewall.rules.1000000101')).to.equal(false);
        });
    });

    it('parseWatched drops invalid and duplicate rows', () => {
        const rows = F.parseWatched([
            { mac: 'aa:bb:cc:dd:ee:ff', name: ' A ' },
            { mac: 'AA-BB-CC-DD-EE-FF', name: 'dup' },
            { mac: 'nope' },
            { mac: '11:22:33:44:55:66', enabled: false },
        ]);
        expect(rows).to.deep.equal([
            { enabled: true, name: 'A', mac: 'aa:bb:cc:dd:ee:ff', interface: '' },
            { enabled: false, name: '11:22:33:44:55:66', mac: '11:22:33:44:55:66', interface: '' },
        ]);
    });
});
