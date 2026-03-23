// server/mailer.js
// ─────────────────────────────────────────────────────────────────────────────
// Nodemailer transporter using Gmail + App Password.
// Required .env variables:
//   GMAIL_USER         — sender address, e.g. audenta.app@gmail.com
//   GMAIL_APP_PASSWORD — 16-char App Password from Google
//     Google Account → Security → 2-Step Verification → App Passwords
// ─────────────────────────────────────────────────────────────────────────────

import nodemailer from 'nodemailer';

const SENDER_NAME = 'Audenta';

// Transporter is created lazily on first use so that process.env is fully
// populated by dotenv before we read it. Top-level reads at import time run
// before dotenv/config in server.js has a chance to load the .env file.
let _transporter = null;
function getTransporter() {
    if (_transporter) return _transporter;

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;

    if (!user || !pass) {
        throw new Error('GMAIL_USER or GMAIL_APP_PASSWORD is not set in .env');
    }

    _transporter = nodemailer.createTransport({
        host:       'smtp.gmail.com',
        port:       587,
        secure:     false,
        requireTLS: true,
        family:     4,
        auth: { user, pass },
    });

    return _transporter;
}

/**
 * Sends a professional OTP verification email.
 * @param {string} to   - Recipient email address
 * @param {string} code - 6-digit OTP code
 */
export async function sendOTPEmail(to, code) {
    const transporter    = getTransporter();
    const SENDER_ADDRESS = process.env.GMAIL_USER;
    // code is sent as-is — no spaces added — so copy-paste from email works directly in the UI

    const mailOptions = {
        from:    `"${SENDER_NAME}" <${SENDER_ADDRESS}>`,
        to,
        subject: `Your Audenta verification code: ${code}`,
        text: `
Your Audenta Verification Code
───────────────────────────────

Your one-time verification code is:

  ${code}

This code expires in 10 minutes. Do not share it with anyone.

If you did not request this code, you can safely ignore this email.

— The Audenta Team
        `.trim(),
        html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Audenta Verification Code</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);" cellspacing="0" cellpadding="0" border="0">

          <!-- Header -->
          <tr>
            <td style="background-color:#101418;padding:28px 36px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:1.5px;text-transform:uppercase;">Audenta</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:600;color:#101418;line-height:1.3;">Verify your email address</p>
              <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">
                Enter this code to verify your Audenta account. It expires in <strong>10 minutes</strong>.
              </p>

              <!-- Code box -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="background:#f4f4f5;border-radius:8px;padding:18px 40px;text-align:center;">
                    <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#101418;font-family:'Courier New',monospace;">${code}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:13px;color:#9ca3af;line-height:1.6;">
                If you didn't create an Audenta account, you can safely ignore this email — no action is needed.
              </p>
              <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;">
                For your security, never share this code with anyone, including Audenta support.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 36px;">
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;" />
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 36px 28px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.7;">
                © ${new Date().getFullYear()} Audenta. All rights reserved.<br />
                You're receiving this because someone signed up for Audenta using this email address.
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
    console.log(`[mailer] OTP sent to ${to}`);
}