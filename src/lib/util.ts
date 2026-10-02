/** Replaces everything outside `[A-Za-z0-9_-]` so a value from the firewall is safe as an object id segment. */
export function sanitizeId(raw: string): string {
    const id = raw
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return id || '_';
}

/** Lower-case MAC with colons, or '' when the input is not a MAC address. */
export function normalizeMac(raw: unknown): string {
    if (typeof raw !== 'string') {
        return '';
    }
    const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (hex.length !== 12) {
        return '';
    }
    return hex.match(/.{2}/g)!.join(':');
}

/** Object id segment for a MAC address: `aa_bb_cc_dd_ee_ff`. */
export function macId(mac: string): string {
    return mac.replace(/:/g, '_');
}

/**
 * Strict number conversion: `null`, `undefined`, blank strings, booleans and non-finite values
 * are "not reported" (undefined), never 0. Numeric strings are accepted because pfSense
 * reports several numbers (MTU, ports) as strings.
 */
export function toNumber(v: unknown): number | undefined {
    if (typeof v === 'number') {
        return Number.isFinite(v) ? v : undefined;
    }
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** Strict string conversion: only real strings pass, so `null` never becomes "null". */
export function toStr(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

/** Strict boolean conversion: only real booleans pass. */
export function toBool(v: unknown): boolean | undefined {
    return typeof v === 'boolean' ? v : undefined;
}

const UPTIME_UNITS: Record<string, number> = {
    year: 31_536_000,
    week: 604_800,
    day: 86_400,
    hour: 3_600,
    minute: 60,
    second: 1,
};

/**
 * Parses pfSense's uptime text ("12 Days 03 Hours 41 Minutes 07 Seconds", "1 Day 00:12:03",
 * "03:41:07") into seconds. Returns undefined when nothing recognisable is found.
 */
export function parseUptime(text: unknown): number | undefined {
    if (typeof text !== 'string' || !text.trim()) {
        return undefined;
    }
    let total = 0;
    let found = false;
    const unitRe = /(\d+)\s*(year|week|day|hour|minute|second)s?/gi;
    for (const m of text.matchAll(unitRe)) {
        total += Number(m[1]) * UPTIME_UNITS[m[2].toLowerCase()];
        found = true;
    }
    const clock = /(\d+):(\d{2}):(\d{2})/.exec(text);
    if (clock) {
        total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
        found = true;
    }
    return found ? total : undefined;
}

/**
 * Parses a pfSense DHCP lease time ("2026/10/02 08:15:00" in UTC for ISC, or ISO for Kea)
 * into epoch milliseconds. Returns undefined for "n/a", "never", blanks or garbage.
 */
export function parseLeaseTime(text: unknown): number | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    const t = text.trim();
    const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(t);
    if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    if (m) {
        const ms = Date.parse(t);
        return Number.isFinite(ms) ? ms : undefined;
    }
    return undefined;
}

/** Clamps a configured number into [min, max]; non-numbers and NaN fall back to `def`. */
export function clamp(value: unknown, min: number, max: number, def: number): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) {
        return def;
    }
    return Math.min(max, Math.max(min, n));
}

/**
 * Turns successive byte counters into a rate. Keeps the previous sample per key and returns
 * bits per second, or undefined on the first sample, after a counter reset, or when the clock
 * did not advance.
 */
export class RateTracker {
    private readonly last = new Map<string, { bytes: number; at: number }>();

    /** Records a counter sample and returns the rate since the previous one. */
    public bitsPerSecond(key: string, bytes: number | undefined, at: number): number | undefined {
        if (bytes === undefined) {
            return undefined;
        }
        const prev = this.last.get(key);
        this.last.set(key, { bytes, at });
        if (!prev || at <= prev.at || bytes < prev.bytes) {
            return undefined;
        }
        return Math.round(((bytes - prev.bytes) * 8 * 1000) / (at - prev.at));
    }

    /** Drops samples whose key starts with `prefix` (entity removed). */
    public forget(prefix: string): void {
        for (const key of this.last.keys()) {
            if (key.startsWith(prefix)) {
                this.last.delete(key);
            }
        }
    }
}

/** Message of an Error, or the stringified value. */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
