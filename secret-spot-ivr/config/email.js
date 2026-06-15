const nodemailer = require('nodemailer');

const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO   = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_SECURE = process.env.EMAIL_SECURE === 'true';

const configured = !!(EMAIL_HOST && EMAIL_USER && EMAIL_PASS && EMAIL_TO);

let transporter = null;

if (configured) {
  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
}

async function sendSummaryEmail(subject, textContent, attachmentPath = null) {
  if (!transporter) {
    console.log('  📧  Email no configurado — configure EMAIL_* en .env para activarlo.');
    return;
  }

  const mailOptions = {
    from: `"The Secret Spot AI" <${EMAIL_FROM}>`,
    to: EMAIL_TO,
    subject,
    text: textContent,
  };

  if (attachmentPath) {
    mailOptions.attachments = [
      { filename: require('path').basename(attachmentPath), path: attachmentPath },
    ];
  }

  await transporter.sendMail(mailOptions);
  console.log(`  📧  Resumen enviado a ${EMAIL_TO}`);
}

module.exports = { sendSummaryEmail, configured };
