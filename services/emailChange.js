'use strict';
// ══════════════════════════════════════════════════════════════════
//  Verified email change
//
//  Email is a login identity, so users.email only ever changes after the user
//  enters a code sent to the NEW address. Nothing else in the API may write it
//  for a user (admins and the startup admin link aside).
//
//  The code is stored in otp_tokens under "email-change:<userId>" — a key no
//  sign-in route accepts — and its hash covers the user and the address, so a
//  code can't be reused for another account, another address, or to sign in.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { normalizeEmail, emailTakenByOther } = require('./accountSecurity');

const CODE_TTL_MS = 10 * 60 * 1000;
const tokenKey = (userId) => `email-change:${userId}`;
const hashCode = (userId, email, code) =>
  crypto.createHash('sha256').update(`email-change\0${userId}\0${email}\0${code}`).digest('hex');

class EmailChangeError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}
const TAKEN = 'That email is already used by another account.';

const shell = (title, body) => `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
  <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 12px">${title}</h2>${body}
  <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
  <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub</p></div>`;

const codeEmail = (code) => shell('Confirm your email', `
  <p style="color:#64748b;font-size:14px;text-align:center">Enter this code in PETclub to add this email to your account. You will be able to sign in with it.</p>
  <div style="background:#fff7ed;border:2px solid #fed7aa;border-radius:14px;padding:24px;text-align:center">
    <span style="font-size:36px;font-weight:900;letter-spacing:10px;color:#ea580c;font-family:monospace">${code}</span></div>
  <p style="color:#64748b;font-size:13px;text-align:center;margin-top:16px">Valid for 10 minutes. <strong>If you didn't ask for this, ignore it and don't share the code with anyone.</strong></p>`);

const changedEmail = (supportEmail) => shell('Your PETclub email was changed', `
  <p style="color:#64748b;font-size:14px;text-align:center">This address can no longer be used to sign in to your PETclub account.</p>
  <p style="color:#64748b;font-size:14px;text-align:center"><strong>If this wasn't you, contact ${supportEmail} right away.</strong></p>`);

/** Send a code to the new address. Changes nothing on the account. */
async function requestEmailChange({ supabase, sendEmail }, { userId, email }) {
  const addr = normalizeEmail(email);
  const { data: user, error } = await supabase.from('users').select('email').eq('id', userId).single();
  if (error || !user) throw new EmailChangeError(404, 'Account not found.');
  if (normalizeEmail(user.email) === addr) throw new EmailChangeError(400, 'That is already your email.');
  if (await emailTakenByOther(supabase, addr, userId)) throw new EmailChangeError(409, TAKEN);

  const code = crypto.randomInt(100000, 1000000).toString();
  const { error: saveErr } = await supabase.from('otp_tokens').upsert(
    { phone: tokenKey(userId), otp: hashCode(userId, addr, code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), verified: false },
    { onConflict: 'phone' });
  if (saveErr) throw new Error(`store email-change code: ${saveErr.message}`);
  const sent = await sendEmail(addr, 'Confirm your email for PETclub', codeEmail(code));
  if (!sent) throw new Error('email service not configured');
  return { email: addr };
}

/** Check the code and switch the account to the new address. */
async function confirmEmailChange({ supabase, sendEmail, logger, supportEmail }, { userId, email, code }) {
  const addr = normalizeEmail(email);
  const BAD = 'That code is incorrect or has expired.';

  // Claim the code atomically so it can only ever be used once.
  const { data: claimed, error: claimErr } = await supabase.from('otp_tokens')
    .update({ verified: true })
    .eq('phone', tokenKey(userId)).eq('otp', hashCode(userId, addr, code)).eq('verified', false)
    .gt('expires_at', new Date().toISOString())
    .select('phone');
  if (claimErr) throw new Error(`claim email-change code: ${claimErr.message}`);
  if (!claimed?.length) throw new EmailChangeError(400, BAD);

  const { data: before, error: readErr } = await supabase.from('users').select('email, name, role').eq('id', userId).single();
  if (readErr || !before) throw new EmailChangeError(404, 'Account not found.');
  if (await emailTakenByOther(supabase, addr, userId)) throw new EmailChangeError(409, TAKEN);

  const { error: updErr } = await supabase.from('users').update({ email: addr }).eq('id', userId);
  // 23505: users_email_live_unique caught a race with another account.
  if (updErr) { if (updErr.code === '23505') throw new EmailChangeError(409, TAKEN); throw new Error(`update email: ${updErr.message}`); }

  const { error: delErr } = await supabase.from('otp_tokens').delete().eq('phone', tokenKey(userId));
  if (delErr) logger.warn(`[EmailChange] token cleanup failed: ${delErr.message}`);

  const previous = normalizeEmail(before.email);
  if (previous && previous !== addr) {
    Promise.resolve(sendEmail(previous, 'Your PETclub email was changed', changedEmail(supportEmail)))
      .catch(e => logger.error(`[EmailChange] notice to previous address failed: ${e.message}`));
  }
  logger.info(`[EmailChange] user ${userId} verified a new email`);
  return { email: addr, first: !previous, name: before.name, role: before.role };
}

module.exports = { requestEmailChange, confirmEmailChange, EmailChangeError };
