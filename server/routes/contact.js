// server/routes/contact.js
// ─────────────────────────────────────────────────────────────────────────────
// Contact form routes.
// The /send route validates that the sender's email belongs to a registered
// Audenta account before forwarding the message to the admin.
//
// Required .env variables:
//   GMAIL_USER         — sender / admin recipient address
//   GMAIL_APP_PASSWORD — 16-char App Password from Google
// ─────────────────────────────────────────────────────────────────────────────

import express    from 'express';
import nodemailer from 'nodemailer';
import User       from '../models/User.js';

const router = express.Router();

// ── Lazy transporter ──────────────────────────────────────────────────────────
let _transporter = null;
function getTransporter() {
    if (_transporter) return _transporter;
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) throw new Error('GMAIL_USER or GMAIL_APP_PASSWORD not set in .env');
    _transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    return _transporter;
}

// ── POST /api/contact/send ────────────────────────────────────────────────────
// Body: { email, category, message }
// The email must belong to a registered Audenta user.
router.post('/send', async (req, res) => {
    try {
        const { email, category, message } = req.body;

        // ── Input guards ──────────────────────────────────────────────────────
        if (!email || !category || !message) {
            return res.status(400).json({ error: 'Email, category and message are required.' });
        }

        const trimmedMessage = message.trim();
        if (trimmedMessage.length === 0) {
            return res.status(400).json({ error: 'Message cannot be empty.' });
        }

        // ── Validate sender is a registered user ──────────────────────────────
        const user = await User.findOne({ email: email.trim().toLowerCase() });

        if (!user) {
            return res.status(404).json({
                error: 'This email is not registered. Please sign in to an Audenta account first.'
            });
        }

        // ── Allowed categories ────────────────────────────────────────────────
        const allowedCategories = ['account', 'bug', 'feedback', 'business'];
        if (!allowedCategories.includes(category)) {
            return res.status(400).json({ error: 'Invalid category.' });
        }

        const categoryLabels = {
            account:  'Account issue',
            bug:      'Bug report',
            feedback: 'Feedback',
            business: 'Business / partnership'
        };

        // ── Build and send email ──────────────────────────────────────────────
        const transporter  = getTransporter();
        const adminAddress = process.env.GMAIL_USER;
        const sentAt       = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

        const mailOptions = {
            from:    `"Audenta Contact" <${adminAddress}>`,
            to:      adminAddress,
            replyTo: user.email,
            subject: `[Audenta Contact] ${categoryLabels[category]} – ${user.email}`,
            text: `
New contact message from Audenta
─────────────────────────────────

From     : ${user.name} <${user.email}>
Category : ${categoryLabels[category]}
Date     : ${sentAt} UTC

Message
───────
${trimmedMessage}
            `.trim(),
            html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Audenta Contact Message</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="background-color:#101418;padding:28px 36px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:1.5px;text-transform:uppercase;">Audenta</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 36px 28px;">
              <p style="margin:0 0 24px;font-size:20px;font-weight:600;color:#101418;line-height:1.3;">New contact message</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-bottom:24px;">
                <tr>
                  <td style="font-size:12px;font-weight:600;color:#6b7280;padding:6px 0;width:90px;vertical-align:top;">FROM</td>
                  <td style="font-size:13px;color:#101418;padding:6px 0;vertical-align:top;">
                    ${user.name} &lt;<a href="mailto:${user.email}" style="color:#101418;">${user.email}</a>&gt;
                  </td>
                </tr>
                <tr>
                  <td style="font-size:12px;font-weight:600;color:#6b7280;padding:6px 0;vertical-align:top;">CATEGORY</td>
                  <td style="font-size:13px;color:#101418;padding:6px 0;vertical-align:top;">${categoryLabels[category]}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;font-weight:600;color:#6b7280;padding:6px 0;vertical-align:top;">DATE</td>
                  <td style="font-size:13px;color:#101418;padding:6px 0;vertical-align:top;">${sentAt} UTC</td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
                <tr>
                  <td style="background:#f4f4f5;border-radius:8px;padding:18px 20px;">
                    <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7;white-space:pre-wrap;">${trimmedMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px;">
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;" />
            </td>
          </tr>
          <tr>
            <td style="padding:20px 36px 28px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.7;">
                Sent via the Audenta contact form.<br />
                Reply to this email to respond directly to ${user.email}.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
            `.trim(),
        };

        await transporter.sendMail(mailOptions);
        console.log(`[contact] Message from ${user.email} (${category}) forwarded to admin`);

        return res.json({ message: "Your message has been sent. We'll get back to you within 24–48 hours." });

    } catch (err) {
        console.error('[contact/send]', err);
        res.status(500).json({ error: 'Failed to send message. Please try again.' });
    }
});

export default router;