import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.mjs';
import { Store, hashToken } from '../src/store.mjs';

// Run the actual PostgreSQL schema and queries in PGlite. Its single connection
// needs a serialized pool adapter. Production uses pg.Pool and SQL row locks.
async function database(t) {
    const db = new PGlite(); await db.waitReady;
    let tail = Promise.resolve();
    const pool = {
        async connect() {
            const previous = tail; let release;
            tail = new Promise(resolve => { release = resolve; });
            await previous;
            return { query: (sql, args) => args ? db.query(sql, args) : db.exec(sql).then(rows => rows.at(-1)), release };
        },
        async query(sql, args) {
            const client = await this.connect();
            try { return await client.query(sql, args); } finally { client.release(); }
        }
    };
    t.after(() => db.close());
    return pool;
}
const input = { code: 'print("test")', filename: 'example.py', language: 'python', startLine: 1 };
async function setup(t, generate = async () => '# Findings\nIssue\nSECURITY REVIEW COVERAGE\nCovered', limits = {}, options = {}) {
    const pool = await database(t); const store = new Store(pool, limits); await store.init();
    const server = createApp({ store, generate, ...options });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const register = () => fetch(url + '/register', { method: 'POST' });
    const post = (token, body = input) => fetch(url + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { url, store, pool, register, post };
}
test('automatic registration, hashed storage, persistent identity and quotas', async t => {
    const { register, store, pool, post } = await setup(t, undefined, { perHour: 1 });
    const res = await register(); assert.equal(res.status, 201);
    const { token, installationId } = await res.json();
    assert.match(token, /^[a-f0-9]{64}$/);
    const row = (await pool.query('SELECT * FROM secscan_installations')).rows[0];
    assert.equal(row.token_hash, hashToken(token)); assert.notEqual(row.token_hash, token);
    assert.equal((await post(token)).status, 200);
    const restarted = new Store(pool, { perHour: 1 }); await restarted.init();
    assert.equal(await restarted.authenticate(token), installationId);
    await assert.rejects(restarted.reserve(installationId), e => e.code === 'installation_limit');
});
test('registration limits persist and concurrent registration cannot bypass the cap', async t => {
    const { register, pool } = await setup(t, undefined, { registrationDaily: 2 });
    const responses = await Promise.all(Array.from({ length: 6 }, () => register()));
    assert.equal(responses.filter(r => r.status === 201).length, 2);
    assert.equal(responses.filter(r => r.status === 429).length, 4);
    const restarted = new Store(pool, { registrationDaily: 2 });
    await assert.rejects(restarted.register(), e => e.code === 'registration_limit');
    await pool.query("UPDATE secscan_events SET created_at = now() - interval '25 hours'");
    assert.ok((await restarted.register()).token);
});
test('new installations cannot bypass the persistent global allowance', async t => {
    const { store, pool } = await setup(t, undefined, { globalDaily: 2, concurrent: 10 });
    const installations = await Promise.all(Array.from({ length: 5 }, () => store.register()));
    const results = await Promise.allSettled(installations.map(x => store.reserve(x.installationId)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'global_limit'));
    const restarted = new Store(pool, { globalDaily: 2 });
    await assert.rejects(restarted.reserve(installations[4].installationId), e => e.code === 'global_limit');
});
test('invalid/revoked tokens, invalid inputs and database errors never call model', async t => {
    let calls = 0;
    const { register, post, pool, store } = await setup(t, async () => { calls++; return 'unused'; });
    const { token, installationId } = await (await register()).json();
    assert.equal((await post('b'.repeat(64))).status, 401);
    assert.equal((await post(token, { ...input, code: 'x\n'.repeat(5001) })).status, 400);
    assert.equal((await post(token, { ...input, filename: '../secret' })).status, 400);
    await pool.query('UPDATE secscan_installations SET revoked = true WHERE id = $1', [installationId]);
    assert.equal((await post(token)).status, 403);
    store.authenticate = async () => { throw new Error('private db error'); };
    const unavailable = await post(token); assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /private/); assert.equal(calls, 0);
});
test('model failure releases lease; failed attempts still count', async t => {
    const { register, post } = await setup(t, async () => { throw new Error('private model error'); }, { perHour: 2 });
    const { token } = await (await register()).json();
    for (let i = 0; i < 2; i++) {
        const res = await post(token); assert.equal(res.status, 502); assert.doesNotMatch(await res.text(), /private/);
    }
    assert.equal((await post(token)).status, 429);
});
test('active leases survive restart, expire after a crash, and retain usage count', async t => {
    const { store, pool } = await setup(t);
    const { installationId } = await store.register();
    const lease = await store.reserve(installationId);
    const restarted = new Store(pool);
    await assert.rejects(restarted.reserve(installationId), e => e.code === 'busy');
    await pool.query("UPDATE secscan_events SET lease_until = now() - interval '1 minute' WHERE id = $1", [lease]);
    assert.ok(await restarted.reserve(installationId));
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM secscan_events WHERE kind='review'")).rows[0].n), 2);
});
test('compiled client registers, reviews and saves unique Markdown; raw recovery works', async t => {
    const require = createRequire(import.meta.url);
    const { reviewCode, backendUrl, registerInstallation } = require('../../extension/out/secScan.js');
    const { saveReports } = require('../../extension/out/saveReports.js');
    let output = '# Findings\r\nIssue\r\n## **Security Review Coverage:**\r\nCovered';
    const { url, pool } = await setup(t, async () => output);
    const endpoint = backendUrl(url); const signal = new AbortController().signal;
    const token = await registerInstallation(endpoint, signal);
    const review = () => reviewCode(input.code, input.filename, input.language, 1, endpoint, token, signal);
    const result = await review();
    assert.equal(result.reports[1].text, '## **Security Review Coverage:**\r\nCovered');
    const dir = await mkdtemp(join(tmpdir(), 'secscan-auto-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const first = await saveReports(dir, input.filename, result.reports);
    const second = await saveReports(dir, input.filename, result.reports);
    assert.match(second[0], /example_2.md$/);
    assert.equal(await readFile(first[0], 'utf8'), '# Findings\r\nIssue\r\n');
    output = 'Missing coverage';
    assert.equal((await review()).reports[0].prefix, 'security_review_raw_response');
    await pool.query('UPDATE secscan_installations SET revoked = true');
    await assert.rejects(review(), /invalid or disabled/);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM secscan_installations')).rows[0].n), 1);
});
test('cancellation aborts model, releases lease, and keeps admission counted', async t => {
    const require = createRequire(import.meta.url);
    const { reviewCode, backendUrl } = require('../../extension/out/secScan.js');
    let start, abort;
    const started = new Promise(resolve => { start = resolve; });
    const aborted = new Promise(resolve => { abort = resolve; });
    let first = true;
    const { url, register, post, pool } = await setup(t, async (_, signal) => {
        if (!first) return 'Findings\nSECURITY REVIEW COVERAGE\nCovered';
        first = false; start();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => { abort(); reject(new Error('cancelled')); }, { once: true }));
    });
    const { token } = await (await register()).json();
    const controller = new AbortController();
    const pending = reviewCode(input.code, input.filename, input.language, 1, backendUrl(url), token, controller.signal);
    const rejected = assert.rejects(pending, /abort/i);
    await started; controller.abort(); await rejected; await aborted;
    // Wait on the shared DB connection, then the lease release queued by finally.
    await new Promise(resolve => setImmediate(resolve));
    await pool.query('SELECT 1');
    assert.equal((await post(token)).status, 200);
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM secscan_events WHERE kind='review'")).rows[0].n), 2);
});
