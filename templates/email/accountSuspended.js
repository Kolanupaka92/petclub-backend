'use strict';
/**
 * User-facing account suspension notification.
 *
 * Serious and professional in tone. Provides:
 *   - Clear statement of what happened
 *   - Optional admin-supplied reason
 *   - Step-by-step appeals process
 *   - Direct support contact
 */

const { layout } = require('./_layout');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@mypetclub.app';
const APP_URL       = process.env.WEB_APP_URL   || 'https://app.mypetclub.app';
const WEBSITE_URL   = process.env.WEBSITE_URL   || 'https://mypetclub.app';

/**
 * @param {object} data
 * @param {string} data.name           — user's full name
 * @param {string} [data.reason]       — admin-supplied reason (optional)
 */
const accountSuspendedTemplate = ({ name, reason }) => {
  const fn = (name || 'Account holder').split(' ')[0];

  return layout(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:44px 44px 40px;mso-padding-alt:44px 44px 40px 44px;">

      <!-- Alert banner -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td align="center" bgcolor="#fef2f2" style="border:2px solid #fecaca;border-radius:16px;padding:30px 24px;">
            <div style="font-size:48px;margin-bottom:10px;line-height:1;">⚠️</div>
            <p style="margin:0 0 6px;color:#991b1b;font-size:18px;font-weight:800;">Account Restricted</p>
            <p style="margin:0;color:#b91c1c;font-size:13px;line-height:1.65;">
              Your PETclub account has been temporarily restricted by our Trust &amp; Safety team.
            </p>
          </td>
        </tr>
      </table>

      <!-- Body copy -->
      <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.80;">
        Hi <strong>${fn}</strong>,
      </p>
      <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.80;">
        We are writing to inform you that your PETclub account has been restricted pending a review by our
        Trust &amp; Safety team. During this period, access to certain platform features will be limited.
      </p>

      ${reason ? `
      <!-- Reason provided by admin -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr>
          <td bgcolor="#fff7ed" style="border:1.5px solid #fed7aa;border-radius:12px;padding:18px 22px;">
            <p style="margin:0 0 8px;color:#92400e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;">Reason for restriction</p>
            <p style="margin:0;color:#78350f;font-size:14px;line-height:1.75;">${reason}</p>
          </td>
        </tr>
      </table>` : ''}

      <!-- Appeals process -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td bgcolor="#f8fafc" style="border-radius:12px;padding:22px 24px;">
            <p style="margin:0 0 14px;font-weight:800;color:#1e293b;font-size:14px;">How to appeal this decision:</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${[
                [`Email us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#f97316;font-weight:700;text-decoration:none;">${SUPPORT_EMAIL}</a> with your registered phone number`, '1'],
                ['Include your full name and a clear explanation of why the restriction should be lifted', '2'],
                ['Attach any supporting evidence if applicable', '3'],
                ['Our Trust &amp; Safety team will review your case and respond within <strong>2 business days</strong>', '4'],
              ].map(([step, num]) => `
              <tr>
                <td style="padding:7px 0;vertical-align:top;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td width="26" style="vertical-align:top;padding-top:1px;">
                        <div style="width:22px;height:22px;background:#dc2626;border-radius:50%;color:white;font-size:11px;font-weight:800;text-align:center;line-height:22px;">${num}</div>
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

      <!-- Policy reference -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td style="border-top:1px solid #f1f5f9;padding-top:20px;">
            <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.80;">
              PETclub account restrictions are applied in accordance with our
              <a href="${WEBSITE_URL}/terms" style="color:#94a3b8;text-decoration:underline;">Terms of Service</a>
              and
              <a href="${WEBSITE_URL}/privacy" style="color:#94a3b8;text-decoration:underline;">Community Guidelines</a>.
              We review every case individually and take all appeals seriously.
              If you received this message in error and have not violated any platform policies,
              please contact our support team immediately.
            </p>
          </td>
        </tr>
      </table>

      <!-- Support CTA -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr>
          <td align="center" bgcolor="#dc2626" style="border-radius:50px;">
            <!--[if !mso]><!-->
            <a href="mailto:${SUPPORT_EMAIL}"
               style="display:inline-block;padding:14px 40px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:50px;">
              Contact Support to Appeal →
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
`, { preheader: `Important notice: your PETclub account has been temporarily restricted.` });
};

module.exports = { accountSuspendedTemplate };
