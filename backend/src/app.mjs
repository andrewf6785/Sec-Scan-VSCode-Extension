import { createServer } from 'node:http';
import { ServiceError } from './store.mjs';
import { splitResponse } from './splitResponse.mjs';

export function createApp({ store, generate, registrationEnabled = true, timeoutMs = 240_000 }) {
    const reply = (res, status, data) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(data));
    };
    return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') { reply(res, 200, { ok: true }); return; }
        if (req.method === 'POST' && req.url === '/register') {
            req.resume();
            try {
                if (!registrationEnabled) throw new ServiceError(503, 'registration_closed', 'New installations are temporarily disabled.');
                const registration = await store.register();
                reply(res, 201, registration);
            } catch (e) {
                reply(res, e instanceof ServiceError ? e.status : 503, {
                    code: e instanceof ServiceError ? e.code : 'unavailable',
                    error: e instanceof ServiceError ? e.message : 'Registration service unavailable.'
                });
            }
            return;
        }
        if (req.method !== 'POST' || req.url !== '/review') { reply(res, 404, { error: 'Not found.' }); return; }
        let installationId;
        try {
            const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
            installationId = await store.authenticate(token);
        } catch (e) {
            reply(res, e instanceof ServiceError ? e.status : 503, {
                code: e instanceof ServiceError ? e.code : 'unavailable',
                error: e instanceof ServiceError ? e.message : 'Review service unavailable.'
            }); req.resume(); return;
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { reply(res, 415, { error: 'Use application/json.' }); req.resume(); return; }
        let reviewId;
        const controller = new AbortController();
        const closed = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', closed);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const chunks = []; let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 8 * 1024 * 1024) { reply(res, 413, { error: 'Input too large.' }); return; }
                chunks.push(chunk);
            }
            let input;
            try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { reply(res, 400, { error: 'Invalid JSON.' }); return; }
            if (!input || typeof input.code !== 'string' || !input.code.trim() || Buffer.byteLength(input.code) > 1024 * 1024 ||
                input.code.replace(/\r?\n$/, '').split(/\r\n|\n|\r/).length > 5000 ||
                typeof input.filename !== 'string' || !input.filename || input.filename.length > 255 || /[\r\n/\\]/.test(input.filename) ||
                typeof input.language !== 'string' || !/^[\w+-]{1,64}$/.test(input.language) ||
                !Number.isSafeInteger(input.startLine) || input.startLine < 1) {
                reply(res, 400, { error: 'Invalid code or metadata (maximum 5,000 lines and 1MiB of code).' }); return;
            }
            controller.signal.throwIfAborted();
            reviewId = await store.reserve(installationId);
            controller.signal.throwIfAborted(); // Database admission counts even if the client just cancelled.
            const text = await generate(input, controller.signal);
            controller.signal.throwIfAborted();
            if (typeof text !== 'string' || !text.trim()) throw new Error('Empty output');
            let parts;
            try { parts = splitResponse(text); }
            catch {
                reply(res, 200, { reports: [{ prefix: 'security_review_raw_response', text }], warning: 'Coverage heading missing; raw response preserved.' });
                return;
            }
            reply(res, 200, { reports: [
                { prefix: 'security_review_findings', text: parts.findings },
                { prefix: 'security_review_coverage', text: parts.coverage }
            ] });
        } catch (e) {
            // Do not log request bodies, credentials, or raw upstream errors.
            reply(res, e instanceof ServiceError ? e.status : controller.signal.aborted ? 504 : 502, { code: e instanceof ServiceError ? e.code : 'review_failed', error: e instanceof ServiceError ? e.message : 'Review could not complete.' });
        } finally {
            clearTimeout(timer); res.off('close', closed);
            if (reviewId) { try { await store.release(reviewId); } catch { console.error('Review lease release failed; it will expire automatically.'); } }
        }
    });
}
