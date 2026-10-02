/*
 * ioBroker adapter for pfSense firewalls, using the pfSense REST API v2 package.
 */
import * as utils from '@iobroker/adapter-core';
import { ApiError, type ClientOptions, fetchFingerprint, PfSenseClient, type Query } from './lib/client';
import { cleanHost, parseSettings, type Settings } from './lib/config';
import * as F from './lib/features';
import { ObjectWriter } from './lib/objects';
import { PresenceTracker } from './lib/presence';
import type { Carp, FirewallAlias, FirewallRule, RestApiVersion, Service, SystemVersion } from './lib/types';
import { errorMessage, normalizeMac, RateTracker, toNumber } from './lib/util';

/** An endpoint that answered "not available" is retried after this long (a package may get installed meanwhile). */
const UNAVAILABLE_RETRY_MS = 30 * 60_000;
/** Ceiling for the poll delay while the firewall is unreachable. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** Consecutive connection-level failures before `info.connection` turns false. */
const FAILURES_BEFORE_OFFLINE = 2;
/** An endpoint that times out repeatedly while the firewall answers other calls is skipped this long. */
const TIMEOUT_RETRY_MS = 10 * 60_000;
/** The liveness probe: always polled, its failures always count against the connection. */
const PROBE_PATH = '/api/v2/status/system';
/** Answers meaning "this endpoint is not usable here", not "the firewall is down". */
const ENDPOINT_KINDS = new Set(['forbidden', 'notFound', 'dependency']);

type TierName = 'fast' | 'status' | 'network' | 'config';

interface Tier {
    name: TierName;
    jobs: Array<(ctx: F.FeatureContext) => Promise<void>>;
    timer?: ioBroker.Timeout;
    running: boolean;
    /** Set when a run was requested while one was in progress. */
    again: boolean;
}

class Pfsense extends utils.Adapter {
    private settings?: Settings;
    private client?: PfSenseClient;
    private writer!: ObjectWriter;
    private readonly rates = new RateTracker();
    private presence = new PresenceTracker(0);
    private readonly tiers = new Map<TierName, Tier>();
    private unloaded = false;

    /** Serialises all API calls: pfSense's PHP backend handles one request at a time best. */
    private queue: Promise<unknown> = Promise.resolve();

    private isConnected = false;
    private failures = 0;
    private lastErrorText = '';
    private readonly unavailable = new Map<string, number>();
    /** Consecutive timeouts per path, and paths skipped because of them (cleared on reconnect). */
    private readonly timeouts = new Map<string, number>();
    private readonly skippedForTimeouts = new Set<string>();
    /** When the firewall last answered anything, and when any call last timed out. */
    private lastAnswerAt = 0;
    private lastTimeoutAt = 0;
    /**
     * Failures of the liveness probe while the firewall still answers (missing privilege, missing
     * package, server error). Counted separately: only a probe success resets them, so other endpoints
     * answering cannot hide a broken probe.
     */
    private probeFailures = 0;
    private lastProbeErrorText = '';
    private lastProbeOkAt = 0;
    /** When a path last gave a non-API answer; it counts as missing only if that repeats after a good probe. */
    private readonly noApiSeenAt = new Map<string, number>();
    private readonly reported = new Set<string>();

    private services: F.ServiceIndex = new Map();
    private wake: F.WakeIndex = new Map();
    /** Interface description/hardware name → id, for Wake-on-LAN requests that name the interface loosely. */
    private ifaceIds = new Map<string, string>();
    private hosts: unknown[] = [];

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'pfsense' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---- lifecycle --------------------------------------------------------------------------

