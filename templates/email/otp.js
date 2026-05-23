'use strict';
/**
 * Email OTP verification template.
 *
 * Renders a high-contrast 6-digit code block with expiry warning
 * and a security notice. No links — by design (phishing resistance).
 */

const { layout } = require('./_layout');

/**
 * @param {object} data
 * @param {string} data.otp              — 6-digit one-time code
 * @param {number} [data.expiresMinutes] — validity window in minutes (default: 10)
 */
const otpTemplate = ({ otp, expiresMinutes = 10 }) => layout(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:44px 44px 40px;mso-padding-alt:44px 44px 40px 44px;">

      <!-- Title -->
      <h2 style="margin:0 0 10px;color:#1e293b;font-size:22px;font-weight:800;text-align:center;letter-spacing:-0.3px;">Verification Code</h2>
      <p style="margin:0 0 36px;color:#64748b;font-size:14px;line-height:1.75;text-align:center;">
        Enter the code below to complete your sign-in to PETclub.<br>
        This code is valid for <strong style="color:#1e293b;">${expiresMinutes} minutes</strong>.
      </p>

      <!-- OTP block -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td align="center">
            <!--[if mso]>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#fff7ed;border:2px solid #fed7aa;border-radius:16px;padding:28px 52px;">
            <![endif]-->
            <div style="display:inline-block;background:#fff7ed;border:2px solid #fed7aa;border-radius:16px;padding:28px 52px;mso-padding-alt:28px 52px;">
              <p style="margin:0 0 8px;color:#9a3412;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;text-align:center;">One-Time Password</p>
              <p style="margin:0;color:#c2410c;font-size:52px;font-weight:900;letter-spacing:14px;font-family:'Courier New',Courier,'Lucida Console',monospace;line-height:1.1;text-align:center;">${otp}</p>
            </div>
            <!--[if mso]></td></tr></table><![endif]-->
          </td>
        </tr>
      </table>

      <!-- Expiry warning -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr>
          <td bgcolor="#fefce8" style="border:1px solid #fde047;border-radius:10px;padding:14px 20px;">
            <p style="margin:0;color:#713f12;font-size:13px;text-align:center;line-height:1.6;">
              ⏱&nbsp;&nbsp;This code expires in <strong>${expiresMinutes} minutes</strong>.
              &nbsp;Do not share it with anyone.
            </p>
          </td>
        </tr>
      </table>

      <!-- Security notice -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td bgcolor="#f8fafc" style="border-radius:10px;padding:16px 20px;">
            <p style="margin:0;color:#64748b;font-size:12px;line-height:1.8;">
              🔒 <strong>Security notice:</strong> PETclub will never ask for your verification code
              via phone call, SMS, or chat. If you did not request this code, you can safely ignore
              this email — your account remains secure.
            </p>
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
`, { preheader: `Your PETclub code is ${otp} — valid for ${expiresMinutes} minutes. Don't share it.` });

module.exports = { otpTemplate };
