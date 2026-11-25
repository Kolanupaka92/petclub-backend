'use strict';
const crypto = require('crypto');

/** Constant-time comparison of a request header/secret with its expected value. */
function secretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(provided), h(expected));
}

const normalizeEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

/**
 * Email is a login identity, so two accounts must never share one: it would let
 * a user lock someone out of email sign-in or receive their codes.
 * Fails closed: throws if ownership cannot be checked.
 * @returns {Promise<boolean>} true when another account already uses this email
 */
async function emailTakenByOther(supabase, email, userId) {
  const addr = normalizeEmail(email);
  if (!addr) return false;
  // ilike = case-insensitive equality here; escape its wildcards.
  const pattern = addr.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await supabase.from('users').select('id').ilike('email', pattern).neq('id', userId).limit(1);
  if (error) throw new Error(`email ownership check: ${error.message}`);
  return (data || []).length > 0;
}

/** Rate-limit key for a login identity. Hashed so limiter rows hold no phone or email. */
function identityKey(req) {
  const id = normalizeEmail(req.body?.email) || String(req.body?.phone || '').replace(/[^\d+]/g, '');
  return id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 32) : `ip:${req.ip}`;
}

module.exports = { secretEquals, normalizeEmail, emailTakenByOther, identityKey };
