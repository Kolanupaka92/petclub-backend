'use strict';
/**
 * PETclub email layout — shared header + footer shell.
 *
 * Uses HTML tables throughout for maximum compatibility:
 *   ✓ Gmail (web + iOS + Android)
 *   ✓ Apple Mail (macOS + iOS)
 *   ✓ Outlook 2016–2021 (Word rendering engine)
 *   ✓ Yahoo Mail
 *
 * All CSS is inline — Gmail strips <style> blocks.
 * The 600px card is centered on desktop; full-width on mobile.
 */

const BRAND        = '#f97316';   // orange-500
const BRAND_LIGHT  = '#fb923c';   // orange-400
const WEBSITE_URL  = process.env.WEBSITE_URL   || 'https://mypetclub.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@mypetclub.app';
const YEAR         = new Date().getFullYear();

/**
 * Wraps `contentHtml` in the standard PETclub email shell.
 *
 * @param {string} contentHtml  Inner body section (no <html>/<body> tags)
 * @param {object} [opts]
 * @param {string} [opts.preheader]  Short preview text shown in inbox before opening
 */
const layout = (contentHtml, { preheader = '' } = {}) => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>PETclub</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings>
    <o:AllowPNG/>
    <o:PixelsPerInch>96</o:PixelsPerInch>
  </o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;min-width:100%;">

${preheader ? `<!-- Hidden preheader — shown in inbox preview before the email is opened -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;visibility:hidden;opacity:0;font-size:1px;line-height:1px;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` : ''}

<!-- ═══ Outer background wrapper ═══ -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <!-- ═══ Email card (max 600px) ═══ -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.08);">

        <!-- ─── HEADER ─── -->
        <tr>
          <td align="center" style="background:linear-gradient(135deg,${BRAND} 0%,${BRAND_LIGHT} 100%);padding:36px 40px 30px;mso-padding-alt:36px 40px 30px 40px;">
            <!--[if mso]>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
            <![endif]-->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center">
                  <!--
                    Logo image — uncomment and set src to your CDN-hosted white logo.
                    <img src="https://cdn.mypetclub.app/email/logo-white.png"
                         alt="PETclub" width="130" height="auto"
                         style="display:block;border:0;max-width:130px;outline:none;-ms-interpolation-mode:bicubic;">
                  -->
                  <div style="font-size:40px;line-height:1;margin-bottom:10px;mso-line-height-rule:exactly;">🐾</div>
                  <h1 style="margin:0 0 6px;color:#ffffff;font-size:30px;font-weight:800;letter-spacing:-0.5px;line-height:1.1;mso-line-height-rule:exactly;">PETclub</h1>
                  <p style="margin:0;color:rgba(255,255,255,0.82);font-size:13px;font-weight:400;letter-spacing:0.4px;line-height:1;">For pets, with love</p>
                </td>
              </tr>
            </table>
            <!--[if mso]></td></tr></table><![endif]-->
          </td>
        </tr>

        <!-- ─── BODY (injected per template) ─── -->
        <tr>
          <td bgcolor="#ffffff" style="padding:0;">
            ${contentHtml}
          </td>
        </tr>

        <!-- ─── FOOTER ─── -->
        <tr>
          <td bgcolor="#f8fafc" style="padding:28px 40px;border-top:1px solid #e2e8f0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

              <!-- Navigation links -->
              <tr>
                <td align="center" style="padding-bottom:14px;">
                  <a href="${WEBSITE_URL}" style="color:${BRAND};text-decoration:none;font-size:13px;font-weight:600;">mypetclub.app</a>
                  <span style="color:#cbd5e1;padding:0 10px;font-size:13px;">·</span>
                  <a href="${WEBSITE_URL}/privacy" style="color:#64748b;text-decoration:none;font-size:12px;">Privacy Policy</a>
                  <span style="color:#cbd5e1;padding:0 10px;font-size:12px;">·</span>
                  <a href="${WEBSITE_URL}/terms" style="color:#64748b;text-decoration:none;font-size:12px;">Terms of Service</a>
                </td>
              </tr>

              <!-- Support contact -->
              <tr>
                <td align="center" style="padding-bottom:16px;">
                  <span style="color:#94a3b8;font-size:12px;">Questions? </span>
                  <a href="mailto:${SUPPORT_EMAIL}" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">${SUPPORT_EMAIL}</a>
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td style="border-top:1px solid #e2e8f0;padding-top:16px;">
                  <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.7;text-align:center;">
                    © ${YEAR} PETclub · All rights reserved.<br>
                    You received this email because you have a PETclub account.<br>
                    If this was unexpected, contact us at
                    <a href="mailto:${SUPPORT_EMAIL}" style="color:#94a3b8;text-decoration:underline;">${SUPPORT_EMAIL}</a>.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>

      </table>
      <!-- /Email card -->

    </td>
  </tr>
</table>
<!-- /Outer wrapper -->

</body>
</html>`;

module.exports = { layout };
