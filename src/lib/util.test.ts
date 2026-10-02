import { expect } from 'chai';
import {
    clamp,
    normalizeMac,
    parseLeaseTime,
    parseUptime,
    RateTracker,
    sanitizeId,
    toBool,
    toNumber,
    toStr,
} from './util';

describe('util', () => {
    describe('toNumber', () => {
        it('treats "not reported" as undefined, never 0', () => {
            for (const v of [null, undefined, '', '  ', true, false, NaN, Infinity, [], {}, 'abc']) {
                expect(toNumber(v), JSON.stringify(v)).to.equal(undefined);
            }
        });
        it('keeps genuine zeros and numeric strings', () => {
            expect(toNumber(0)).to.equal(0);
            expect(toNumber('0')).to.equal(0);
            expect(toNumber('1500')).to.equal(1500);
            expect(toNumber(-2.5)).to.equal(-2.5);
        });
    });

    it('toStr and toBool only pass real values', () => {
        expect(toStr(null)).to.equal(undefined);
        expect(toStr(5)).to.equal(undefined);
        expect(toStr('')).to.equal('');
        expect(toBool('0')).to.equal(undefined);
        expect(toBool(null)).to.equal(undefined);
        expect(toBool(false)).to.equal(false);
    });

    describe('parseUptime', () => {
        it('parses the verbose form', () => {
            expect(parseUptime('3 Days 04 Hours 12 Minutes 05 Seconds')).to.equal(3 * 86400 + 4 * 3600 + 12 * 60 + 5);
            expect(parseUptime('1 Day 01 Hour 01 Minute 01 Second')).to.equal(86400 + 3600 + 61);
        });
        it('parses clock forms', () => {
            expect(parseUptime('03:41:07')).to.equal(3 * 3600 + 41 * 60 + 7);
            expect(parseUptime('2 days 00:00:10')).to.equal(2 * 86400 + 10);
        });
        it('returns undefined for nothing recognisable', () => {
            expect(parseUptime('')).to.equal(undefined);
            expect(parseUptime('n/a')).to.equal(undefined);
            expect(parseUptime(null)).to.equal(undefined);
        });
    });

    describe('parseLeaseTime', () => {
        it('reads pfSense UTC lease times', () => {
            expect(parseLeaseTime('2026/10/02 09:00:00')).to.equal(Date.UTC(2026, 9, 2, 9, 0, 0));
        });
        it('reads ISO times with offset', () => {
            expect(parseLeaseTime('2026-10-02T09:00:00+02:00')).to.equal(Date.UTC(2026, 9, 2, 7, 0, 0));
        });
        it('rejects n/a and blanks', () => {
            for (const v of ['n/a', 'never', '', null, undefined]) {
                expect(parseLeaseTime(v)).to.equal(undefined);
            }
        });
    });

    it('normalizeMac accepts common spellings and rejects junk', () => {
        expect(normalizeMac('AA-BB-CC-DD-EE-FF')).to.equal('aa:bb:cc:dd:ee:ff');
        expect(normalizeMac('aabb.ccdd.eeff')).to.equal('aa:bb:cc:dd:ee:ff');
        expect(normalizeMac('aa:bb:cc')).to.equal('');
        expect(normalizeMac(42)).to.equal('');
    });

    it('sanitizeId keeps only safe characters', () => {
        expect(sanitizeId('OpenVPN server: Road Warrior')).to.equal('OpenVPN_server_Road_Warrior');
        expect(sanitizeId('a.b*c')).to.equal('a_b_c');
        expect(sanitizeId('...')).to.equal('_');
    });

    it('clamp enforces limits and falls back on garbage', () => {
        expect(clamp(1, 5, 10, 7)).to.equal(5);
        expect(clamp(99, 5, 10, 7)).to.equal(10);
        expect(clamp('8', 5, 10, 7)).to.equal(8);
        expect(clamp('x', 5, 10, 7)).to.equal(7);
        expect(clamp(undefined, 5, 10, 7)).to.equal(7);
    });

    describe('RateTracker', () => {
        it('computes bit/s from byte counters', () => {
            const r = new RateTracker();
            expect(r.bitsPerSecond('a', 1000, 0)).to.equal(undefined);
            expect(r.bitsPerSecond('a', 2000, 1000)).to.equal(8000);
        });
        it('skips counter resets and clock stalls', () => {
            const r = new RateTracker();
            r.bitsPerSecond('a', 5000, 0);
            expect(r.bitsPerSecond('a', 100, 1000)).to.equal(undefined);
            expect(r.bitsPerSecond('a', 200, 1000)).to.equal(undefined);
            expect(r.bitsPerSecond('a', undefined, 2000)).to.equal(undefined);
        });
    });
});
