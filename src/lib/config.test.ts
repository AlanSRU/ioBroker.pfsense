import { expect } from 'chai';
import { native } from '../../io-package.json';
import { cleanHost, LIMITS, parseSettings } from './config';

const FP = `${'AB:'.repeat(31)}AB`;

describe('config', () => {
    const base = { ...native, host: '10.0.0.1', apiKey: 'k', certFingerprint: FP };

    it('accepts the defaults plus host, key and fingerprint', () => {
        const { settings, errors } = parseSettings(base);
        expect(errors).to.deep.equal([]);
        expect(settings!.client.port).to.equal(443);
        expect(settings!.intervals.fast).to.equal(10_000);
        expect(settings!.firewallRules).to.equal(false);
        expect(settings!.powerControl).to.equal(false);
    });

    it('defaults in io-package lie within the code limits', () => {
        const cfg = native as Record<string, unknown>;
        for (const [key, l] of Object.entries(LIMITS)) {
            expect(cfg[key], key).to.equal(l.def);
            expect(l.def).to.be.within(l.min, l.max);
        }
    });

    it('clamps intervals in code', () => {
        const { settings } = parseSettings({ ...base, intervalFast: 0, intervalStatus: 1e12, requestTimeout: -5 });
        expect(settings!.intervals.fast).to.equal(LIMITS.intervalFast.min * 1000);
        expect(settings!.intervals.status).to.equal(LIMITS.intervalStatus.max * 1000);
        expect(settings!.client.timeoutMs).to.equal(LIMITS.requestTimeout.min * 1000);
        expect(settings!.intervals.config).to.be.below(2_147_483_647);
    });

    it('reports missing essentials', () => {
        expect(parseSettings({ ...base, host: '' }).errors).to.have.length(1);
        expect(parseSettings({ ...base, apiKey: '' }).errors).to.have.length(1);
        expect(parseSettings({ ...base, certFingerprint: 'abc' }).errors).to.have.length(1);
        expect(parseSettings({ ...base, authMode: 'basic' }).errors).to.have.length(1);
    });

    it('does not need a fingerprint for verify, insecure or http', () => {
        for (const extra of [{ tlsMode: 'verify' }, { tlsMode: 'insecure' }, { protocol: 'http' }]) {
            expect(parseSettings({ ...base, certFingerprint: '', ...extra }).errors).to.deep.equal([]);
        }
    });

    it('cleans pasted addresses', () => {
        expect(cleanHost('https://fw.lan/index.php')).to.equal('fw.lan');
        expect(cleanHost(' 10.0.0.1:8443 ')).to.equal('10.0.0.1');
        expect(cleanHost('[fd00::1]:443')).to.equal('fd00::1');
        expect(cleanHost('fd00::1')).to.equal('fd00::1');
    });
});
