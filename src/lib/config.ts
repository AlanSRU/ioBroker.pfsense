import { type ClientOptions, normalizeFingerprint, type TlsMode } from './client';
import { parseWatched, type WatchedDevice } from './features';
import { clamp, toStr } from './util';

/** Limits enforced in code; the admin UI uses the same numbers but is not relied upon. */
export const LIMITS = {
    requestTimeout: { min: 2, max: 60, def: 10 },
    intervalFast: { min: 5, max: 3600, def: 10 },
    intervalStatus: { min: 10, max: 3600, def: 30 },
    intervalNetwork: { min: 15, max: 3600, def: 60 },
    intervalConfig: { min: 60, max: 86400, def: 300 },
    presenceGrace: { min: 0, max: 86400, def: 180 },
} as const;

/** Validated instance configuration. */
export interface Settings {
    client: ClientOptions;
    /** Poll periods in milliseconds. */
    intervals: {
        fast: number;
        status: number;
        network: number;
        config: number;
    };
    interfaces: boolean;
    gateways: boolean;
    services: boolean;
    serviceControl: boolean;
    network: boolean;
    trackAllHosts: boolean;
    presenceProbe: boolean;
    presenceGraceMs: number;
    watched: WatchedDevice[];
    vpn: boolean;
    carp: boolean;
    firewallRules: boolean;
    ruleFilter: string;
    aliases: boolean;
    powerControl: boolean;
}

function lim(cfg: Record<string, unknown>, key: keyof typeof LIMITS): number {
    const l = LIMITS[key];
    return clamp(cfg[key], l.min, l.max, l.def);
}

/** Host as typed by the user: strips a scheme, path and surrounding brackets of IPv6 literals. */
export function cleanHost(raw: unknown): string {
    let h = (toStr(raw) ?? '').trim();
    h = h.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
    if (v6) {
        return v6[1];
    }
    // host:port typed into the host field
    if (/^[^:]+:\d+$/.test(h)) {
        h = h.replace(/:\d+$/, '');
    }
    return h;
}

/** Validates and normalises the instance configuration. Returns the problems found instead of throwing. */
export function parseSettings(raw: ioBroker.AdapterConfig | Record<string, unknown>): {
    settings?: Settings;
    errors: string[];
} {
    const cfg = raw as Record<string, unknown>;
    const errors: string[] = [];

    const host = cleanHost(cfg.host);
    if (!host) {
        errors.push('No firewall address configured.');
    }
    const protocol = cfg.protocol === 'http' ? 'http' : 'https';
    const port = clamp(cfg.port, 1, 65535, protocol === 'http' ? 80 : 443);
    const tlsMode: TlsMode = cfg.tlsMode === 'verify' || cfg.tlsMode === 'insecure' ? cfg.tlsMode : 'fingerprint';
    const fingerprint = normalizeFingerprint(toStr(cfg.certFingerprint) ?? '');
    if (protocol === 'https' && tlsMode === 'fingerprint' && fingerprint.length !== 95) {
        errors.push(
            'Certificate pinning is selected but no valid SHA-256 fingerprint is configured. Use "Read certificate fingerprint" in the instance settings.',
        );
    }

    let auth: ClientOptions['auth'];
    if (cfg.authMode === 'basic') {
        const username = (toStr(cfg.username) ?? '').trim();
        const password = toStr(cfg.password) ?? '';
        if (!username || !password) {
            errors.push('Basic authentication is selected but user name or password is missing.');
        }
        auth = { kind: 'basic', username, password };
    } else {
        const apiKey = (toStr(cfg.apiKey) ?? '').trim();
        if (!apiKey) {
            errors.push('No API key configured.');
        }
        auth = { kind: 'key', apiKey };
    }

    if (errors.length) {
        return { errors };
    }
    const flag = (k: string, def: boolean): boolean => (typeof cfg[k] === 'boolean' ? cfg[k] : def);
    return {
        errors,
        settings: {
            client: {
                host,
                port,
                protocol,
                tlsMode,
                fingerprint,
                auth,
                timeoutMs: lim(cfg, 'requestTimeout') * 1000,
            },
            intervals: {
                fast: lim(cfg, 'intervalFast') * 1000,
                status: lim(cfg, 'intervalStatus') * 1000,
                network: lim(cfg, 'intervalNetwork') * 1000,
                config: lim(cfg, 'intervalConfig') * 1000,
            },
            interfaces: flag('enableInterfaces', true),
            gateways: flag('enableGateways', true),
            services: flag('enableServices', true),
            serviceControl: flag('allowServiceControl', true),
            network: flag('enableNetwork', true),
            trackAllHosts: flag('trackAllHosts', false),
            presenceProbe: flag('presenceProbe', true),
            presenceGraceMs: lim(cfg, 'presenceGrace') * 1000,
            watched: parseWatched(cfg.presenceDevices),
            vpn: flag('enableVpn', true),
            carp: flag('enableCarp', true),
            firewallRules: flag('enableFirewallRules', false),
            ruleFilter: (toStr(cfg.ruleFilter) ?? '').trim(),
            aliases: flag('enableAliases', false),
            powerControl: flag('allowPowerControl', false),
        },
    };
}
