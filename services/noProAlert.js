// Author: Sai Kolanupaka
'use strict';
// ══════════════════════════════════════════════════════════════════
//  No professional found for a booking
//
//  Every dispatch path that runs out of professionals calls this. It marks the
//  booking once (a conditional update, so overlapping runs alert once) and
//  tells both sides: the admin, who can assign someone by hand, and the
//  customer, who otherwise only finds out by opening the app.
//
//  Notification failures are logged, never thrown: the booking state is what
//  matters, and it is already saved.
// ══════════════════════════════════════════════════════════════════

const { isContactable } = require('./suspendedUserCleanup');

const SERVICE_NAMES = { Groomer: 'groomer', Trainer: 'trainer', Vet: 'vet', Walker: 'dog walker', Boarding: 'boarding host' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "Sat, 28 Nov, 10:00 AM" in the booking's region; India by default. */
function when(iso, lng) {
  if (!iso) return 'your chosen time';
  const us = typeof lng === 'number' && lng < 0;
  return new Date(iso).toLocaleString(us ? 'en-US' : 'en-IN', {
    timeZone: us ? 'America/Chicago' : 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }) + (us ? ' CT' : ' IST');
}

/**
 * @param {object} deps   { supabase, logger, sendEmail, sendPush, adminEmail, appUrl, supportEmail }
 * @param {string} bookingId
 * @param {'new booking'|'offer timed out'|'professional declined'|'professional cancelled'} reason
 * @returns {Promise<boolean>} true if this call marked the booking (and sent alerts)
 */
async function markNoProsAvailable(deps, bookingId, reason) {
  const { supabase, logger, sendEmail, sendPush, adminEmail, appUrl, supportEmail } = deps;

  const { data: marked, error } = await supabase.from('bookings')
    .update({ assignment_status: 'no_pros_available', professional_id: null })
    .eq('id', bookingId).neq('assignment_status', 'no_pros_available')
    .neq('status', 'cancelled').neq('status', 'completed').is('deleted_at', null)
    .select('id, customer_id, service_type, service_name, scheduled_at, city, address_lat, address_lng, payment_status');
  if (error) throw new Error(`mark no_pros_available: ${error.message}`);
  const bk = marked?.[0];
  if (!bk) return false;   // already marked, or no longer active

  logger.warn({ booking_id: bk.id, service_type: bk.service_type, reason }, '[Dispatch] no professional available');

  const { data: cust } = await supabase.from('users').select('name, email, fcm_token, is_active, deleted_at').eq('id', bk.customer_id).maybeSingle();
  const role = SERVICE_NAMES[bk.service_type] || 'professional';
  const svc = bk.service_name || bk.service_type || 'service';
  const time = when(bk.scheduled_at, bk.address_lng);
  const paid = bk.payment_status === 'paid';
  const jobs = [];

  if (adminEmail) {
    jobs.push(['admin email', () => sendEmail(adminEmail, `⚠️ No ${role} found: ${svc} on ${time} — PETclub`,
      `<h2 style="margin:0 0 8px">No professional available</h2>
       <p>A booking could not be matched (${esc(reason)}). Assign someone by hand, or contact the customer.</p>
       <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
         <tr><td>Service</td><td><strong>${esc(svc)}</strong> (${esc(bk.service_type)})</td></tr>
         <tr><td>When</td><td>${esc(time)}</td></tr>
         <tr><td>City</td><td>${esc(bk.city || '—')}</td></tr>
         <tr><td>Customer</td><td>${esc(cust?.name || '—')}</td></tr>
         <tr><td>Paid</td><td>${paid ? 'Yes' : 'No'}</td></tr>
         <tr><td>Booking</td><td style="font-family:monospace">${esc(bk.id)}</td></tr>
       </table>
       <p><a href="${esc(appUrl)}">Open the admin dashboard</a></p>`)]);
  }
  if (isContactable(cust)) {
    const first = (cust.name || 'there').split(' ')[0];
    const next = paid ? `Our team will contact you about your payment.` : `You haven't been charged.`;
    if (cust.email) jobs.push(['customer email', () => sendEmail(cust.email, `We couldn't find a ${role} for ${time} — PETclub`,
      `<p>Hi ${esc(first)},</p>
       <p>Sorry, no ${esc(role)} is available for your <strong>${esc(svc)}</strong> on <strong>${esc(time)}</strong>. ${next}</p>
       <p>Try another time, or reply to this email and we'll help you find someone.</p>
       <p><a href="${esc(appUrl)}">Book another time</a></p>
       <p>— PETclub Team<br><span style="color:#94a3b8;font-size:12px">${esc(supportEmail)}</span></p>`)]);
    jobs.push(['customer push', () => sendPush(cust.fcm_token, `No ${role} available`, `For ${svc} on ${time}. Tap to pick another time.`,
      { userId: bk.customer_id, bookingId: bk.id, type: 'no_pros_available' })]);
  }

  const results = await Promise.allSettled(jobs.map(([, run]) => Promise.resolve().then(run)));
  results.forEach((r, i) => { if (r.status === 'rejected') logger.error(`[Dispatch] ${jobs[i][0]} failed for booking ${bk.id}: ${r.reason?.message}`); });
  return true;
}

module.exports = { markNoProsAvailable };