    private async onReady(): Promise<void> {
        this.writer = new ObjectWriter(this, () => this.unloaded);
        await this.setState('info.connection', false, true);

        const { settings, errors } = parseSettings(this.config);
        if (!settings) {
            for (const e of errors) {
                this.log.error(`Configuration: ${e}`);
            }
            this.log.error('Polling not started. Fix the instance settings and save them.');
            return;
        }
        this.settings = settings;
        if (settings.client.protocol === 'https' && settings.client.tlsMode === 'insecure') {
            this.log.warn(
                'Certificate verification is turned off. Anyone on the network path could read the API credentials; prefer certificate pinning.',
            );
        }
        if (settings.client.protocol === 'http') {
            this.log.warn('Using plain HTTP: API credentials are sent unencrypted.');
        }
        this.presence = new PresenceTracker(settings.presenceGraceMs);

        await this.writer.load();
        if (this.unloaded) {
            return;
        }
        await this.cleanUpDisabledParts(settings);
        if (this.unloaded) {
            return;
        }
        await this.restorePresence();
        if (this.unloaded) {
            return;
        }
        if (settings.powerControl) {
            await this.writer.channel('control', 'Control');
            await this.writer.defineState('control.reboot', F.button('Reboot the firewall'));
            await this.writer.defineState('control.halt', F.button('Shut down the firewall'));
        }

        this.subscribeStates('services.*.start');
        this.subscribeStates('services.*.stop');
        this.subscribeStates('services.*.restart');
        this.subscribeStates('firewall.rules.*.enabled');
        this.subscribeStates('firewall.apply');
        this.subscribeStates('carp.enabled');
        this.subscribeStates('carp.maintenanceMode');
        this.subscribeStates('control.*');
        this.subscribeStates('devices.*.wake');

        if (this.unloaded) {
            return;
        }
        this.client = new PfSenseClient(settings.client);
        this.log.info(
            `Connecting to pfSense at ${settings.client.protocol}://${settings.client.host}:${settings.client.port}`,
        );
        this.buildTiers(settings);
        // config first (version info, rule list), then the rest; the queue keeps them from overlapping
        let delay = 0;
        for (const name of ['config', 'status', 'fast', 'network'] as TierName[]) {
            const tier = this.tiers.get(name);
            if (tier) {
                tier.timer = this.setTimeout(() => void this.runTier(tier), delay);
                delay += 500;
            }
        }
    }

    private onUnload(callback: () => void): void {
        this.unloaded = true;
        try {
            for (const tier of this.tiers.values()) {
                if (tier.timer) {
                    this.clearTimeout(tier.timer);
                }
            }
            this.client?.close();
            void this.setState('info.connection', false, true);
        } catch {
            // nothing left to clean up
        }
        callback();
    }

    /** Removes objects for things the user switched off where keeping them would mislead (controls). */
    private async cleanUpDisabledParts(s: Settings): Promise<void> {
        const w = this.writer;
        if (!s.powerControl && w.has('control')) {
            await w.remove('control');
        }
        if (!s.serviceControl) {
            for (const key of w.childKeys('services')) {
                for (const action of ['start', 'stop', 'restart']) {
                    if (w.has(`services.${key}.${action}`)) {
                        await w.remove(`services.${key}.${action}`);
                    }
                }
            }
        }
        // Devices removed from the presence list. Disabled rows keep their objects (history, aliases).
        if (!s.trackAllHosts) {
            const configured = F.configuredMacs(s.watched);
            for (const key of w.childKeys('devices')) {
                const obj = await this.getObjectAsync(`devices.${key}`);
                const mac = normalizeMac(obj?.native?.mac);
                if (obj?.type === 'device' && mac && !configured.has(mac)) {
                    this.log.info(`Removing device ${mac}: no longer in the presence list`);
                    await w.remove(`devices.${key}`);
                }
            }
        }
    }

    /** Seeds the presence debounce from the last run so a restart does not report everyone as gone. */
    private async restorePresence(): Promise<void> {
        for (const key of this.writer.childKeys('devices')) {
            const st = await this.getStateAsync(`devices.${key}.lastSeen`);
            const ip = await this.getStateAsync(`devices.${key}.ip`);
            const obj = await this.getObjectAsync(`devices.${key}`);
            const mac = normalizeMac(obj?.native?.mac);
            if (mac && typeof st?.val === 'number') {
                this.presence.seed(mac, st.val, typeof ip?.val === 'string' ? ip.val : undefined);
            }
        }
    }

    // ---- polling ----------------------------------------------------------------------------

