import { expect } from 'chai';
import { collectSightings, PresenceTracker } from './presence';

describe('presence', () => {
    it('merges leases and ARP per MAC', () => {
        const s = collectSightings(
            [{ mac: 'AA:BB:CC:DD:EE:01', ip: '10.0.0.5', hostname: 'tv', if: 'lan', online_status: 'idle/offline' }],
            [{ mac_address: 'aa:bb:cc:dd:ee:01', ip_address: '10.0.0.6', hostname: '?' }],
        );
        expect(s.get('aa:bb:cc:dd:ee:01')).to.deep.equal({
            mac: 'aa:bb:cc:dd:ee:01',
            ip: '10.0.0.6',
            hostname: 'tv',
            interface: 'lan',
            leaseEnds: undefined,
            online: true,
        });
    });

    it('reads the combined lease online status and maps ARP interface names', () => {
        const s = collectSightings(
            [
                { mac: 'aa:bb:cc:dd:ee:01', online_status: 'active/online', if: null as unknown as string },
                { mac: 'aa:bb:cc:dd:ee:02', online_status: 'idle/offline' },
            ],
            [{ mac_address: 'aa:bb:cc:dd:ee:01', interface: 'LAN' }],
            new Map([['lan', 'lan']]),
        );
        expect(s.get('aa:bb:cc:dd:ee:01')!.online).to.equal(true);
        expect(s.get('aa:bb:cc:dd:ee:01')!.interface).to.equal('lan');
        expect(s.get('aa:bb:cc:dd:ee:02')!.online).to.equal(false);
    });

    it('ignores permanent ARP entries and invalid MACs', () => {
        const s = collectSightings([{ mac: 'bogus' }], [{ mac_address: 'aa:bb:cc:dd:ee:02', permanent: true }]);
        expect(s.size).to.equal(0);
    });

    it('keeps a device present during the grace period', () => {
        const t = new PresenceTracker(60_000);
        expect(t.update('m', true, 0).present).to.equal(true);
        expect(t.update('m', false, 59_000).present).to.equal(true);
        expect(t.update('m', false, 61_000).present).to.equal(false);
        expect(t.update('m', false, 61_000).lastSeen).to.equal(0);
    });

    it('is absent without a sighting, and seeding survives restarts', () => {
        const t = new PresenceTracker(60_000);
        expect(t.update('x', false, 1000).present).to.equal(false);
        t.seed('y', 50_000);
        expect(t.update('y', false, 100_000).present).to.equal(true);
    });

    it('with no grace period follows the current sighting only', () => {
        const t = new PresenceTracker(0);
        expect(t.update('m', true, 5).present).to.equal(true);
        expect(t.update('m', false, 6).present).to.equal(false);
    });
});
