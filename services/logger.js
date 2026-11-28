// Author: Sai Kolanupaka
'use strict';
// ══════════════════════════════════════════════════════════════════
//  Logger
//
//  Most of the code logs as `logger.error('[Tag] what failed:', err.message)`.
//  Pino treats extra arguments as printf values and drops them when the
//  message has no %s, so those lines used to reach Cloud Run as just the
//  label. The logMethod hook below keeps them:
//    - an Error (or Supabase-style { message, code } object) becomes `err`,
//      with its message appended to the text so it shows in the log list;
//    - anything else is appended to the text.
//  Calls that already use pino's own forms ({obj}, 'msg' or 'a %s', x) are
//  left alone.
//
//  Logs must not hold credentials or contact details:
//    - auth headers, cookies and the cron secret are removed from request logs;
//    - email addresses and phone numbers in error text are masked
//      (Postgres puts the offending value in unique-violation messages).
// ══════════════════════════════════════════════════════════════════

const pino = require('pino');

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-cron-secret"]',
  'req.headers["x-health-secret"]',
  'res.headers["set-cookie"]',
  'err.config.headers',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 10+ digits, optionally with +, spaces, dashes or brackets in between.
// Not inside a word or id (UUID segments) and not a clock time ("… 10:00").
const PHONE_RE = /(?<![\w-])\+?\d[\d\s().-]{8,}\d(?![\w:-])/g;

function maskEmail(m) {
  const [user, domain] = m.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

function maskPhone(m) {
  const digits = m.replace(/\D/g, '');
  if (digits.length < 10) return m;   // dates, ids, amounts: leave
  return `***${digits.slice(-2)}`;
}

function scrub(text) {
  if (typeof text !== 'string') return text;
  return text.replace(EMAIL_RE, maskEmail).replace(PHONE_RE, maskPhone);
}

function isErrorLike(v) {
  return v instanceof Error
    || (v && typeof v === 'object' && typeof v.message === 'string'
        && ('code' in v || 'details' in v || 'hint' in v || 'stack' in v));
}

function toErr(v) {
  const out = {
    type: v instanceof Error ? (v.constructor?.name || 'Error') : 'Error',
    message: scrub(v.message),
  };
  if (v.code != null) out.code = v.code;
  if (v.status != null) out.status = v.status;
  if (v.details) out.details = scrub(String(v.details));
  if (v.hint) out.hint = scrub(String(v.hint));
  if (v.stack) out.stack = scrub(v.stack);
  return out;
}

function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return scrub(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return scrub(JSON.stringify(v)); } catch { return '[unserialisable]'; }
}

// Turns (msg, ...extra) into pino's (obj, msg) form. Exported for tests.
function normaliseArgs(args) {
  if (args.length < 2 || typeof args[0] !== 'string' || /%[sdifjoO]/.test(args[0])) {
    return args;
  }
  const [msg, ...extra] = args;
  const parts = [scrub(msg)];
  let err;
  for (const v of extra) {
    if (!err && isErrorLike(v)) {
      err = toErr(v);
      parts.push(err.message);
    } else {
      parts.push(describe(v));
    }
  }
  const text = parts.join(' ');
  return err ? [{ err }, text] : [text];
}

function createLogger(opts = {}, destination) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    hooks: {
      logMethod(args, method) {
        // Single-string calls only need masking.
        if (args.length === 1 && typeof args[0] === 'string') {
          return method.call(this, scrub(args[0]));
        }
        // Errors passed first ({err} or a bare Error) get their text masked too.
        if (args[0] instanceof Error) {
          return method.apply(this, [{ err: toErr(args[0]) }, ...args.slice(1)]);
        }
        return method.apply(this, normaliseArgs(args));
      },
    },
    ...opts,
  }, destination);
}

module.exports = { createLogger, normaliseArgs, scrub, REDACT_PATHS };
