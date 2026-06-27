'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  PETclub — Postgres-backed express-rate-limit Store
 *  services/pgRateLimitStore.js
 * ══════════════════════════════════════════════════════════════════
 *
 *  Why:
 *    Cloud Run scales to multiple instances. express-rate-limit's
 *    default MemoryStore is per-process — a 5-OTP-per-minute rule
 *    allows 5 × N_INSTANCES attempts before any instance fires.
 *
 *  How:
 *    A single shared `rate_limits` table in Supabase Postgres.
 *    Each row is keyed by a "windowKey" — "{route}:{ip}:{windowStart}".
 *    `increment()` does an atomic UPSERT (no read-modify-write race).
 *
 *  Schema (run supabase-ratelimit-migration.sql):
 *    CREATE TABLE rate_limits (
 *      key        TEXT        NOT NULL,
 *      count      INTEGER     NOT NULL DEFAULT 1,
 *      reset_at   TIMESTAMPTZ NOT NULL,
 *      PRIMARY KEY (key)
 *    );
 *    CREATE INDEX ON rate_limits (reset_at);  -- for cleanup
 *
 *  express-rate-limit v7 Store interface:
 *    increment(key)         → { totalHits, resetTime }
 *    decrement(key)         → void
 *    resetKey(key)          → void
 *    resetAll()             → void   (optional — used in tests only)
 *    init({ windowMs })     → void   (called by rateLimit() on setup)
 *
 *  Fallback:
 *    If the Postgres pool fails to connect (missing env vars, cold-
 *    start) the store logs a warning and falls back to counting in
 *    local memory for that window.  This is intentional: a rate
 *    limiter that blocks ALL traffic on DB error is worse than a
 *    slightly-porous one.  The Cloud Run health-check + Supabase
 *    connection test at startup catches persistent failures early.
 *
 * ══════════════════════════════════════════════════════════════════
 */

const { Pool } = require('pg');

// ── Postgres connection pool ──────────────────────────────────────────────────
// Reuse DATABASE_URL if set; otherwise connect directly to Supabase using
// Pool options (avoids URL-encoding issues with passwords containing @ etc.).
function buildPoolOptions() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const url    = process.env.SUPABASE_URL;
  const dbPass = process.env.SUPABASE_DB_PASSWORD;
  if (!url || !dbPass) {
    console.warn('[RateLimit] No Postgres credentials available — using memory fallback');
    return null;
  }
  // Direct host: db.{ref}.supabase.co — always reachable from Cloud Run,
  // avoids Supavisor pooler "tenant not found" errors.
  const ref  = url.replace('https://', '').split('.')[0];
  const host = `db.${ref}.supabase.co`;
  return { host, port: 5432, user: 'postgres', password: dbPass, database: 'postgres' };
}

let _pool = null;
function getPool() {
  if (_pool) return _pool;
  const opts = buildPoolOptions();
  if (!opts) return null;
  _pool = new Pool({
    ...opts,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
    ssl: { rejectUnauthorized: false },
  });
  _pool.on('error', (err) => {
    console.error('[RateLimit] Postgres pool error:', err.message);
  });
  return _pool;
}

// ── Memory fallback (single-instance safety net) ──────────────────────────────
const memStore = new Map();    // key → { count, resetAt }

// ── PgRateLimitStore class ─────────────────────────────────────────────────────
class PgRateLimitStore {
  constructor() {
    this.windowMs = 60_000;     // overwritten by init()
    this.prefix   = 'rl';       // allows multiple stores in same table
  }

  // Called once by express-rate-limit when the middleware is created
  init({ windowMs }) {
    this.windowMs = windowMs;
    // Ensure the table exists — run-once check, non-blocking
    this._ensureTable().catch(e =>
      console.warn('[RateLimit] ensureTable failed (non-fatal):', e.message)
    );
    // Cleanup old rows every 10 minutes (only this instance, but harmless overlap)
    this._cleanupInterval = setInterval(() => {
      this._cleanup().catch(() => {});
    }, 10 * 60_000);
    // Don't keep the process alive for this timer
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  // ── Atomic increment ────────────────────────────────────────────────────────
  async increment(key) {
    const windowKey = `${this.prefix}:${key}`;
    const pool      = getPool();

    if (!pool) return this._memIncrement(windowKey);

    try {
      const resetAt = new Date(Date.now() + this.windowMs);
      // UPSERT: insert count=1 on first hit; add 1 on every subsequent hit.
      // reset_at is set only on INSERT (first hit in window) so it doesn't
      // slide forward on every request.
      const { rows } = await pool.query(
        `INSERT INTO rate_limits (key, count, reset_at)
         VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE
           SET count = CASE
             WHEN rate_limits.reset_at <= NOW() THEN 1        -- window expired: reset
             ELSE rate_limits.count + 1                       -- still in window: increment
           END,
           reset_at = CASE
             WHEN rate_limits.reset_at <= NOW() THEN $2       -- new window start
             ELSE rate_limits.reset_at                        -- keep original window
           END
         RETURNING count, reset_at`,
        [windowKey, resetAt]
      );
      const row = rows[0];
      return {
        totalHits: row.count,
        resetTime: new Date(row.reset_at),
      };
    } catch (err) {
      console.warn('[RateLimit] increment DB error — memory fallback:', err.message);
      return this._memIncrement(windowKey);
    }
  }

  // ── Decrement (used by skipSuccessfulRequests option) ──────────────────────
  async decrement(key) {
    const windowKey = `${this.prefix}:${key}`;
    const pool      = getPool();
    if (!pool) { this._memDecrement(windowKey); return; }
    try {
      await pool.query(
        `UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE key = $1`,
        [windowKey]
      );
    } catch (err) {
      this._memDecrement(windowKey);
    }
  }

  // ── Reset a single key (e.g. after successful OTP verify) ──────────────────
  async resetKey(key) {
    const windowKey = `${this.prefix}:${key}`;
    const pool      = getPool();
    if (!pool) { memStore.delete(windowKey); return; }
    try {
      await pool.query(`DELETE FROM rate_limits WHERE key = $1`, [windowKey]);
    } catch (_) {
      memStore.delete(windowKey);
    }
  }

  // ── Reset all (test helper) ─────────────────────────────────────────────────
  async resetAll() {
    const pool = getPool();
    memStore.clear();
    if (!pool) return;
    try {
      await pool.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`${this.prefix}:%`]);
    } catch (_) {}
  }

  // ── Private helpers ─────────────────────────────────────────────────────────
  _memIncrement(key) {
    const now  = Date.now();
    const entry = memStore.get(key);
    if (!entry || entry.resetAt <= now) {
      const resetAt = new Date(now + this.windowMs);
      memStore.set(key, { count: 1, resetAt });
      return { totalHits: 1, resetTime: resetAt };
    }
    entry.count += 1;
    return { totalHits: entry.count, resetTime: entry.resetAt };
  }

  _memDecrement(key) {
    const entry = memStore.get(key);
    if (entry) entry.count = Math.max(0, entry.count - 1);
  }

  async _ensureTable() {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key       TEXT        NOT NULL PRIMARY KEY,
        count     INTEGER     NOT NULL DEFAULT 1,
        reset_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON rate_limits (reset_at);
    `);
  }

  async _cleanup() {
    const pool = getPool();
    if (!pool) return;
    // Delete rows whose window has expired; keeps the table small
    await pool.query(`DELETE FROM rate_limits WHERE reset_at < NOW() - INTERVAL '1 minute'`);
  }
}

module.exports = { PgRateLimitStore };
