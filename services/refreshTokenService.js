'use strict';
/**
 * Refresh Token Service
 *
 * Implements secure, rotating refresh tokens with family-based reuse detection.
 *
 * Security model:
 *   - Raw token: 32 random bytes (base64url) — stored ONLY in httpOnly cookie
 *   - DB stores:  SHA-256(raw token) — safe to index; raw token never leaves the cookie
 *   - Family:     UUID grouping all rotated siblings. On reuse, entire family is revoked
 *                 (detects token theft: if attacker uses an old token, both are invalidated)
 *
 * Rotation: every call to /auth/refresh produces a NEW token and immediately
 * revokes the old one. Clients always hold at most one valid token.
 */

const crypto = require('crypto');

const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS) || 30;
const REFRESH_COOKIE   = 'petclub_refresh';

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure:   true,
  sameSite: 'strict',  // refresh endpoint is same-origin only
  maxAge:   REFRESH_TTL_DAYS * 86400 * 1000,
  path:     '/api/auth/refresh',  // scoped — not sent on every request
};

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Issue a new refresh token for a user.
 * Call after successful login / OTP verification.
 *
 * @param {object} supabase  - Supabase admin client
 * @param {string} userId    - auth.users.id
 * @param {string|null} family - existing family UUID (pass null for brand-new login)
 * @returns {{ rawToken: string, family: string }}
 */
async function issueRefreshToken(supabase, userId, family = null) {
  const rawToken  = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const tokenFamily = family || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000).toISOString();

  const { error } = await supabase.from('refresh_tokens').insert({
    user_id:     userId,
    token_hash:  tokenHash,
    family:      tokenFamily,
    expires_at:  expiresAt,
  });

  if (error) throw new Error(`Failed to store refresh token: ${error.message}`);

  return { rawToken, family: tokenFamily };
}

/**
 * Validate an incoming refresh token from the cookie.
 * On success, revokes the used token and issues a rotated replacement.
 * On reuse detection (token already revoked), revokes the entire family.
 *
 * @returns {{ userId: string, rawToken: string, family: string } | null}
 *   Returns null if token is invalid/expired. Throws on DB error.
 */
async function rotateRefreshToken(supabase, rawToken) {
  const tokenHash = hashToken(rawToken);

  // Find the token row (including already-revoked ones — needed for reuse detection)
  const { data: row, error } = await supabase
    .from('refresh_tokens')
    .select('id, user_id, family, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !row) return null;

  // Reuse detection: token was already used/revoked — revoke entire family
  if (row.revoked_at) {
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('family', row.family)
      .is('revoked_at', null);
    return null;
  }

  // Expired
  if (new Date(row.expires_at) < new Date()) {
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', row.id);
    return null;
  }

  // Revoke the current token (rotation)
  await supabase
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', row.id);

  // Issue replacement in the same family
  const { rawToken: newRawToken, family } = await issueRefreshToken(supabase, row.user_id, row.family);

  return { userId: row.user_id, rawToken: newRawToken, family };
}

/**
 * Revoke all refresh tokens for a user (logout).
 */
async function revokeAllForUser(supabase, userId) {
  await supabase
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null);
}

module.exports = {
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllForUser,
  REFRESH_COOKIE,
  REFRESH_COOKIE_OPTS,
  REFRESH_TTL_DAYS,
};
