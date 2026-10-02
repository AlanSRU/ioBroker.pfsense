import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';

/** How the server certificate is checked. */
export type TlsMode = 'verify' | 'fingerprint' | 'insecure';

/** Connection settings for {@link PfSenseClient}. */
export interface ClientOptions {
    host: string;
    port: number;
    protocol: 'https' | 'http';
    tlsMode: TlsMode;
    /** SHA-256 fingerprint of the server certificate, used when tlsMode is 'fingerprint'. */
    fingerprint: string;
    auth:
        | {
              kind: 'key';
              apiKey: string;
          }
        | {
              kind: 'basic';
              username: string;
              password: string;
          };
    /** Per-request timeout in milliseconds. */
    timeoutMs: number;
}

/**
 * Category of a failed request. The adapter reacts differently to each:
 * connection-level kinds count against `info.connection`, endpoint-level kinds disable one feature.
 */
export type ApiErrorKind =
    | 'network' // DNS, refused, reset, unreachable
    | 'timeout'
    | 'tls' // certificate rejected or fingerprint mismatch
    | 'auth' // 401
    | 'forbidden' // 403: the API user lacks the privilege for this endpoint
    | 'notFound' // 404 with an API envelope: object or endpoint does not exist
    | 'noApi' // the REST API package is not installed or not reachable under /api/v2
    | 'dependency' // 424: the endpoint needs a package that is not installed (e.g. WireGuard)
    | 'validation' // 400/406/409/415/422: the request was rejected
    | 'server'; // 5xx or unparseable reply

/** A failed API call, classified by {@link ApiErrorKind}. */
export class ApiError extends Error {
    /**
     * @param kind - failure category
     * @param message - human-readable reason
     * @param status - HTTP status, when there was a response
     * @param apiCode - response id from the API envelope
     */
    public constructor(
        public readonly kind: ApiErrorKind,
        message: string,
        public readonly status?: number,
        public readonly apiCode?: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }

    /** True for failures that mean the firewall as a whole is unreachable or unusable. */
    public get isConnectionLevel(): boolean {
        return (
            this.kind === 'network' ||
            this.kind === 'timeout' ||
            this.kind === 'tls' ||
            this.kind === 'auth' ||
            this.kind === 'noApi'
        );
    }
}

/** The envelope every pfSense REST API v2 response is wrapped in. */
interface Envelope<T> {
    code: number;
    status: string;
    response_id: string;
    message: string;
    data: T;
}

export type Query = Record<string, string | number | boolean>;

/** Normalises a fingerprint to upper-case hex pairs separated by colons. */
export function normalizeFingerprint(fp: string): string {
    const hex = fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    return hex.match(/.{1,2}/g)?.join(':') ?? '';
}

/** SHA-256 fingerprint of a DER certificate, in the same format as {@link normalizeFingerprint}. */
export function certFingerprint(raw: Buffer): string {
    return normalizeFingerprint(createHash('sha256').update(raw).digest('hex'));
}

/**
 * HTTPS agent that pins the server certificate by its SHA-256 fingerprint.
 *
 * The socket is handed to the HTTP layer only after the fingerprint matched, so no request
 * (and no credential header) is ever written to a server that failed the check. Chain and
 * hostname validation are replaced by the pin, which is what makes self-signed pfSense
 * certificates usable without turning verification off.
 */
class PinnedAgent extends https.Agent {
    public constructor(private readonly expected: string) {
        super({ keepAlive: true, maxSockets: 2 });
    }

    // Asynchronous form of createConnection: returning undefined makes the agent wait for the callback.
    public createConnection(
        options: tls.ConnectionOptions,
        callback: (err: Error | null, socket?: Duplex) => void,
    ): Duplex | undefined {
        // rejectUnauthorized is false only so the handshake can complete with a self-signed certificate.
        // The connection is accepted only if the certificate's SHA-256 fingerprint matches the pin exactly,
        // and no request byte (no credential) is written before that check: the HTTP layer gets the socket
        // from the callback below, after the comparison.
        const socket = tls.connect({ ...options, rejectUnauthorized: false });
        const onError = (err: Error): void => callback(err);
        socket.once('error', onError);
        socket.once('secureConnect', () => {
            socket.removeListener('error', onError);
            const actual = certFingerprint(socket.getPeerCertificate().raw);
            if (actual !== this.expected) {
                socket.destroy();
                callback(
                    new ApiError(
                        'tls',
                        `Certificate fingerprint mismatch: the firewall presented ${actual}, the configuration expects ${this.expected}`,
                    ),
                );
                return;
            }
            callback(null, socket);
        });
        return undefined;
    }
}

/** Minimal client for the pfSense REST API v2 package (https://github.com/pfrest/pfSense-pkg-RESTAPI). */
export class PfSenseClient {
    private readonly agent: http.Agent;
    private closed = false;

    /** @param opts - connection settings */
    public constructor(private readonly opts: ClientOptions) {
        if (opts.protocol === 'http') {
            this.agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
        } else if (opts.tlsMode === 'fingerprint') {
            this.agent = new PinnedAgent(normalizeFingerprint(opts.fingerprint));
        } else {
            this.agent = new https.Agent({
                keepAlive: true,
                maxSockets: 2,
                // Only when the user explicitly picked "do not verify" in the instance settings.
                rejectUnauthorized: opts.tlsMode !== 'insecure',
            });
        }
    }

