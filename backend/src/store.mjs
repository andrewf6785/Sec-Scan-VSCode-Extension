import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export class ServiceError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export class Store {
    constructor(pool, limits = {}) {
        this.pool = pool;
        this.limits = { registrationDaily: 100, installations: 10000, perHour: 3, perDay: 5, globalDaily: 50, concurrent: 2, ...limits };
    }
    async init() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS secscan_guard (id integer PRIMARY KEY CHECK (id = 1));
            INSERT INTO secscan_guard VALUES (1) ON CONFLICT DO NOTHING;
            CREATE TABLE IF NOT EXISTS secscan_installations (
                id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(), revoked boolean NOT NULL DEFAULT false
            );
            CREATE TABLE IF NOT EXISTS secscan_events (
                id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES secscan_installations(id),
                kind text NOT NULL CHECK (kind IN ('registration','review')),
                created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz
            );
            CREATE INDEX IF NOT EXISTS secscan_events_time ON secscan_events(created_at);
            CREATE INDEX IF NOT EXISTS secscan_events_installation ON secscan_events(installation_id, created_at);
        `);
    }
    async transaction(fn) {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            // One shared row serializes admission, including across server instances.
            await db.query('SELECT id FROM secscan_guard WHERE id = 1 FOR UPDATE');
            await db.query("DELETE FROM secscan_events WHERE created_at < now() - interval '48 hours' AND (lease_until IS NULL OR lease_until < now())");
            const result = await fn(db);
            await db.query('COMMIT');
            return result;
        } catch (e) { await db.query('ROLLBACK'); throw e; }
        finally { db.release(); }
    }
    async register() {
        return this.transaction(async db => {
            const count = Number((await db.query('SELECT count(*) AS n FROM secscan_installations')).rows[0].n);
            const daily = Number((await db.query("SELECT count(*) AS n FROM secscan_events WHERE kind = 'registration' AND created_at > now() - interval '24 hours'")).rows[0].n);
            if (count >= this.limits.installations || daily >= this.limits.registrationDaily) {
                throw new ServiceError(429, 'registration_limit', 'New installation registration is temporarily unavailable.');
            }
            const token = randomBytes(32).toString('hex'); const id = randomUUID();
            await db.query('INSERT INTO secscan_installations(id, token_hash) VALUES ($1,$2)', [id, hashToken(token)]);
            await db.query("INSERT INTO secscan_events(id, installation_id, kind) VALUES ($1,$2,'registration')", [randomUUID(), id]);
            return { token, installationId: id };
        });
    }
    async authenticate(token) {
        if (!/^[a-f0-9]{64}$/.test(token || '')) throw new ServiceError(401, 'invalid_installation', 'Installation credential is invalid. Contact the service owner.');
        const found = (await this.pool.query('SELECT id, revoked FROM secscan_installations WHERE token_hash = $1', [hashToken(token)])).rows[0];
        if (!found) throw new ServiceError(401, 'invalid_installation', 'Installation credential is invalid. Contact the service owner.');
        if (found.revoked) throw new ServiceError(403, 'revoked_installation', 'This installation has been disabled. Contact the service owner.');
        return found.id;
    }
    async reserve(id) {
        return this.transaction(async db => {
            // Recheck inside admission transaction in case it was revoked after authentication.
            const found = (await db.query('SELECT revoked FROM secscan_installations WHERE id = $1 FOR UPDATE', [id])).rows[0];
            if (!found || found.revoked) throw new ServiceError(403, 'revoked_installation', 'This installation has been disabled.');
            const stats = (await db.query(`SELECT
                count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS global_daily,
                count(*) FILTER (WHERE installation_id = $1 AND created_at > now() - interval '1 hour') AS own_hour,
                count(*) FILTER (WHERE installation_id = $1 AND created_at > now() - interval '24 hours') AS own_day,
                count(*) FILTER (WHERE lease_until > now()) AS active,
                count(*) FILTER (WHERE installation_id = $1 AND lease_until > now()) AS own_active
                FROM secscan_events WHERE kind = 'review'`, [id])).rows[0];
            if (Number(stats.global_daily) >= this.limits.globalDaily) throw new ServiceError(429, 'global_limit', 'The service has reached its global review limit. Try again later.');
            if (Number(stats.own_hour) >= this.limits.perHour || Number(stats.own_day) >= this.limits.perDay) throw new ServiceError(429, 'installation_limit', 'This installation has reached its review allowance. Try again later.');
            if (Number(stats.active) >= this.limits.concurrent || Number(stats.own_active)) throw new ServiceError(429, 'busy', 'A review is already running or the service is busy.');
            const reviewId = randomUUID();
            // Crash recovery: the lease exceeds the four-minute upstream deadline.
            await db.query("INSERT INTO secscan_events(id, installation_id, kind, lease_until) VALUES ($1,$2,'review',now() + interval '6 minutes')", [reviewId, id]);
            return reviewId;
        });
    }
    async release(reviewId) {
        await this.pool.query('UPDATE secscan_events SET lease_until = NULL WHERE id = $1', [reviewId]);
    }
}
