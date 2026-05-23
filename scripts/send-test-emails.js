'use strict';
/**
 * PETclub — Send all template test emails via production email service.
 *
 * Usage:
 *   node scripts/send-test-emails.js [recipient@email.com]
 *
 * Uses emailService.js → Zoho SMTP (credentials from .env).
 * Falls back to ADMIN_EMAIL env var, then first CLI arg.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const emailService = require('../services/emailService');

// ── Recipient ──────────────────────────────────────────────────────────────
const TO = process.argv[2] || process.env.ADMIN_EMAIL;
if (!TO) {
  console.error('❌  No recipient. Pass email as argument: node scripts/send-test-emails.js admin@example.com');
  process.exit(1);
}

// ── Test cases — one per named send function ───────────────────────────────
const TESTS = [
  {
    label: '1/6  OTP Verification',
    fn: () => emailService.sendOtpEmail(TO, { otp: '847291', expiresMinutes: 10 }),
  },
  {
    label: '2/6  Customer Welcome (with pet)',
    fn: () => emailService.sendWelcomeEmail(TO, {
      name: 'Rahul Sharma',
      pet:  { name: 'Bruno', species: 'Dog', breed: 'Labrador Retriever', age: 2 },
    }),
  },
  {
    label: '3/6  Role Assigned — Groomer (Professional)',
    fn: () => emailService.sendRoleAssignedEmail(TO, {
      name: 'Priya Nair', role: 'professional', subRole: 'Groomer',
    }),
  },
  {
    label: '4/6  Provider Approved — Groomer',
    fn: () => emailService.sendProviderVerificationEmail(TO, {
      name: 'Priya Nair', subRole: 'Groomer', action: 'approve', city: 'Mumbai',
    }),
  },
  {
    label: '5/6  Provider Rejected — Vet (with reason)',
    fn: () => emailService.sendProviderVerificationEmail(TO, {
      name:    'Dr. Arun Menon',
      subRole: 'Vet',
      action:  'reject',
      reason:  'The uploaded ID document was blurry and could not be verified. Please re-upload a clear, full-colour scan of your government-issued photo ID.',
    }),
  },
  {
    label: '6/6  Account Suspended',
    fn: () => emailService.sendAccountSuspendedEmail(TO, {
      name:   'John Doe',
      reason: 'Multiple reports of inappropriate behaviour from service providers. Your account has been placed under review by our Trust & Safety team.',
    }),
  },
];

// ── Send ───────────────────────────────────────────────────────────────────
(async () => {
  const sender   = process.env.ZOHO_SMTP_USER      || '(configured in emailService)';
  const replyTo  = process.env.ZOHO_SMTP_FROM      || process.env.SUPPORT_EMAIL || 'support@mypetclub.app';
  console.log(`\n🚀 Sending ${TESTS.length} test emails`);
  console.log(`   From     : ${sender}`);
  console.log(`   Reply-To : ${replyTo}  (user replies route here)`);
  console.log(`   To       : ${TO}\n`);

  let passed = 0;
  let failed = 0;

  for (const t of TESTS) {
    process.stdout.write(`  ${t.label} ... `);
    try {
      const result = await t.fn();
      if (result) {
        console.log(`✅  sent (msgId: ${result.messageId})`);
      } else {
        console.log(`⚠️   skipped — SMTP not configured (check ZOHO_SMTP_USER / ZOHO_SMTP_PASS in .env)`);
        failed++;
        continue;
      }
      passed++;
    } catch (err) {
      console.log(`❌  FAILED — ${err.message}`);
      failed++;
    }
    // Small delay to avoid SMTP rate-limiting
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ✅  ${passed} sent   ❌  ${failed} failed`);
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