    private buildTiers(s: Settings): void {
        const add = (name: TierName, jobs: Tier['jobs']): void => {
            if (jobs.length) {
                this.tiers.set(name, { name, jobs, running: false, again: false });
            }
        };
        const fast: Tier['jobs'] = [];
        if (s.interfaces) {
            fast.push(F.pollInterfaces);
        }
        if (s.gateways) {
            fast.push(F.pollGateways);
        }
        // System status doubles as the liveness probe, so it always runs.
        const status: Tier['jobs'] = [F.pollSystemStatus];
        if (s.services) {
            status.push(async ctx => {
                const idx = await F.pollServices(ctx, s.serviceControl);
                if (idx) {
                    this.services = idx;
                }
            });
        }
        if (s.vpn) {
            status.push(F.pollVpn);
        }
        if (s.carp) {
            status.push(F.pollCarp);
        }
        if (s.firewallRules || s.aliases) {
            status.push(F.pollFirewallPending);
        }
        const network: Tier['jobs'] = [];
        if (s.network) {
            network.push(async ctx => {
                const r = await F.pollNetwork(ctx, {
                    watched: s.watched,
                    trackAll: s.trackAllHosts,
                    tracker: this.presence,
                    probe: s.presenceProbe ? ip => this.probeHost(ip) : undefined,
                });
                if (r) {
                    this.wake = r.wake;
                    this.ifaceIds = r.ifaceIds;
                    this.hosts = r.sightings;
                }
            });
        }
        const config: Tier['jobs'] = [F.pollSystemInfo];
        if (s.firewallRules) {
            config.push(ctx => F.pollFirewallRules(ctx, s.ruleFilter));
        }
        if (s.aliases) {
            config.push(F.pollFirewallAliases);
        }
        add('fast', fast);
        add('status', status);
        add('network', network);
        add('config', config);
    }

    private async runTier(tier: Tier): Promise<void> {
        tier.timer = undefined;
        if (this.unloaded) {
            return;
        }
        tier.running = true;
        const ctx: F.FeatureContext = {
            w: this.writer,
            rates: this.rates,
            now: Date.now(),
            fetch: async <R>(path: string, query?: Query): Promise<R | undefined> => {
                const data = await this.fetch<R>(path, query);
                // time of the answer, not of the tier start: calls may wait in the queue (rates depend on it)
                ctx.now = Date.now();
                return data;
            },
        };
        for (const job of tier.jobs) {
            if (this.unloaded) {
                break;
            }
            try {
                await job(ctx);
            } catch (err) {
                // Connection-level failures were already counted and logged in fetch().
                if (!(err instanceof ApiError && err.isConnectionLevel)) {
                    this.logOnce(
                        `job:${tier.name}:${errorMessage(err)}`,
                        'warn',
                        `Updating ${tier.name} data failed: ${errorMessage(err)}`,
                    );
                }
                if (err instanceof ApiError && err.isConnectionLevel) {
                    break; // the rest of this tier would fail the same way
                }
            }
        }
        tier.running = false;
        if (this.unloaded) {
            return;
        }
        // Re-arm at the end, so a slow firewall can never cause overlapping runs.
        const delay = tier.again ? 0 : this.nextDelay(tier.name);
        tier.again = false;
        tier.timer = this.setTimeout(() => void this.runTier(tier), delay);
    }

    /** Runs a tier soon (after a command), without waiting for its regular period. */
    private refresh(name: TierName): void {
        const tier = this.tiers.get(name);
        if (!tier || this.unloaded) {
            return;
        }
        if (tier.running) {
            tier.again = true;
            return;
        }
        if (tier.timer) {
            this.clearTimeout(tier.timer);
        }
        tier.timer = this.setTimeout(() => void this.runTier(tier), 1000);
    }

    private nextDelay(name: TierName): number {
        const base = this.settings!.intervals[name];
        if (this.failures < FAILURES_BEFORE_OFFLINE) {
            return base;
        }
        // Back off while the firewall is unreachable: 2×, 4×, … the period, capped.
        const factor = 2 ** Math.min(6, this.failures - FAILURES_BEFORE_OFFLINE + 1);
        return Math.max(base, Math.min(MAX_BACKOFF_MS, this.settings!.intervals.fast * factor));
    }

