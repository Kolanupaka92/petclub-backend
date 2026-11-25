// Author: Sai Kolanupaka
'use strict';
// ══════════════════════════════════════════════════════════════════
//  Test-login identities — NON-PRODUCTION ONLY
//
//  This repo is public, so a fixed OTP enabled in production is a public
//  login. Production refuses it here in code, whatever env vars are set.
//  So does anything else on Cloud Run (K_SERVICE is set by the platform):
//  staging shares the production database and JWT secret.
//  Admin accounts must also be refused by the caller.
// ══════════════════════════════════════════════════════════════════

const TEST_EMAIL_SUFFIX = '@e2e.mypetclub.app';

/**
 * Fixed OTP for a test identity, or null for everyone else.
 * @param {{email?: string, phone?: string}} identity
 * @param {{isProd: boolean, env?: NodeJS.ProcessEnv}} opts
 */
function testOtpFor({ email, phone } = {}, { isProd, env = process.env }) {
  if (isProd || env.NODE_ENV === 'production' || env.K_SERVICE) return null;
  const otp = env.E2E_FIXED_OTP;
  if (!/^\d{6}$/.test(otp || '')) return null;

  const addr = typeof email === 'string' ? email.toLowerCase() : '';
  if (addr.endsWith(TEST_EMAIL_SUFFIX)) return otp;
  const domain = (env.E2E_TEST_EMAIL_DOMAIN || '').toLowerCase();
  if (domain && addr.endsWith(`@${domain}`)) return otp;

  const phones = (env.E2E_TEST_PHONES || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  return typeof phone === 'string' && phones.includes(phone) ? otp : null;
}

module.exports = { testOtpFor };
