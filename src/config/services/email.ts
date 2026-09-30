// src/services/email.ts
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

export async function sendEmail(opts: {
  fromPhoneHandle: string; to: string; subject: string; text: string;
  attachments?: { filename: string; path: string }[];
}) {
  return transporter.sendMail({
    from: `${opts.fromPhoneHandle}@phonemail.com`,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments,
  });
}