    /** GET a resource; resolves the `data` field of the envelope. */
    public get<T>(path: string, query?: Query): Promise<T> {
        return this.request<T>('GET', path, query);
    }

    /** POST a JSON body; resolves the `data` field of the envelope. */
    public post<T>(path: string, body: unknown = {}): Promise<T> {
        return this.request<T>('POST', path, undefined, body);
    }

    /** PATCH a resource with a JSON body; resolves the `data` field of the envelope. */
    public patch<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>('PATCH', path, undefined, body);
    }

    /** Closes kept-alive sockets. Further requests fail. */
    public close(): void {
        this.closed = true;
        this.agent.destroy();
    }

    private request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
        if (this.closed) {
            return Promise.reject(new ApiError('network', 'Client closed'));
        }
        const qs = query
            ? `?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`
            : '';
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const headers: http.OutgoingHttpHeaders = { Accept: 'application/json' };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = payload.length;
        }
        if (this.opts.auth.kind === 'key') {
            headers['X-API-Key'] = this.opts.auth.apiKey;
        } else {
            const token = Buffer.from(`${this.opts.auth.username}:${this.opts.auth.password}`).toString('base64');
            headers.Authorization = `Basic ${token}`;
        }

        const transport = this.opts.protocol === 'http' ? http : https;
        return new Promise<T>((resolve, reject) => {
            const req = transport.request(
                {
                    host: this.opts.host,
                    port: this.opts.port,
                    method,
                    path: `${path}${qs}`,
                    headers,
                    agent: this.agent,
                    timeout: this.opts.timeoutMs,
                    signal: AbortSignal.timeout(this.opts.timeoutMs),
                },
                res => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('error', err => reject(classifyNetworkError(err)));
                    res.on('end', () => {
                        try {
                            resolve(parseResponse<T>(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')));
                        } catch (err) {
                            reject(err instanceof Error ? err : new Error(String(err)));
                        }
                    });
                },
            );
            req.on('timeout', () => req.destroy(new ApiError('timeout', `No answer within ${this.opts.timeoutMs} ms`)));
            req.on('error', err => reject(classifyNetworkError(err)));
            if (payload) {
                req.write(payload);
            }
            req.end();
        });
    }
}

/** Turns a raw response into data or an {@link ApiError}. Exported for unit tests. */
export function parseResponse<T>(status: number, text: string): T {
    let env: Envelope<T> | undefined;
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed) {
            env = parsed as Envelope<T>;
        }
    } catch {
        // not JSON: handled below
    }

    if (!env) {
        // pfSense answers unknown paths with its HTML login page or a redirect, so a non-envelope
        // reply means the package is missing (or something other than pfSense is listening).
        if (status === 401 || status === 403) {
            return fail('auth', status, 'Authentication rejected');
        }
        if (status >= 500) {
            return fail('server', status, `Server error (HTTP ${status})`);
        }
        throw new ApiError(
            'noApi',
            `No REST API answer (HTTP ${status}). Is the pfSense REST API package installed and enabled?`,
            status,
        );
    }

    if (status >= 200 && status < 300) {
        return env.data;
    }
    const msg = env.message || env.status || `HTTP ${status}`;
    switch (status) {
        case 401:
            return fail('auth', status, msg, env.response_id);
        case 403:
            return fail('forbidden', status, msg, env.response_id);
        case 404:
            return fail('notFound', status, msg, env.response_id);
        case 424:
            return fail('dependency', status, msg, env.response_id);
        default:
            return fail(status >= 500 ? 'server' : 'validation', status, msg, env.response_id);
    }
}

function fail(kind: ApiErrorKind, status: number, message: string, apiCode?: string): never {
    throw new ApiError(kind, message, status, apiCode);
}

function classifyNetworkError(err: Error): ApiError {
    if (err instanceof ApiError) {
        return err;
    }
    // AbortSignal.timeout rejects with a TimeoutError/AbortError
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return new ApiError('timeout', 'Request timed out');
    }
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate/i.test(err.message)) {
        return new ApiError(
            'tls',
            `TLS check failed (${code || err.message}). For a self-signed certificate use the fingerprint option.`,
        );
    }
    return new ApiError('network', `${code ? `${code}: ` : ''}${err.message}`);
}

/**
 * Connects once and returns the SHA-256 fingerprint of the certificate the server presents,
 * without sending any request. Used by the "read fingerprint" button in the instance settings.
 */
export function fetchFingerprint(host: string, port: number, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host,
            port,
            servername: isIP(host) ? undefined : host,
            // Nothing is ever sent on this socket: it only reads the certificate so the user can compare and pin it.
            // Verification cannot be on here, because reading an untrusted (self-signed) certificate is the purpose.
            rejectUnauthorized: false,
        });
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`No TLS handshake within ${timeoutMs} ms`)));
        socket.once('secureConnect', () => {
            const fp = certFingerprint(socket.getPeerCertificate().raw);
            socket.end();
            resolve(fp);
        });
        socket.once('error', reject);
    });
}