    /** Puts an API call into the queue. */
    private call<R>(fn: (c: PfSenseClient) => Promise<R>): Promise<R> {
        const run = (): Promise<R> => {
            if (this.unloaded || !this.client) {
                return Promise.reject(new ApiError('network', 'Adapter is stopping'));
            }
            return fn(this.client);
        };
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => undefined);
        return p;
    }

    /**
     * GET for pollers. Resolves undefined when the endpoint gave no usable data:
     * - not offered / not permitted / package missing: skipped for a while, logged once;
     * - transient server or validation error: retried on the next poll;
     * - repeated timeouts on one endpoint while the firewall answers others: skipped for a while.
     * Failures that mean the firewall is unreachable are counted against the connection and rethrown.
     */
    private async fetch<R>(path: string, query?: Query): Promise<R | undefined> {
        const until = this.unavailable.get(path);
        if (until !== undefined && Date.now() < until) {
            return undefined;
        }
        try {
            const data = await this.call(c => c.get<R>(path, query));
            this.unavailable.delete(path);
            this.timeouts.delete(path);
            this.noApiSeenAt.delete(path);
            // this endpoint recovered: a later failure episode should warn again
            for (const key of [...this.reported]) {
                if (key.endsWith(`:${path}`) || key.startsWith(`unavailable:${path}:`)) {
                    this.reported.delete(key);
                }
            }
            this.onSuccess(path === PROBE_PATH);
            return data;
        } catch (err) {
            if (!(err instanceof ApiError) || this.unloaded) {
                // a request cut off by stopping the instance says nothing about the firewall
                throw err;
            }
            const probe = path === PROBE_PATH;
            if (
                probe &&
                (ENDPOINT_KINDS.has(err.kind) ||
                    err.kind === 'noApi' ||
                    err.kind === 'server' ||
                    err.kind === 'validation')
            ) {
                // The firewall answered, but the probe is unusable. It is required, so this takes the connection
                // down after repeated failures; the other jobs of the tier keep running.
                this.onProbeFailure(
                    err.kind === 'forbidden'
                        ? `The API user lacks the privilege api-v2-status-system-get, which the adapter needs to check the connection. Grant it on the firewall.`
                        : err.kind === 'noApi'
                          ? describe(err)
                          : `${PROBE_PATH} failed: ${err.message}`,
                );
                return undefined;
            }
            if (err.kind === 'noApi' && !probe && this.isConnected) {
                // A non-API answer on a secondary endpoint: either the endpoint is missing in this package version,
                // or the whole package is briefly gone (update or reinstall). Only call it missing when it repeats
                // after the probe answered normally in between.
                const prev = this.noApiSeenAt.get(path);
                if (prev === undefined || this.lastProbeOkAt <= prev) {
                    this.noApiSeenAt.set(path, Date.now());
                    this.log.debug(`${path}: ${err.message}`);
                    return undefined;
                }
                this.noApiSeenAt.delete(path);
                this.unavailable.set(path, Date.now() + UNAVAILABLE_RETRY_MS);
                this.reportUnavailable(path, err);
                return undefined;
            }
            if (ENDPOINT_KINDS.has(err.kind)) {
                this.onSuccess(); // the firewall answered, so the connection itself is fine
                this.unavailable.set(path, Date.now() + UNAVAILABLE_RETRY_MS);
                this.reportUnavailable(path, err);
                return undefined;
            }
            if (err.kind === 'server' || err.kind === 'validation') {
                this.logOnce(`transient:${path}`, 'warn', `${path} failed: ${err.message}. Retrying on the next poll.`);
                return undefined;
            }
            // A timeout is blamed on the endpoint only if the firewall answered something since the previous
            // timeout; otherwise the firewall itself is stalled and it counts against the connection.
            const firewallAnswering = this.lastAnswerAt > this.lastTimeoutAt;
            if (err.kind === 'timeout') {
                this.lastTimeoutAt = Date.now();
            }
            if (err.kind === 'timeout' && !probe && this.isConnected && firewallAnswering) {
                const n = (this.timeouts.get(path) ?? 0) + 1;
                this.timeouts.set(path, n);
                if (n >= 2) {
                    this.timeouts.delete(path);
                    this.unavailable.set(path, Date.now() + TIMEOUT_RETRY_MS);
                    this.skippedForTimeouts.add(path);
                    this.logOnce(
                        `timeout:${path}`,
                        'warn',
                        `${path} keeps timing out while the firewall answers other requests; skipping it for ${TIMEOUT_RETRY_MS / 60_000} minutes. Raise the request timeout if this repeats.`,
                    );
                } else {
                    this.log.debug(`${path} timed out`);
                }
                return undefined;
            }
            this.log.debug(`${path}: ${err.message}`);
            this.onFailure(err);
            throw err;
        }
    }

    private reportUnavailable(path: string, err: ApiError): void {
        const key = `unavailable:${path}:${err.kind}`;
        if (err.kind === 'forbidden') {
            this.logOnce(
                key,
                'warn',
                `The API user may not read ${path} (${err.message}). Grant the privilege on the firewall or disable the feature.`,
            );
        } else if (err.kind === 'dependency') {
            this.logOnce(
                key,
                'info',
                `${path} is not available: ${err.message} (a required pfSense package is not installed).`,
            );
        } else if (err.kind === 'notFound' || err.kind === 'noApi') {
            this.logOnce(
                key,
                'info',
                err.kind === 'notFound' && err.message
                    ? `${path} is not available: ${err.message}`
                    : `${path} is not offered by this REST API package version. Updating the package enables it.`,
            );
        } else {
            this.logOnce(key, 'warn', `${path} failed: ${err.message}`);
        }
    }

    private onSuccess(probe = false): void {
        this.lastAnswerAt = Date.now();
        this.failures = 0;
        this.lastErrorText = '';
        if (probe) {
            this.lastProbeOkAt = Date.now();
            if (this.probeFailures) {
                this.log.info(`${PROBE_PATH} answers again`);
            }
            this.probeFailures = 0;
            this.lastProbeErrorText = '';
        }
        this.updateConnection();
    }

    /** A failure that means the firewall is unreachable or rejects us: counted, logged once per distinct message. */
    private onFailure(err: ApiError): void {
        this.failures++;
        const text = describe(err);
        if (text !== this.lastErrorText) {
            this.lastErrorText = text;
            if (err.kind === 'auth') {
                this.log.error(text);
            } else {
                this.log.warn(text);
            }
        } else {
            this.log.debug(text);
        }
        this.updateConnection();
    }

    private onProbeFailure(text: string): void {
        this.probeFailures++;
        if (text !== this.lastProbeErrorText) {
            this.lastProbeErrorText = text;
            this.log.error(text);
        } else {
            this.log.debug(text);
        }
        this.updateConnection();
    }

    /** Derives info.connection from both failure counters and logs the transitions once. */
    private updateConnection(): void {
        if (this.unloaded) {
            return;
        }
        const ok = this.failures < FAILURES_BEFORE_OFFLINE && this.probeFailures < FAILURES_BEFORE_OFFLINE;
        if (ok && !this.isConnected) {
            this.isConnected = true;
            // endpoints skipped for timing out were probably victims of the outage: try them again
            for (const p of this.skippedForTimeouts) {
                this.unavailable.delete(p);
            }
            this.skippedForTimeouts.clear();
            void this.setState('info.connection', true, true);
            this.log.info(
                this.reported.has('connection-lost') ? 'Connection to pfSense restored' : 'Connected to pfSense',
            );
            this.reported.delete('connection-lost');
        } else if (!ok && this.isConnected) {
            this.isConnected = false;
            void this.setState('info.connection', false, true);
            this.reported.add('connection-lost');
            this.log.warn(
                this.failures >= FAILURES_BEFORE_OFFLINE
                    ? 'Connection to pfSense lost; retrying with back-off'
                    : 'pfSense answers, but its status endpoint does not; reporting the connection as down',
            );
        }
    }

    private logOnce(key: string, level: 'info' | 'warn', text: string): void {
        if (this.reported.has(key)) {
            this.log.debug(text);
            return;
        }
        this.reported.add(key);
        this.log[level](text);
    }

    // ---- commands ---------------------------------------------------------------------------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || this.unloaded || !this.client) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        try {
            const handled = await this.command(rel, state.val);
            if (!handled) {
                this.log.debug(`No handler for ${rel}`);
            }
        } catch (err) {
            this.log.warn(`Command ${rel} failed: ${errorMessage(err)}`);
            // put switches back to the firewall's real value
            if (rel.startsWith('firewall.')) {
                this.refresh('config');
            }
            this.refresh('status');
        }
    }

    /** Executes a command written to a state. Returns false when the id is not a command. */
    private async command(rel: string, val: ioBroker.StateValue): Promise<boolean> {
        let m: RegExpExecArray | null;
        if ((m = /^services\.([^.]+)\.(start|stop|restart)$/.exec(rel))) {
            if (!this.settings?.serviceControl) {
                return false;
            }
            await this.serviceAction(m[1], m[2] as 'start' | 'stop' | 'restart');
            await this.setState(rel, { val, ack: true });
            this.refresh('status');
            return true;
        }
        if ((m = /^firewall\.rules\.(\d+)\.enabled$/.exec(rel))) {
            await this.setRuleEnabled(Number(m[1]), !!val);
            await this.setState(rel, { val: !!val, ack: true });
            this.refresh('status');
            return true;
        }
        if (rel === 'firewall.apply') {
            await this.applyFirewall();
            await this.setState(rel, { val, ack: true });
            this.refresh('status');
            return true;
        }
        if (rel === 'carp.enabled' || rel === 'carp.maintenanceMode') {
            // the API requires both fields; take the other one from the firewall
            const cur = await this.call(c => c.get<Carp>('/api/v2/status/carp'));
            const body = {
                enable: rel === 'carp.enabled' ? !!val : !!cur.enable,
                maintenance_mode: rel === 'carp.maintenanceMode' ? !!val : !!cur.maintenance_mode,
            };
            await this.call(c => c.patch('/api/v2/status/carp', body));
            await this.setState(rel, { val: !!val, ack: true });
            this.refresh('status');
            return true;
        }
        if (rel === 'control.reboot' || rel === 'control.halt') {
            if (!this.settings?.powerControl) {
                return false;
            }
            this.log.warn(`${rel === 'control.reboot' ? 'Rebooting' : 'Shutting down'} the firewall on request`);
            await this.call(c =>
                c.post(rel === 'control.reboot' ? '/api/v2/diagnostics/reboot' : '/api/v2/diagnostics/halt_system', {}),
            );
            await this.setState(rel, { val, ack: true });
            return true;
        }
        if ((m = /^devices\.([^.]+)\.wake$/.exec(rel))) {
            const obj = await this.getObjectAsync(`devices.${m[1]}`);
            const mac = normalizeMac(obj?.native?.mac);
            if (!mac) {
                throw new Error('device has no MAC address');
            }
            await this.wakeOnLan(mac);
            await this.setState(rel, { val, ack: true });
            return true;
        }
        return false;
    }

    private async serviceAction(key: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
        const svc = this.services.get(key);
        if (!svc) {
            throw new Error(`unknown service ${key}`);
        }
        // The API addresses services by list position, which shifts when a package adds or removes one,
        // so the id is looked up fresh right before acting instead of trusting the last poll.
        const list = await this.call(c => c.get<Service[]>('/api/v2/status/services'));
        const current = Array.isArray(list)
            ? list.filter(
                  s => s.name === svc.name && (svc.description === undefined || s.description === svc.description),
              )
            : [];
        if (Array.isArray(list) && list.filter(s => s.name === svc.name).length > 1) {
            throw new Error(
                `the REST API cannot control "${svc.name}" while several services share that name (e.g. multiple OpenVPN instances)`,
            );
        }
        if (current.length !== 1 || toNumber(current[0].id) === undefined) {
            throw new Error(`service ${svc.description ?? svc.name} not found on the firewall (any more)`);
        }
        this.log.info(`Service ${svc.description ?? svc.name}: ${action}`);
        await this.call(c => c.post('/api/v2/status/service', { id: current[0].id, action }));
    }

    /** Looks a rule up by its tracker (the stable identity), changes it and applies. */
    private async setRuleEnabled(tracker: number, enabled: boolean): Promise<void> {
        const rules = await this.call(c => c.get<FirewallRule[]>('/api/v2/firewall/rules', { tracker }));
        const rule = Array.isArray(rules) ? rules.find(r => toNumber(r.tracker) === tracker) : undefined;
        if (!rule || toNumber(rule.id) === undefined) {
            throw new Error(`firewall rule with tracker ${tracker} not found`);
        }
        this.log.info(`Firewall rule "${rule.descr ?? tracker}": ${enabled ? 'enable' : 'disable'}`);
        await this.call(c => c.patch('/api/v2/firewall/rule', { id: rule.id, disabled: !enabled }));
        await this.applyFirewall();
    }

    private async applyFirewall(): Promise<void> {
        await this.call(c => c.post('/api/v2/firewall/apply', {}));
    }

    /** Has the firewall ping a host once; a reply, or just the ARP exchange it causes, reveals a quiet device. */
    private async probeHost(ip: string): Promise<boolean> {
        try {
            // A device that drops pings still answers the ARP request this causes, so the ARP read that follows
            // finds it even when the ping itself times out.
            const r = await this.call(c =>
                c.post<{ result_code?: number }>('/api/v2/diagnostics/ping', { host: ip, count: 1 }),
            );
            return r?.result_code === 0;
        } catch (err) {
            if (err instanceof ApiError && err.kind === 'forbidden') {
                this.logOnce(
                    'probe:forbidden',
                    'warn',
                    'Presence probing needs the api-v2-diagnostics-ping-post privilege; without it quiet devices may be reported away.',
                );
            } else {
                this.log.debug(`Probing ${ip} failed: ${errorMessage(err)}`);
            }
            return false;
        }
    }

    private async wakeOnLan(mac: string, iface?: string): Promise<void> {
        const target = (iface && (this.ifaceIds.get(iface.toLowerCase()) ?? iface)) || this.wake.get(mac);
        if (!target) {
            throw new Error(`no interface known for ${mac}; set it in the presence list or pass it to the command`);
        }
        this.log.info(`Wake-on-LAN for ${mac} on ${target}`);
        await this.call(c => c.post('/api/v2/services/wake_on_lan/send', { interface: target, mac_addr: mac }));
    }

    private async changeAlias(
        name: string,
        entry: string,
        detail: string | undefined,
        add: boolean,
    ): Promise<FirewallAlias> {
        const list = await this.call(c => c.get<FirewallAlias[]>('/api/v2/firewall/aliases', { name }));
        const alias = Array.isArray(list) ? list.find(a => a.name === name) : undefined;
        if (!alias || toNumber(alias.id) === undefined) {
            throw new Error(`alias ${name} not found`);
        }
        const address = Array.isArray(alias.address) ? [...alias.address] : [];
        const details = Array.isArray(alias.detail) ? [...alias.detail] : [];
        while (details.length < address.length) {
            details.push('');
        }
        details.length = address.length;
        const at = address.indexOf(entry);
        if (add) {
            if (at >= 0) {
                return alias;
            }
            address.push(entry);
            details.push(detail ?? 'Added by ioBroker');
        } else {
            if (at < 0) {
                return alias;
            }
            address.splice(at, 1);
            details.splice(at, 1);
        }
        const updated = await this.call(c =>
            c.patch<FirewallAlias>('/api/v2/firewall/alias', { id: alias.id, address, detail: details }),
        );
        await this.applyFirewall();
        this.refresh('config');
        return updated;
    }

    // ---- messages ---------------------------------------------------------------------------

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        const reply = (res: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, res as ioBroker.MessagePayload, obj.callback);
            }
        };
        const msg = (obj.message && typeof obj.message === 'object' ? obj.message : {}) as Record<string, unknown>;
        try {
            switch (obj.command) {
                case 'testConnection':
                    return reply({ result: await this.testConnection(msg) });
                case 'readFingerprint': {
                    const host = cleanHost(msg.host);
                    if (!host) {
                        return reply({ error: 'Enter the firewall address first' });
                    }
                    const fp = await fetchFingerprint(host, toNumber(msg.port) ?? 443, 10_000);
                    // `native` makes the admin put the value into the form field
                    return reply({ native: { certFingerprint: fp }, result: fp });
                }
            }
            if (!this.client) {
                return reply({ error: 'Not connected: the adapter is not configured or still starting' });
            }
            switch (obj.command) {
                case 'wakeOnLan': {
                    const mac = normalizeMac(msg.mac);
                    if (!mac) {
                        return reply({ error: 'mac is missing or invalid' });
                    }
                    await this.wakeOnLan(mac, typeof msg.interface === 'string' ? msg.interface : undefined);
                    return reply({ result: 'ok' });
                }
                case 'serviceAction': {
                    const action = msg.action;
                    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
                        return reply({ error: 'action must be start, stop or restart' });
                    }
                    if (!this.settings?.serviceControl) {
                        return reply({ error: 'Service control is disabled in the instance settings' });
                    }
                    await this.serviceAction(typeof msg.service === 'string' ? msg.service : '', action);
                    this.refresh('status');
                    return reply({ result: 'ok' });
                }
                case 'setRuleEnabled': {
                    const tracker = toNumber(msg.tracker);
                    if (tracker === undefined || typeof msg.enabled !== 'boolean') {
                        return reply({ error: 'tracker (number) and enabled (boolean) are required' });
                    }
                    await this.setRuleEnabled(tracker, msg.enabled);
                    this.refresh('config');
                    return reply({ result: 'ok' });
                }
                case 'applyFirewall':
                    await this.applyFirewall();
                    this.refresh('status');
                    return reply({ result: 'ok' });
                case 'aliasAddEntry':
                case 'aliasRemoveEntry': {
                    if (typeof msg.alias !== 'string' || typeof msg.entry !== 'string' || !msg.entry.trim()) {
                        return reply({ error: 'alias and entry are required' });
                    }
                    const a = await this.changeAlias(
                        msg.alias,
                        msg.entry.trim(),
                        typeof msg.detail === 'string' ? msg.detail : undefined,
                        obj.command === 'aliasAddEntry',
                    );
                    return reply({ result: { name: a.name, entries: a.address ?? [] } });
                }
                case 'getHosts':
                    return reply({ result: this.hosts });
                default:
                    return reply({ error: `Unknown command ${obj.command}` });
            }
        } catch (err) {
            reply({ error: errorMessage(err) });
        }
    }

    /** "Test connection" in the instance settings: uses the values in the form, not the saved ones. */
    private async testConnection(form: Record<string, unknown>): Promise<string> {
        const merged = { ...this.config, ...form } as Record<string, unknown>;
        const { settings, errors } = parseSettings(merged);
        if (!settings) {
            throw new Error(errors.join(' '));
        }
        const opts: ClientOptions = { ...settings.client };
        const client = new PfSenseClient(opts);
        try {
            const version = await client.get<SystemVersion>('/api/v2/system/version');
            let api = '';
            try {
                api = (await client.get<RestApiVersion>('/api/v2/system/restapi/version')).current_version ?? '';
            } catch {
                // reading the package version needs an extra privilege; not required
            }
            await client.get('/api/v2/status/system');
            return `Connected: pfSense ${version.version ?? '?'}${api ? `, REST API ${api}` : ''}`;
        } catch (err) {
            throw new Error(err instanceof ApiError ? describe(err) : errorMessage(err));
        } finally {
            client.close();
        }
    }
}

/** User-facing explanation of a connection-level failure. */
function describe(err: ApiError): string {
    switch (err.kind) {
        case 'auth':
            return `Authentication failed (${err.message}). Check the API key or user name and password, and that the authentication method is enabled under System > REST API.`;
        case 'tls':
            return err.message;
        case 'timeout':
            return `pfSense did not answer in time (${err.message}).`;
        case 'noApi':
            return err.message;
        default:
            return `Cannot reach pfSense: ${err.message}`;
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Pfsense(options);
} else {
    (() => new Pfsense())();
}
