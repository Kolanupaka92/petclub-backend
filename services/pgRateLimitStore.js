'use strict';
/**
 * PETclub — Supabase REST-backed express-rate-limit store
 *
 * Uses the Supabase JS client (HTTPS/REST) instead of direct Postgres —
 * direct Postgres ports (5432, 6543) are blocked from Cloud Run egress.
 * The REST API is always reachable via port 443.
 *
 * Atomic increment is handled by a Postgres function (rate_limit_increment)
 * called via supabase.rpc() — no read-modify-write race condition.
 *
 * Falls back to per-instance memory if Supabase is unreachable (same
 * behaviour as before — better porous than fully blocking on DB error).
 */

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, {
    realtime: { transport: ws },   // Node 20 has no native WebSocket; ws package fills the gap
  });
  return _client;
}

// ── Memory fallback (single-instance safety net) ──────────────────────────────
const memStore = new Map();

class PgRateLimitStore {
  // `prefix` namespaces this limiter's keys in the shared rate_limits table.
  // Every limiter previously used the hardcoded 'rl' prefix with IP-only keys,
  // so e.g. the OTP-send limiter (5 min window) and the login-attempt limiter
  // (15 min window) wrote to and read from the SAME row per IP — hits on one
  // route could trip an unrelated limiter, and whichever limiter fired last
  // clobbered the others' reset time. Callers must pass a unique prefix.
  constructor(prefix = 'rl') {
    this.windowMs = 60_000;
    this.prefix   = prefix;
  }

  init({ windowMs }) {
    this.windowMs = windowMs;
    this._cleanupInterval = setInterval(() => this._cleanup(), 10 * 60_000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  async increment(key) {
    const windowKey = `${this.prefix}:${key}`;
    const client    = getClient();
    if (!client) return this._memIncrement(windowKey);

    try {
      const resetAt = new Date(Date.now() + this.windowMs).toISOString();
      const { data, error } = await client.rpc('rate_limit_increment', {
        p_key: windowKey,
        p_reset_at: resetAt,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        totalHits:  row?.hit_count   ?? 1,
        resetTime:  new Date(row?.window_reset_at ?? (Date.now() + this.windowMs)),
      };
    } catch (err) {
      console.warn('[RateLimit] increment REST error → memory fallback:', err.message);
      return this._memIncrement(windowKey);
    }
  }

  async decrement(key) {
    const windowKey = `${this.prefix}:${key}`;
    const client    = getClient();
    if (!client) { this._memDecrement(windowKey); return; }
    try {
      await client.from('rate_limits')
        .update({ count: null })   // handled by the DB function on next increment
        .eq('key', windowKey);
    } catch { this._memDecrement(windowKey); }
  }

  async resetKey(key) {
    const windowKey = `${this.prefix}:${key}`;
    const client    = getClient();
    memStore.delete(windowKey);
    if (!client) return;
    try { await client.from('rate_limits').delete().eq('key', windowKey); } catch { }
  }

  async resetAll() {
    memStore.clear();
    const client = getClient();
    if (!client) return;
    try { await client.from('rate_limits').delete().neq('key', ''); } catch { }
  }

  // ── Memory fallback helpers ───────────────────────────────────────────────
  _memIncrement(key) {
    const now     = Date.now();
    const entry   = memStore.get(key);
    const isStale = !entry || entry.resetAt <= now;
    const count   = isStale ? 1 : entry.count + 1;
    const resetAt = isStale ? now + this.windowMs : entry.resetAt;
    memStore.set(key, { count, resetAt });
    return { totalHits: count, resetTime: new Date(resetAt) };
  }

  _memDecrement(key) {
    const entry = memStore.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async _cleanup() {
    const client = getClient();
    if (client) {
      try {
        await client.from('rate_limits').delete().lt('reset_at', new Date().toISOString());
      } catch { }
    }
    const now = Date.now();
    for (const [k, v] of memStore) { if (v.resetAt <= now) memStore.delete(k); }
  }
}

module.exports = { PgRateLimitStore };
