'use strict';
// ══════════════════════════════════════════════════════════════════
//  Authentication for /api/cron/* routes
//
//  Cloud Scheduler signs each call with a short-lived Google OIDC token for a
//  dedicated service account, so there is no shared secret to leak.
//    CRON_OIDC_SERVICE_ACCOUNT  the only identity allowed to call cron routes
//    CRON_OIDC_AUDIENCE         who the token must be for (this API)
//
//  X-Cron-Secret still works while CRON_SECRET is set. Unset it to allow
//  Cloud Scheduler only.
// ══════════════════════════════════════════════════════════════════

const { OAuth2Client } = require('google-auth-library');
const { secretEquals } = require('./accountSecurity');

const DEFAULT_AUDIENCE = 'https://api.mypetclub.app';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function makeCronAuth({ logger, env = process.env, client = new OAuth2Client() }) {
  const reject = (res) => { res.status(401).json({ error: 'Unauthorized' }); return false; };

  /** @returns {Promise<boolean>} true when the caller may run cron jobs; otherwise 401 was sent. */
  return async function cronAuth(req, res) {
    if (secretEquals(req.headers['x-cron-secret'], env.CRON_SECRET)) return true;

    const allowed = env.CRON_OIDC_SERVICE_ACCOUNT;
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (!allowed || !token) return reject(res);
    try {
      const ticket = await client.verifyIdToken({ idToken: token, audience: env.CRON_OIDC_AUDIENCE || DEFAULT_AUDIENCE });
      const p = ticket.getPayload() || {};
      if (ISSUERS.has(p.iss) && p.email_verified === true && p.email === allowed) return true;
      logger.warn('[Cron] Rejected a valid Google token from a different identity');
    } catch (e) {
      logger.warn(`[Cron] Token rejected: ${String(e.message).slice(0, 80).replace(/eyJ\S+/g, '<token>')}`);
    }
    return reject(res);
  };
}

module.exports = { makeCronAuth, DEFAULT_AUDIENCE };
