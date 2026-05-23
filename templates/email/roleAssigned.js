'use strict';
/**
 * Role-assignment email — sent to a professional when their sub-role
 * (Groomer, Trainer, Vet) is officially designated, or to a customer
 * when their account type is confirmed.
 */

const { layout } = require('./_layout');

const APP_URL      = process.env.WEB_APP_URL    || 'https://app.mypetclub.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@mypetclub.app';

const ROLE_CONFIG = {
  Groomer:  {
    icon:    '✂️',
    color:   '#7c3aed',
    lightBg: '#f5f3ff',
    border:  '#ddd6fe',
    label:   'Pet Groomer',
    desc:    "Your grooming profile is being set up. Once verified, you'll appear in search results for pet owners in your city.",
  },
  Trainer:  {
    icon:    '🎓',
    color:   '#2563eb',
    lightBg: '#eff6ff',
    border:  '#bfdbfe',
    label:   'Pet Trainer',
    desc:    "Your trainer profile is being set up. Once verified, pet owners looking for obedience and behaviour training will be able to find you.",
  },
  Vet:      {
    icon:    '🏥',
    color:   '#059669',
    lightBg: '#ecfdf5',
    border:  '#a7f3d0',
    label:   'Veterinary Doctor',
    desc:    "Your vet profile is being set up. Once verified, you'll be listed for pet health consultations and home visits in your area.",
  },
  customer: {
    icon:    '🐾',
    color:   '#f97316',
    lightBg: '#fff7ed',
    border:  '#fed7aa',
    label:   'Pet Owner',
    desc:    "Your account is active. Start booking services for your pet right away.",
  },
};

/**
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.role      — 'professional' | 'customer'
 * @param {string} [data.subRole] — 'Groomer' | 'Trainer' | 'Vet'
 */
const roleAssignedTemplate = ({ name, role, subRole }) => {
  const fn  = (name || 'there').split(' ')[0];
  const cfg = ROLE_CONFIG[subRole] || ROLE_CONFIG[role] || ROLE_CONFIG.customer;
  const isPro = role === 'professional';

  return layout(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:44px 44px 40px;mso-padding-alt:44px 44px 40px 44px;">

      <!-- Role badge -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td align="center" bgcolor="${cfg.lightBg}" style="border:2px solid ${cfg.border};border-radius:16px;padding:28px 24px;">
            <div style="font-size:50px;margin-bottom:10px;line-height:1;">${cfg.icon}</div>
            <p style="margin:0 0 5px;color:${cfg.color};font-size:17px;font-weight:800;letter-spacing:-0.2px;">${cfg.label}</p>
            <p style="margin:0;color:#64748b;font-size:12px;letter-spacing:1px;text-transform:uppercase;font-weight:600;">Your PETclub Role</p>
          </td>
        </tr>
      </table>

      <!-- Body copy -->
      <h2 style="margin:0 0 12px;color:#1e293b;font-size:20px;font-weight:800;">Hi ${fn}, your role has been confirmed.</h2>
      <p style="margin:0 0 28px;color:#64748b;font-size:14px;line-height:1.80;">${cfg.desc}</p>

      ${isPro ? `
      <!-- What happens next (pro only) -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
        <tr>
          <td bgcolor="#f8fafc" style="border-radius:12px;padding:22px 24px;">
            <p style="margin:0 0 14px;font-weight:800;color:#374151;font-size:14px;">📋 What happens next:</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${[
                'Our team reviews your profile and government-issued ID',
                "You'll receive an approval email and SMS within 24–48 hours",
                'Once approved, toggle your availability <strong>Online</strong> to start receiving bookings',
              ].map((step, i) => `
              <tr>
                <td style="padding:7px 0;vertical-align:top;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td width="26" style="vertical-align:top;padding-top:1px;">
                        <div style="width:22px;height:22px;background:${cfg.color};border-radius:50%;color:white;font-size:11px;font-weight:800;text-align:center;line-height:22px;">${i + 1}</div>
                      </td>
                      <td style="padding-left:12px;color:#64748b;font-size:13px;line-height:1.65;">${step}</td>
                    </tr>
                  </table>
                </td>
              </tr>`).join('')}
            </table>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 28px;color:#94a3b8;font-size:12px;line-height:1.7;">
        Have a question? Reach us at
        <a href="mailto:${SUPPORT_EMAIL}" style="color:#f97316;text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a>
      </p>` : `<p style="margin:0 0 32px;color:#94a3b8;font-size:12px;line-height:1.7;">
        Need help? Contact us at
        <a href="mailto:${SUPPORT_EMAIL}" style="color:#f97316;text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a>
      </p>`}

      <!-- CTA -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr>
          <td align="center" bgcolor="${cfg.color}" style="border-radius:50px;">
            <!--[if !mso]><!-->
            <a href="${APP_URL}"
               style="display:inline-block;padding:15px 44px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:50px;">
              Open PETclub App →
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
`, { preheader: `Your PETclub account role has been set: ${cfg.label}.` });
};

module.exports = { roleAssignedTemplate };
