'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  PETclub Email Service
 *  services/emailService.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Centralised outgoing email layer. All transactional emails sent by
 * the PETclub backend go through this module — never through ad-hoc
 * nodemailer calls in route handlers.
 *
 * Transport: Zoho SMTP (smtppro.zoho.com:587, STARTTLS)
 *
 * Required env vars (set in Cloud Run):
 *   ZOHO_SMTP_USER          — Zoho account username / From address
 *   ZOHO_SMTP_PASS          — Zoho app-specific password
 *
 * Optional env vars:
 *   SMTP_HOST               — override SMTP host (default: smtppro.zoho.com)
 *   SMTP_PORT               — override port (default: 587)
 *   SMTP_SECURE             — 'true' for TLS/465, omit for STARTTLS/587
 *   ZOHO_SMTP_FROM          — override From address (default: ZOHO_SMTP_USER)
 *   EMAIL_FROM_ADDRESS      — generic alias for From address
 *   EMAIL_FROM_NAME         — display name (default: 'PETclub')
 *   SUPPORT_EMAIL           — reply-to + footer contact
 *
 * Exports (named send functions):
 *   sendOtpEmail(to, { otp, expiresMinutes })
 *   sendWelcomeEmail(to, { name, pet })
 *   sendRoleAssignedEmail(to, { name, role, subRole })
 *   sendProviderVerificationEmail(to, { name, subRole, action, reason, city })
 *   sendAccountSuspendedEmail(to, { name, reason })
 *   sendRawEmail(to, subject, html, attachments)   ← admin/internal escape hatch
 * ══════════════════════════════════════════════════════════════════
 */

const nodemailer = require('nodemailer');

// ── Templates ──────────────────────────────────────────────────────────────
const { otpTemplate }                  = require('../templates/email/otp');
const { welcomeCustomerTemplate }      = require('../templates/email/welcome');
const { roleAssignedTemplate }         = require('../templates/email/roleAssigned');
const { providerVerificationTemplate } = require('../templates/email/providerApproved');
const { accountSuspendedTemplate }     = require('../templates/email/accountSuspended');

// ── SMTP configuration ─────────────────────────────────────────────────────
const SMTP_HOST    = process.env.SMTP_HOST   || 'smtppro.zoho.com';
const SMTP_PORT    = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE  = process.env.SMTP_SECURE === 'true'; // false = STARTTLS on 587

const SMTP_USER    = process.env.ZOHO_SMTP_USER || process.env.SMTP_USER;
const SMTP_PASS    = process.env.ZOHO_SMTP_PASS || process.env.SMTP_PASS;
const SMTP_READY   = Boolean(SMTP_USER && SMTP_PASS);

const SUPPORT_EMAIL  = process.env.SUPPORT_EMAIL       || 'support@mypetclub.app';
const FROM_ADDRESS   = process.env.ZOHO_SMTP_FROM
  || process.env.EMAIL_FROM_ADDRESS
  || SMTP_USER
  || SUPPORT_EMAIL;
const FROM_NAME      = process.env.EMAIL_FROM_NAME     || 'PETclub';
const FROM           = `${FROM_NAME} <${FROM_ADDRESS}>`;

if (!SMTP_READY) {
  console.warn('[EmailService] ZOHO_SMTP_USER / ZOHO_SMTP_PASS not set — outgoing emails will be skipped');
}

const transporter = nodemailer.createTransport({
  host:   SMTP_HOST,
  port:   SMTP_PORT,
  secure: SMTP_SECURE,
  auth:   { user: SMTP_USER, pass: SMTP_PASS },
});

// ── Core send ──────────────────────────────────────────────────────────────
/**
 * Internal send — not exported. Use named helpers below.
 *
 * @param {string}   to
 * @param {string}   subject
 * @param {string}   html
 * @param {Array}    [attachments]   nodemailer attachment array
 * @returns {Promise<object|null>}   nodemailer result, or null if SMTP not configured
 */
const _send = async (to, subject, html, attachments = []) => {
  if (!SMTP_READY) {
    console.warn(`[EmailService] Skipped (SMTP not configured) | to="${to}" | subject="${subject}"`);
    return null;
  }
  const opts = { from: FROM, to, subject, html };
  if (attachments.length) opts.attachments = attachments;
  const result = await transporter.sendMail(opts);
  console.log(`[EmailService] Sent | to="${to}" | subject="${subject}" | msgId=${result.messageId}`);
  return result;
};

// ══════════════════════════════════════════════════════════════════
//  Named send functions — one per user-facing email type
// ══════════════════════════════════════════════════════════════════

/**
 * Email OTP verification code.
 *
 * @param {string} to
 * @param {{ otp: string, expiresMinutes?: number }} data
 */
const sendOtpEmail = (to, { otp, expiresMinutes = 10 }) =>
  _send(
    to,
    `🔑 Your PETclub Verification Code: ${otp}`,
    otpTemplate({ otp, expiresMinutes }),
  );

/**
 * Welcome email for new customers (sent after set-role → customer).
 *
 * @param {string} to
 * @param {{ name: string, pet?: object }} data
 */
const sendWelcomeEmail = (to, { name, pet } = {}) =>
  _send(
    to,
    `🐾 Welcome to PETclub, ${(name || 'there').split(' ')[0]}!`,
    welcomeCustomerTemplate({ name, pet }),
  );

/**
 * Role-assignment notification — customer or professional sub-role.
 *
 * @param {string} to
 * @param {{ name: string, role: string, subRole?: string }} data
 */
const sendRoleAssignedEmail = (to, { name, role, subRole } = {}) =>
  _send(
    to,
    `🐾 Your PETclub Role Has Been Set: ${subRole || role}`,
    roleAssignedTemplate({ name, role, subRole }),
  );

/**
 * Provider verification result — approval or rejection.
 *
 * @param {string} to
 * @param {{ name: string, subRole: string, action: 'approve'|'reject', reason?: string, city?: string }} data
 */
const sendProviderVerificationEmail = (to, { name, subRole, action, reason, city } = {}) =>
  _send(
    to,
    action === 'approve'
      ? `🎉 Your PETclub ${subRole} Profile Is Verified!`
      : `📋 Update on Your PETclub ${subRole} Application`,
    providerVerificationTemplate({ name, subRole, action, reason, city }),
  );

/**
 * User-facing account suspension notice.
 *
 * @param {string} to
 * @param {{ name: string, reason?: string }} data
 */
const sendAccountSuspendedEmail = (to, { name, reason } = {}) =>
  _send(
    to,
    `⚠️ Important: Your PETclub Account Has Been Restricted`,
    accountSuspendedTemplate({ name, reason }),
  );

/**
 * Raw email escape hatch — for admin-internal notifications and
 * one-off emails that don't need the branded template layout.
 * Mirrors the legacy sendEmail(to, subject, html, attachments) signature.
 *
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {Array}  [attachments]
 */
const sendRawEmail = (to, subject, html, attachments = []) =>
  _send(to, subject, html, attachments);

module.exports = {
  sendOtpEmail,
  sendWelcomeEmail,
  sendRoleAssignedEmail,
  sendProviderVerificationEmail,
  sendAccountSuspendedEmail,
  sendRawEmail,
};
