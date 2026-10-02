// Test double for a pfSense firewall running the REST API v2 package.
// Serves fixture data over HTTPS with a self-signed certificate, checks the API key, applies
// exact-match query filters like the real package and records every request for assertions.
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

export const API_KEY = 'test-api-key-0123456789abcdef';

const cert = readFileSync(path.join(__dirname, 'fixtures', 'test-cert.pem'));
const key = readFileSync(path.join(__dirname, 'fixtures', 'test-key.pem'));

/** SHA-256 fingerprint of the mock's certificate, formatted like the adapter expects. */
export const CERT_FINGERPRINT = new X509Certificate(cert).fingerprint256;

export interface RecordedRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
}

type Handler = (req: RecordedRequest) => { status: number; body: unknown; raw?: boolean } | undefined;

export class MockPfSense {
    public readonly requests: RecordedRequest[] = [];
    /** GET data by path. Plural endpoints are arrays; each item gets its list index as `id`. */
    public data: Record<string, unknown> = {};
    /** Overrides by "METHOD path"; checked before the data map. */
    public handlers: Record<string, Handler> = {};
    /** Simulates the REST API package being absent (e.g. during an update): every path gets the HTML login page. */
    public apiGone = false;
    /** Extra delay before every answer, to test timeouts. */
    public delayMs = 0;
    private server?: https.Server;

    public async start(): Promise<number> {
        this.server = https.createServer({ cert, key }, (req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const url = new URL(req.url ?? '/', 'https://mock');
                const text = Buffer.concat(chunks).toString('utf8');
                const rec: RecordedRequest = {
                    method: req.method ?? 'GET',
                    path: url.pathname,
                    query: Object.fromEntries(url.searchParams),
                    headers: req.headers,
                    body: text ? JSON.parse(text) : undefined,
                };
                this.requests.push(rec);
                const answer = (): void => {
                    const r = this.answer(rec);
                    res.writeHead(r.status, { 'Content-Type': r.raw ? 'text/html' : 'application/json' });
                    res.end(r.raw ? String(r.body) : JSON.stringify(r.body));
                };
                if (this.delayMs) {
                    // test helper, not adapter code
                    globalThis.setTimeout(answer, this.delayMs);
                } else {
                    answer();
                }
            });
        });
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
        return (this.server.address() as AddressInfo).port;
    }

    public async stop(): Promise<void> {
        this.server?.closeAllConnections();
        await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
    }

    /** Requests that reached the API with a given method and path. */
    public calls(method: string, p: string): RecordedRequest[] {
        return this.requests.filter(r => r.method === method && r.path === p);
    }

    private answer(req: RecordedRequest): { status: number; body: unknown; raw?: boolean } {
        if (this.apiGone || !req.path.startsWith('/api/v2/')) {
            // pfSense answers foreign paths with its HTML login page
            return { status: 200, body: '<html><body>pfSense login</body></html>', raw: true };
        }
        if (req.headers['x-api-key'] !== API_KEY) {
            return envelope(401, 'Authentication failed', []);
        }
        const custom = this.handlers[`${req.method} ${req.path}`]?.(req);
        if (custom) {
            return custom;
        }
        if (req.method !== 'GET') {
            return envelope(200, 'ok', req.body ?? {});
        }
        if (!(req.path in this.data)) {
            return envelope(404, 'Endpoint not found', []);
        }
        let d = this.data[req.path];
        if (Array.isArray(d)) {
            d = d
                .map((item: Record<string, unknown>, id): Record<string, unknown> => ({ id, ...item }))
                .filter(item => Object.entries(req.query).every(([k, v]) => String(item[k]) === v));
        }
        return envelope(200, 'ok', d);
    }
}

export function envelope(code: number, message: string, data: unknown): { status: number; body: unknown } {
    return {
        status: code,
        body: {
            code,
            status: code < 300 ? 'ok' : 'error',
            response_id: code < 300 ? 'SUCCESS' : 'MOCK_ERROR',
            message,
            data,
            _links: [],
        },
    };
}

/** Fingerprint of any certificate, for tests that need a wrong one. */
export function fingerprintOf(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}
