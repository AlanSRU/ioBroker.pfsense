import type { ArpEntry, DhcpLease } from './types';
import { normalizeMac } from './util';

/** What the firewall currently knows about one MAC address. */
export interface Sighting {
    mac: string;
    ip?: string;
    hostname?: string;
    /** pfSense interface id (lan, opt1, …) when known; needed for Wake-on-LAN. */
    interface?: string;
    leaseEnds?: string;
    /** Seen in the ARP table or reported online by the DHCP server right now. */
    online: boolean;
}

/**
 * Merges DHCP leases and the ARP table into one record per MAC.
 * A host counts as online when it has a complete ARP entry or the lease says "online"
 * (pfSense derives that from ARP too, but the lease list covers hosts on other subnets
 * the API user may not see in ARP).
 */
export function collectSightings(
    leases: DhcpLease[],
    arp: ArpEntry[],
    ifaceIds: Map<string, string> = new Map(),
): Map<string, Sighting> {
    const out = new Map<string, Sighting>();
    for (const l of leases) {
        const mac = normalizeMac(l.mac);
        if (!mac) {
            continue;
        }
        const s: Sighting = out.get(mac) ?? { mac, online: false };
        s.ip ??= l.ip || undefined;
        s.hostname ??= l.hostname || undefined;
        s.interface ??= l.if || undefined;
        s.leaseEnds ??= l.ends || undefined;
        // reported as "active/online", "idle/offline", or just "online" depending on version and backend
        if (
            typeof l.online_status === 'string' &&
            l.online_status
                .toLowerCase()
                .split('/')
                .some(p => p.trim() === 'online')
        ) {
            s.online = true;
        }
        out.set(mac, s);
    }
    for (const a of arp) {
        const mac = normalizeMac(a.mac_address);
        if (!mac || a.permanent) {
            // permanent entries are the firewall's own interfaces or static ARP, not live hosts
            continue;
        }
        const s: Sighting = out.get(mac) ?? { mac, online: false };
        s.online = true;
        s.ip = a.ip_address || s.ip;
        if (a.interface) {
            s.interface ??= ifaceIds.get(a.interface.toLowerCase());
        }
        if (a.hostname && a.hostname !== '?') {
            s.hostname ??= a.hostname;
        }
        out.set(mac, s);
    }
    return out;
}

/**
 * Debounces presence: a device stays present for `graceMs` after it was last seen, so a phone
 * that drops off Wi-Fi for a minute is not reported as leaving.
 */
export class PresenceTracker {
    private readonly lastSeen = new Map<string, number>();

    /** @param graceMs - how long a device stays present after it was last seen */
    public constructor(private readonly graceMs: number) {}

    /** Restores a last-seen time from a previous run so a restart does not flip everyone to absent. */
    public seed(mac: string, lastSeen: number): void {
        if (Number.isFinite(lastSeen) && lastSeen > 0 && !this.lastSeen.has(mac)) {
            this.lastSeen.set(mac, lastSeen);
        }
    }

    /** Records a poll result and returns the debounced presence. */
    public update(mac: string, onlineNow: boolean, now: number): { present: boolean; lastSeen: number | undefined } {
        if (onlineNow) {
            this.lastSeen.set(mac, now);
        }
        const seen = this.lastSeen.get(mac);
        return { present: seen !== undefined && now - seen <= this.graceMs, lastSeen: seen };
    }
}
