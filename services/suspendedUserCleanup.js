// Author: Sai Kolanupaka
'use strict';
// ══════════════════════════════════════════════════════════════════
//  Suspended-user auto-delete
//
//  Soft-deletes users suspended for more than 24h, then emails the admin
//  a summary of exactly the users deleted in that run.
//
//  Order matters: users are claimed (deleted_at set) FIRST, conditional on
//  still being suspended and not already deleted. That makes the job
//  idempotent — a user can only ever appear in one email — and a user
//  restored mid-run is left alone. Profile cleanup and email come after.
//
//  supabase-js query builders are thenables WITHOUT a .catch() method, and
//  they resolve with { error } rather than rejecting. Check `error`; never
//  chain .catch() on one (it throws a TypeError).
// ══════════════════════════════════════════════════════════════════

const { activeSelect } = require('./db');

const GRACE_MS = 24 * 60 * 60 * 1000;

/** True when a users row (or embedded users object) may be contacted / dispatched. */
const isContactable = (u) => !!u && u.is_active !== false && !u.deleted_at;

const unwrap = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data || [];
};

/**
 * Ids whose most recent suspend/restore event is a suspension past the grace period.
 * @param {{target_id: string, action: string, created_at: string}[]} logs
 */
function idsPastGrace(logs, now = Date.now()) {
  const latest = new Map();
  for (const l of logs) {
    const prev = latest.get(l.target_id);
    if (!prev || new Date(l.created_at) > new Date(prev.created_at)) latest.set(l.target_id, l);
  }
  return [...latest.values()]
    .filter(l => l.action === 'suspend_user' && now - new Date(l.created_at).getTime() > GRACE_MS)
    .map(l => l.target_id);
}

function summaryEmail(users, sanitize) {
  const cell = (v, extra = '') => `<td style="padding:8px 12px;font-size:13px${extra}">${sanitize(v || '') || '—'}</td>`;
  const rows = users.map(u =>
    `<tr style="border-bottom:1px solid #f1f5f9">${cell(u.name)}${cell(u.phone)}${cell(u.email)}${cell((u.role || '').replace(/_/g, ' '), ';text-transform:capitalize')}</tr>`
  ).join('');
  const th = t => `<th style="padding:10px 12px;font-size:12px;color:#991b1b;text-align:left">${t}</th>`;
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return {
    subject: `🗑️ PETclub — ${users.length} Suspended User(s) Auto-Deleted`,
    html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">🗑️</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">Auto-Deletion Complete</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 24px">The following user(s) were suspended &gt;24 hours ago and have been deleted.</p>
          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden">
            <thead><tr style="background:#fee2e2">${th('Name')}${th('Phone')}${th('Email')}${th('Role')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
          <p style="color:#94a3b8;font-size:12px;text-align:center">PETclub Admin — ${when} IST. Remaining account data is purged after 90 days.</p>
        </div>`,
  };
}

/**
 * @returns {Promise<{deleted: number, cleanup_errors: number, emailed: boolean}>}
 * @throws when users cannot be read or claimed, so the cron run fails visibly.
 */
async function autoDeleteSuspendedUsers({ supabase, sendEmail, sanitize, logger, adminEmail }) {
  const result = { deleted: 0, cleanup_errors: 0, emailed: false };

  const suspended = unwrap(
    await activeSelect(supabase, 'users', 'id').eq('is_active', false), 'load suspended users');
  if (!suspended.length) return result;

  const logs = unwrap(
    await supabase.from('admin_logs').select('target_id, action, created_at')
      .in('action', ['suspend_user', 'restore_user'])
      .in('target_id', suspended.map(u => u.id))
      .order('created_at', { ascending: false }),
    'load suspension logs');
  const ids = idsPastGrace(logs);
  if (!ids.length) return result;

  const now = new Date().toISOString();
  const deleted = unwrap(
    await supabase.from('users').update({ deleted_at: now })
      .in('id', ids).eq('is_active', false).is('deleted_at', null)
      .select('id, name, phone, email, role'),
    'soft-delete users');
  if (!deleted.length) return result;
  result.deleted = deleted.length;

  const deletedIds = deleted.map(u => u.id);
  logger.info(`[AutoDelete] Deleted ${deletedIds.length} suspended users: ${deletedIds.join(', ')}`);

  // Best-effort: the user is already inaccessible, so one failed step must not stop the rest.
  const phones = deleted.map(u => u.phone).filter(Boolean);
  const steps = [
    ['professional_profiles', () => supabase.from('professional_profiles').delete().in('user_id', deletedIds)],
    ['customer_profiles',     () => supabase.from('customer_profiles').delete().in('user_id', deletedIds)],
    ['pets',                  () => supabase.from('pets').update({ deleted_at: now }).in('owner_id', deletedIds).is('deleted_at', null)],
    ['otp_tokens',            () => supabase.from('otp_tokens').delete().in('phone', phones)],
    // admin_logs are the compliance audit trail — redact notes, never delete.
    ['admin_logs',            () => supabase.from('admin_logs').update({ notes: '[redacted — user auto-deleted]' }).in('target_id', deletedIds)],
  ];
  for (const [name, run] of steps) {
    try {
      const { error } = await run();
      if (error) throw new Error(error.message);
    } catch (e) {
      result.cleanup_errors++;
      logger.error(`[AutoDelete] ${name} cleanup failed: ${e.message}`);
    }
  }

  if (adminEmail) {
    try {
      const { subject, html } = summaryEmail(deleted, sanitize);
      await sendEmail(adminEmail, subject, html);
      result.emailed = true;
    } catch (e) {
      logger.error(`[AutoDelete] Email failed: ${e.message}`);
    }
  }
  return result;
}

module.exports = { autoDeleteSuspendedUsers, idsPastGrace, isContactable };
