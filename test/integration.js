const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

// The mock firewall is written in TypeScript and shared with the unit tests
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
process.env.TS_NODE_TRANSPILE_ONLY = 'TRUE';
require('ts-node/register');
const { MockPfSense, API_KEY, CERT_FINGERPRINT } = require('./mock-pfsense.ts');
const { fixtureData } = require('./fixtures/data.ts');

/** Waits until `check` returns a truthy value or the time is up. */
async function waitFor(check, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await check();
        if (v) {
            return v;
        }
        if (Date.now() > end) {
            throw new Error('timed out');
        }
        await new Promise(r => setTimeout(r, 250));
    }
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('against a mock pfSense', getHarness => {
            const mock = new MockPfSense();
            let harness;
            let port;

            before(async function () {
                this.timeout(60000);
                port = await mock.start();
                mock.data = fixtureData();
                harness = getHarness();
                await harness.changeAdapterConfig('pfsense', {
                    native: {
                        host: '127.0.0.1',
                        port,
                        tlsMode: 'fingerprint',
                        certFingerprint: CERT_FINGERPRINT,
                        apiKey: API_KEY,
                        intervalFast: 5,
                        intervalStatus: 10,
                        enableFirewallRules: true,
                        enableAliases: true,
                        presenceDevices: [{ enabled: true, name: 'Phone', mac: 'aa:bb:cc:00:00:01', interface: '' }],
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(() => mock.stop());

            it('connects and fills the object tree', async function () {
                this.timeout(30000);
                await waitFor(async () => (await harness.states.getStateAsync('pfsense.0.info.connection'))?.val === true);
                // A new state first holds its default (false / ''), so wait for the polled value, not for the state.
                const valueOf = async id => (await harness.states.getStateAsync(id))?.val;
                const until = (id, expected) => waitFor(async () => (await valueOf(id)) === expected);
                await until('pfsense.0.system.version', '2.8.1-RELEASE');
                await until('pfsense.0.devices.aa_bb_cc_00_00_01.present', true);
                await until('pfsense.0.interfaces.wan.up', true);
                // the rule switch is false both as default and as polled value: wait for its description first
                await until('pfsense.0.firewall.rules.1000000102.description', 'Block kids tablet [iob]');
                expect(await valueOf('pfsense.0.firewall.rules.1000000102.enabled')).to.equal(false);
            });

            it('restarts a service on command', async function () {
                this.timeout(20000);
                await waitFor(() => harness.objects.getObjectAsync('pfsense.0.services.unbound.restart'));
                await harness.states.setStateAsync('pfsense.0.services.unbound.restart', { val: true, ack: false });
                const call = await waitFor(() => mock.calls('POST', '/api/v2/status/service')[0]);
                expect(call.body).to.deep.include({ action: 'restart' });
            });

            it('switches a firewall rule by tracker and applies', async function () {
                this.timeout(20000);
                await harness.states.setStateAsync('pfsense.0.firewall.rules.1000000102.enabled', { val: true, ack: false });
                const patch = await waitFor(() => mock.calls('PATCH', '/api/v2/firewall/rule')[0]);
                expect(patch.body).to.deep.equal({ id: 1, disabled: false });
                await waitFor(() => mock.calls('POST', '/api/v2/firewall/apply')[0]);
                const st = await waitFor(async () => {
                    const s = await harness.states.getStateAsync('pfsense.0.firewall.rules.1000000102.enabled');
                    return s && s.ack ? s : undefined;
                });
                expect(st.val).to.equal(true);
            });

            it('answers sendTo commands', async function () {
                this.timeout(20000);
                const res = await new Promise(resolve =>
                    harness.sendTo('pfsense.0', 'wakeOnLan', { mac: 'AA:BB:CC:00:00:01' }, resolve),
                );
                expect(res).to.deep.equal({ result: 'ok' });
                const call = mock.calls('POST', '/api/v2/services/wake_on_lan/send')[0];
                expect(call.body).to.deep.equal({ interface: 'lan', mac_addr: 'aa:bb:cc:00:00:01' });

                const unknown = await new Promise(resolve => harness.sendTo('pfsense.0', 'nope', {}, resolve));
                expect(unknown).to.have.property('error');
            });

            it('retries an endpoint on the next poll after a transient server error', async function () {
                this.timeout(30000);
                mock.handlers['GET /api/v2/status/gateways'] = () => ({ status: 502, body: '<html>Bad Gateway</html>', raw: true });
                const failedAt = mock.calls('GET', '/api/v2/status/gateways').length;
                await waitFor(() => mock.calls('GET', '/api/v2/status/gateways').length > failedAt);
                delete mock.handlers['GET /api/v2/status/gateways'];
                mock.data['/api/v2/status/gateways'].find(g => g.name === 'WAN_DHCP').delay = 9.5;
                const st = await waitFor(async () => {
                    const s = await harness.states.getStateAsync('pfsense.0.gateways.WAN_DHCP.latency');
                    return s && s.val === 9.5 ? s : undefined;
                }, 25000);
                expect(st.val).to.equal(9.5);
                expect((await harness.states.getStateAsync('pfsense.0.info.connection')).val).to.equal(true);
            });

            it('reports the connection down while the status endpoint is refused, and recovers', async function () {
                this.timeout(60000);
                const { envelope } = require('./mock-pfsense.ts');
                mock.handlers['GET /api/v2/status/system'] = () => envelope(403, 'Forbidden', []);
                await waitFor(async () => (await harness.states.getStateAsync('pfsense.0.info.connection'))?.val === false, 45000);
                // the rest of the status tier keeps being polled
                const before = mock.calls('GET', '/api/v2/status/services').length;
                await waitFor(() => mock.calls('GET', '/api/v2/status/services').length > before, 25000);
                delete mock.handlers['GET /api/v2/status/system'];
                await waitFor(async () => (await harness.states.getStateAsync('pfsense.0.info.connection'))?.val === true, 25000);
            });

            it('resumes all data right after a REST API package reinstall', async function () {
                this.timeout(60000);
                mock.apiGone = true;
                const t0 = mock.requests.length;
                // let every tier hit the missing package at least once
                await waitFor(() => mock.requests.slice(t0).some(r => r.path === '/api/v2/status/system'), 25000);
                await waitFor(() => mock.requests.slice(t0).some(r => r.path === '/api/v2/status/interfaces'), 15000);
                mock.apiGone = false;
                mock.data['/api/v2/status/interfaces'][0].mtu = '1492';
                const st = await waitFor(async () => {
                    const s = await harness.states.getStateAsync('pfsense.0.interfaces.wan.mtu');
                    return s && s.val === 1492 ? s : undefined;
                }, 25000);
                expect(st.val).to.equal(1492);
                await waitFor(async () => (await harness.states.getStateAsync('pfsense.0.info.connection'))?.val === true, 25000);
            });

            it('turns info.connection off when the firewall goes away', async function () {
                this.timeout(60000);
                await mock.stop();
                await waitFor(async () => (await harness.states.getStateAsync('pfsense.0.info.connection'))?.val === false, 55000);
            });
        });
    },
});
