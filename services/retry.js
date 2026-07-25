// ══════════════════════════════════════════════════════════════════
//  Retry helper — exponential backoff for transient network failures
//
//  Used to wrap fire-and-forget outbound calls (FCM push, Twilio SMS/
//  WhatsApp) so a single transient blip doesn't silently drop a
//  booking notification — notifications are the critical path now that
//  payments are deferred.
//
//  Deliberately tiny + dependency-free. Only retries on errors that
//  look transient (network / 5xx / 429 / timeout); permanent errors
//  (bad token, invalid number) fail fast so we don't hammer providers.
// ══════════════════════════════════════════════════════════════════
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Heuristic: is this error worth retrying?
 * Providers surface transient conditions as network errors, 5xx, 429,
 * or timeouts. Everything else (4xx validation, auth) is permanent.
 */
function isTransient(err) {
  if (!err) return false;
  const code = err.code || err.errno || '';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) return true;
  const status = err.status || err.statusCode || err.code; // Twilio puts HTTP status on .status
  const n = Number(status);
  if (!Number.isNaN(n)) return n === 429 || (n >= 500 && n <= 599);
  return false;
}

/**
 * Run `fn` with up to `retries` additional attempts on transient failure.
 * @param {() => Promise<T>} fn        - the async operation
 * @param {object} [opts]
 * @param {number} [opts.retries=2]    - extra attempts after the first
 * @param {number} [opts.baseMs=300]   - base backoff; grows 300 → 600 → 1200
 * @param {(err:Error, attempt:number)=>void} [opts.onRetry] - observability hook
 * @param {(err:Error)=>boolean} [opts.shouldRetry] - override transient check
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const { retries = 2, baseMs = 300, onRetry, shouldRetry = isTransient } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) break;
      if (onRetry) { try { onRetry(err, attempt + 1); } catch { /* never let the hook throw */ } }
      // exponential backoff with light jitter to avoid thundering herds
      await sleep(baseMs * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isTransient };
