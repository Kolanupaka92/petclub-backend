'use strict';
/**
 * Provider verification result email — handles both approval and rejection.
 *
 * Approval:  celebratory, green, "you're live" messaging.
 * Rejection: serious but constructive; includes reason + resubmission path.
 */

const { layout } = require('./_layout');

const APP_URL       = process.env.WEB_APP_URL   || 'https://app.mypetclub.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@mypetclub.app';

const ROLE_CONFIG = {
  Groomer: { icon: '✂️', label: 'Pet Groomer'        },
  Trainer: { icon: '🎓', label: 'Pet Trainer'        },
  Vet:     { icon: '🏥', label: 'Veterinary Doctor'  },
};

/**
 * @param {object} data
 * @param {string} data.name             — professional's full name
 * @param {string} data.subRole          — 'Groomer' | 'Trainer' | 'Vet'
 * @param {string} data.action           — 'approve' | 'reject'
 * @param {string} [data.reason]         — rejection reason (admin-supplied)
 * @param {string} [data.city]           — city where the profile is live (approve only)
 */
const providerVerificationTemplate = ({ name, subRole, action, reason, city }) => {
  const fn       = (name || 'there').split(' ')[0];
  const approved = action === 'approve';
  const cfg      = ROLE_CONFIG[subRole] || { icon: '🌟', label: 'Professional' };

  /* ── Approved body ──────────────────────────────────────────────────────── */
  const approvedBody = `
      <!-- Celebration banner -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td align="center" bgcolor="#ecfdf5" style="border:2px solid #a7f3d0;border-radius:16px;padding:30px 28px;">
            <div style="font-size:52px;margin-bottom:10px;line-height:1;">🎉</div>
            <p style="margin:0 0 6px;color:#065f46;font-size:20px;font-weight:800;letter-spacing:-0.3px;">You're verified and live!</p>
            <p style="margin:0;color:#047857;font-size:13px;line-height:1.65;">
              Congratulations, <strong>${fn}</strong>. Your <strong>${cfg.label}</strong> profile
              is now active${city ? ` in <strong>${city}</strong>` : ''} and visible to pet owners nearby.
            </p>
          </td>
        </tr>
      </table>

      <!-- Getting started checklist -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
        <tr>
          <td bgcolor="#f8fafc" style="border-radius:14px;padding:24px 26px;">
            <p style="margin:0 0 16px;font-weight:800;color:#1e293b;font-size:14px;">🚀 Get started now:</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${[
                'Log in to your PETclub professional dashboard',
                'Toggle your availability to <strong style="color:#059669;">Online</strong> to start receiving bookings',
                'Add a professional photo and update your service description',
                'Respond to booking requests within 30 minutes for the best visibility ranking',
              ].map((step, i) => `
              <tr>
                <td style="padding:8px 0;vertical-align:top;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td width="26" style="vertical-align:top;padding-top:1px;">
                        <div style="width:22px;height:22px;background:#059669;border-radius:50%;color:white;font-size:11px;font-weight:800;text-align:center;line-height:22px;">${i + 1}</div>
                      </td>
                      <td style="padding-left:12px;color:#374151;font-size:13px;line-height:1.65;">${step}</td>
                    </tr>
                  </table>
                </td>
              </tr>`).join('')}
            </table>
          </td>
        </tr>
      </table>

      <!-- CTA -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 8px;">
        <tr>
          <td align="center" bgcolor="#059669" style="border-radius:50px;">
            <!--[if !mso]><!-->
            <a href="${APP_URL}" style="display:inline-block;padding:15px 44px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:50px;">
              Go Live Now →
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>`;

  /* ── Rejected body ──────────────────────────────────────────────────────── */
  const rejectedBody = `
      <!-- Rejection notice -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr>
          <td bgcolor="#fef2f2" style="border:2px solid #fecaca;border-radius:16px;padding:26px 24px;">
            <div style="font-size:44px;margin-bottom:10px;text-align:center;line-height:1;">📋</div>
            <p style="margin:0 0 8px;color:#991b1b;font-size:17px;font-weight:800;text-align:center;">Application Not Approved</p>
            <p style="margin:0;color:#b91c1c;font-size:13px;line-height:1.70;text-align:center;">
              Hi <strong>${fn}</strong>, your <strong>${cfg.label}</strong> profile verification
              could not be approved at this time based on the submitted documents.
            </p>
          </td>
        </tr>
      </table>

      ${reason ? `
      <!-- Reason block -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr>
          <td bgcolor="#fff7ed" style="border:1.5px solid #fed7aa;border-radius:12px;padding:18px 22px;">
            <p style="margin:0 0 8px;color:#92400e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;">Reason provided</p>
            <p style="margin:0;color:#78350f;font-size:14px;line-height:1.75;">${reason}</p>
          </td>
        </tr>
      </table>` : ''}

      <!-- Resubmission guidance -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
        <tr>
          <td bgcolor="#f8fafc" style="border-radius:12px;padding:22px 24px;">
            <p style="margin:0 0 12px;font-weight:800;color:#374151;font-size:14px;">What you can do:</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${[
                'Re-open the PETclub app and update your profile with clearer documents',
                'Upload a government-issued photo ID (Aadhaar, Passport, or Driving Licence)',
                'Attach any relevant professional certifications or licences',
                `Email our team at <a href="mailto:${SUPPORT_EMAIL}" style="color:#f97316;text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a> if you believe this decision is in error`,
              ].map(step => `
              <tr>
                <td style="padding:6px 0;vertical-align:top;color:#64748b;font-size:13px;line-height:1.65;">
                  → &nbsp;${step}
                </td>
              </tr>`).join('')}
            </table>
          </td>
        </tr>
      </table>

      <!-- CTA -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 8px;">
        <tr>
          <td align="center" bgcolor="#f97316" style="border-radius:50px;">
            <!--[if !mso]><!-->
            <a href="${APP_URL}" style="display:inline-block;padding:15px 44px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:50px;">
              Update My Profile →
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>`;

  return layout(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:44px 44px 40px;mso-padding-alt:44px 44px 40px 44px;">

      <!-- Role icon + headline -->
      <p style="margin:0 0 6px;font-size:36px;text-align:center;line-height:1;">${cfg.icon}</p>
      <h2 style="margin:0 0 28px;color:#1e293b;font-size:22px;font-weight:800;text-align:center;letter-spacing:-0.3px;">
        ${approved ? `Congrats, ${fn}! 🎉` : `Update on Your Application`}
      </h2>

      ${approved ? approvedBody : rejectedBody}

    </td>
  </tr>
</table>
`, {
  preheader: approved
    ? `🎉 Congratulations ${fn}! Your PETclub ${cfg.label} profile is verified and live.`
    : `An update is required on your PETclub ${cfg.label} application.`,
});
};

module.exports = { providerVerificationTemplate };
