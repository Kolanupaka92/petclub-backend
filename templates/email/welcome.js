'use strict';
/**
 * Customer welcome email — sent after a new user completes their profile (set-role → customer).
 *
 * Includes an optional pet card when the user registered a pet during onboarding.
 */

const { layout } = require('./_layout');

const APP_URL = process.env.WEB_APP_URL || 'https://app.mypetclub.app';

/**
 * @param {object} data
 * @param {string} data.name          — user's full name
 * @param {object} [data.pet]         — optional pet: { name, species, breed, age }
 */
const welcomeCustomerTemplate = ({ name, pet }) => {
  const fn = (name || 'there').split(' ')[0];

  const petCard = pet?.name ? `
      <!-- Pet profile card -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr>
          <td bgcolor="#fff7ed" style="border:1.5px solid #fed7aa;border-radius:14px;padding:18px 22px;">
            <p style="margin:0 0 4px;font-weight:800;color:#9a3412;font-size:14px;">🐾 ${pet.name} is now on PETclub!</p>
            <p style="margin:0;color:#c2410c;font-size:13px;">
              ${[pet.species, pet.breed, pet.age ? `${pet.age} yr${pet.age !== 1 ? 's' : ''}` : ''].filter(Boolean).join(' &nbsp;·&nbsp; ') || 'Ready for their first booking!'}
            </p>
          </td>
        </tr>
      </table>` : '';

  return layout(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:44px 44px 40px;mso-padding-alt:44px 44px 40px 44px;">

      <!-- Greeting -->
      <h2 style="margin:0 0 12px;color:#1e293b;font-size:23px;font-weight:800;letter-spacing:-0.3px;">
        Welcome to PETclub, ${fn}! 🐾
      </h2>
      <p style="margin:0 0 28px;color:#64748b;font-size:14px;line-height:1.80;">
        Your account is active. You can now book verified groomers, trainers, and vets for your pet — all from one place.
      </p>

      ${petCard}

      <!-- Feature highlights -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
        <tr>
          <td bgcolor="#f0fdf4" style="border:1.5px solid #bbf7d0;border-radius:14px;padding:24px 26px;">
            <p style="margin:0 0 16px;font-weight:800;color:#166534;font-size:14px;">🌟 Here's what you can do:</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${[
                ['📋', 'Book certified groomers, trainers &amp; vets near you'],
                ['🐕', 'Add multiple pet profiles and manage their details'],
                ['💉', 'Track health records, vaccinations &amp; deworming schedules'],
                ['📅', 'Receive appointment reminders and booking updates'],
              ].map(([icon, text]) => `
              <tr>
                <td style="padding:6px 0;vertical-align:top;width:28px;">
                  <span style="font-size:16px;">${icon}</span>
                </td>
                <td style="padding:6px 0;color:#15803d;font-size:13px;line-height:1.65;">${text}</td>
              </tr>`).join('')}
            </table>
          </td>
        </tr>
      </table>

      <!-- CTA button -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr>
          <td align="center" bgcolor="#f97316" style="border-radius:50px;mso-padding-alt:0;padding:0;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
              href="${APP_URL}" style="height:52px;v-text-anchor:middle;width:220px;" arcsize="50%" fillcolor="#f97316" strokecolor="#f97316">
              <w:anchorlock/>
              <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:700;">Open PETclub App →</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="${APP_URL}"
               style="display:inline-block;padding:15px 44px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.2px;border-radius:50px;mso-hide:all;">
              Open PETclub App →
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
`, { preheader: `Welcome to PETclub, ${fn}! Your account is ready — book your first service today.` });
};

module.exports = { welcomeCustomerTemplate };
