import { expect } from 'chai';
import { API_KEY, CERT_FINGERPRINT, envelope, MockPfSense } from '../../test/mock-pfsense';
import {
    ApiError,
    type ClientOptions,
    fetchFingerprint,
    normalizeFingerprint,
    parseResponse,
    PfSenseClient,
} from './client';

describe('PfSenseClient', () => {
    const mock = new MockPfSense();
    let port = 0;
    const clients: PfSenseClient[] = [];

    const make = (o: Partial<ClientOptions> = {}): PfSenseClient => {
        const c = new PfSenseClient({
            host: '127.0.0.1',
            port,
            protocol: 'https',
            tlsMode: 'fingerprint',
            fingerprint: CERT_FINGERPRINT,
            auth: { kind: 'key', apiKey: API_KEY },
            timeoutMs: 2000,
            ...o,
        });
        clients.push(c);
        return c;
    };

    before(async () => {
        port = await mock.start();
        mock.data['/api/v2/system/version'] = { version: '2.8.1-RELEASE' };
        mock.data['/api/v2/firewall/rules'] = [{ tracker: 1 }, { tracker: 2 }];
    });
    afterEach(() => {
        mock.requests.length = 0;
        mock.delayMs = 0;
        mock.handlers = {};
        clients.splice(0).forEach(c => c.close());
    });
    after(() => mock.stop());

    it('unwraps the data envelope and sends the API key', async () => {
        const v = await make().get<{ version: string }>('/api/v2/system/version');
        expect(v.version).to.equal('2.8.1-RELEASE');
        expect(mock.requests[0].headers['x-api-key']).to.equal(API_KEY);
    });

    it('passes query filters', async () => {
        const rules = await make().get<Array<{ tracker: number; id: number }>>('/api/v2/firewall/rules', {
            tracker: 2,
        });
        expect(rules).to.deep.equal([{ id: 1, tracker: 2 }]);
    });

    it('accepts a pinned self-signed certificate', async () => {
        await make({ fingerprint: CERT_FINGERPRINT.replace(/:/g, '').toLowerCase() }).get('/api/v2/system/version');
    });

    it('refuses a fingerprint mismatch before sending anything', async () => {
        const wrong = normalizeFingerprint('00'.repeat(32));
        const err = await make({ fingerprint: wrong })
            .get('/api/v2/system/version')
            .catch((e: unknown) => e);
        expect(err).to.be.instanceOf(ApiError);
        expect((err as ApiError).kind).to.equal('tls');
        expect(mock.requests).to.have.length(0);
    });

    it('rejects a self-signed certificate in verify mode', async () => {
        const err = await make({ tlsMode: 'verify' })
            .get('/api/v2/system/version')
            .catch((e: unknown) => e);
        expect((err as ApiError).kind).to.equal('tls');
        expect(mock.requests).to.have.length(0);
    });

    it('works without verification only when asked to', async () => {
        await make({ tlsMode: 'insecure' }).get('/api/v2/system/version');
    });

    it('classifies a wrong key as auth', async () => {
        const err = await make({ auth: { kind: 'key', apiKey: 'nope' } })
            .get('/api/v2/system/version')
            .catch((e: unknown) => e);
        expect((err as ApiError).kind).to.equal('auth');
        expect((err as ApiError).isConnectionLevel).to.equal(true);
    });

    it('sends basic auth when configured', async () => {
        await make({ auth: { kind: 'basic', username: 'admin', password: 'pw' } })
            .get('/api/v2/system/version')
            .catch(() => undefined);
        expect(mock.requests[0].headers.authorization).to.equal(`Basic ${Buffer.from('admin:pw').toString('base64')}`);
    });

    it('times out', async () => {
        mock.delayMs = 500;
        const err = await make({ timeoutMs: 100 })
            .get('/api/v2/system/version')
            .catch((e: unknown) => e);
        expect((err as ApiError).kind).to.equal('timeout');
    });

    it('reports a connection refusal as network', async () => {
        const err = await make({ port: 1 })
            .get('/api/v2/system/version')
            .catch((e: unknown) => e);
        expect((err as ApiError).kind).to.equal('network');
    });

    it('sends JSON bodies', async () => {
        mock.handlers['POST /api/v2/status/service'] = req => envelope(200, 'ok', req.body);
        const r = await make().post<{ action: string }>('/api/v2/status/service', { id: 1, action: 'restart' });
        expect(r.action).to.equal('restart');
        expect(mock.requests[0].headers['content-type']).to.equal('application/json');
    });

    it('reads the certificate fingerprint', async () => {
        expect(await fetchFingerprint('127.0.0.1', port, 2000)).to.equal(CERT_FINGERPRINT);
    });
});

describe('parseResponse', () => {
    const env = (code: number): string =>
        JSON.stringify({ code, status: 'x', response_id: 'R', message: 'm', data: { a: 1 } });

    it('maps status codes to kinds', () => {
        const kinds: Record<number, string> = {
            401: 'auth',
            403: 'forbidden',
            404: 'notFound',
            424: 'dependency',
            400: 'validation',
            500: 'server',
        };
        for (const [code, kind] of Object.entries(kinds)) {
            expect(() => parseResponse(Number(code), env(Number(code))))
                .to.throw(ApiError)
                .with.property('kind', kind);
        }
    });

    it('treats a non-API answer as a missing package', () => {
        expect(() => parseResponse(200, '<html>login</html>'))
            .to.throw(ApiError)
            .with.property('kind', 'noApi');
        expect(() => parseResponse(302, ''))
            .to.throw(ApiError)
            .with.property('kind', 'noApi');
    });

    it('returns data on success', () => {
        expect(parseResponse(200, env(200))).to.deep.equal({ a: 1 });
    });
});
