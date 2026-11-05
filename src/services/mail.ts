import nodemailer from 'nodemailer';
import { config, isSmtpConfigured } from '../config.js';

const fromAddress = config.SMTP_FROM || config.SMTP_USER || 'Smittenz Support <no-reply@smitten.app>';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createTransport() {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP is not configured');
  }

  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });
}

export async function sendPasswordResetCode(to: string, code: string) {
  const transporter = createTransport();
  await transporter.sendMail({
    from: fromAddress,
    to,
    subject: 'Your Smittenz password reset code',
    text: `Your Smittenz password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;">
        <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;">
          <h1 style="font-size:22px;margin:0 0 12px;">Reset your Smittenz password</h1>
          <p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:#6f6078;">Use this code to set a new password. It expires in 10 minutes.</p>
          <div style="font-size:30px;letter-spacing:8px;font-weight:800;color:#e63b72;background:#fff0f5;border-radius:12px;padding:16px 18px;text-align:center;">${code}</div>
          <p style="font-size:12px;line-height:1.5;margin:18px 0 0;color:#9c8dad;">If you did not request this, you can ignore this email.</p>
        </div>
      </div>
    `,
  });
}

export async function sendAppLockRecoveryCode(to: string, code: string) {
  const transporter = createTransport();
  await transporter.sendMail({
    from: fromAddress,
    to,
    subject: 'Your Smittenz lock recovery code',
    text: `Your Smittenz lock recovery code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;">
        <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;">
          <h1 style="font-size:22px;margin:0 0 12px;">Unlock your private space</h1>
          <p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:#6f6078;">Enter this code in Smittenz to disable the forgotten lock. It expires in 10 minutes.</p>
          <div style="font-size:30px;letter-spacing:8px;font-weight:800;color:#e63b72;background:#fff0f5;border-radius:12px;padding:16px 18px;text-align:center;">${code}</div>
          <p style="font-size:12px;line-height:1.5;margin:18px 0 0;color:#9c8dad;">If you did not request this, you can ignore this email.</p>
        </div>
      </div>
    `,
  });
}

export async function sendEmailVerificationCode(to: string, code: string) {
  const transporter = createTransport();
  const info = await transporter.sendMail({
    from: fromAddress,
    to,
    subject: 'Your Smittenz verification code',
    text: `Your Smittenz verification code is ${code}. It expires in 10 minutes.`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;">
        <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;">
          <h1 style="font-size:22px;margin:0 0 12px;">Verify your email</h1>
          <p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:#6f6078;">Enter this code in Smittenz to continue creating your account. It expires in 10 minutes.</p>
          <div style="font-size:30px;letter-spacing:8px;font-weight:800;color:#e63b72;background:#fff0f5;border-radius:12px;padding:16px 18px;text-align:center;">${code}</div>
        </div>
      </div>
    `,
  });
  console.log('[mail] Verification email accepted by SMTP', {
    messageId: info.messageId,
    accepted: info.accepted?.length ?? 0,
    rejected: info.rejected?.length ?? 0,
  });
}

export async function sendWelcomeEmail(to: string, name: string) {
  const transporter = createTransport();
  const firstName = name.trim() || 'there';
  const safeName = escapeHtml(firstName);
  await transporter.sendMail({
    from: fromAddress,
    to,
    subject: 'Welcome to Smittenz',
    text: `Hi ${firstName}, welcome to Smittenz. Your account is ready. Invite your partner with your couple key when you are ready.`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;">
        <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;">
          <h1 style="font-size:22px;margin:0 0 12px;">Welcome to Smittenz</h1>
          <p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:#6f6078;">Hi ${safeName}, your account is ready.</p>
          <p style="font-size:14px;line-height:1.6;margin:0;color:#6f6078;">Invite your partner with your couple key when you are ready.</p>
        </div>
      </div>
    `,
  });
}

export async function sendPartnerWelcomeEmail(to: string, name: string, ownerName: string) {
  const transporter = createTransport();
  const safeName = escapeHtml(name.trim() || 'there');
  const safeOwnerName = escapeHtml(ownerName.trim() || 'your partner');
  await transporter.sendMail({ from: fromAddress, to, subject: 'Welcome to Smittenz', text: `Hi ${name.trim() || 'there'}, your account is now ready to use. You are connected with ${ownerName.trim() || 'your partner'} on Smittenz.`, html: `<div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;"><div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;"><h1 style="font-size:22px;margin:0 0 12px;">Welcome to Smittenz</h1><p style="font-size:14px;line-height:1.6;color:#6f6078;">Hi ${safeName}, your account is now ready to use.</p><p style="font-size:14px;line-height:1.6;color:#6f6078;">You are now connected with ${safeOwnerName}.</p></div></div>` });
}

export async function sendPartnerDeletedEmail(to: string, deletedName: string) {
  const transporter = createTransport();
  const safeName = escapeHtml(deletedName.trim() || 'Your partner');
  await transporter.sendMail({ from: fromAddress, to, subject: 'Your Smittenz partner account was deleted', text: `${deletedName.trim() || 'Your partner'} has deleted their Smittenz account. Their account data has been permanently deleted.`, html: `<div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;"><div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;"><h1 style="font-size:22px;margin:0 0 12px;">Partner account deleted</h1><p style="font-size:14px;line-height:1.6;color:#6f6078;">${safeName} has deleted their Smittenz account.</p><p style="font-size:14px;line-height:1.6;color:#6f6078;">Their account data has been permanently deleted. You can reset your account and invite a new partner if needed.</p></div></div>` });
}

export async function sendAccountDeletedEmail(to: string, name: string) {
  const transporter = createTransport();
  const safeName = escapeHtml(name.trim() || 'there');
  await transporter.sendMail({ from: fromAddress, to, subject: 'Your Smittenz account was deleted', text: `Hi ${name.trim() || 'there'}, your Smittenz account deletion was successful. Your account data has been completely deleted and is safe.`, html: `<div style="font-family:Inter,Arial,sans-serif;background:#fff7fa;padding:24px;color:#221527;"><div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #f0dfe7;border-radius:16px;padding:28px;"><h1 style="font-size:22px;margin:0 0 12px;">Account deletion complete</h1><p style="font-size:14px;line-height:1.6;color:#6f6078;">Hi ${safeName}, your Smittenz account deletion was successful.</p><p style="font-size:14px;line-height:1.6;color:#6f6078;">Your account data has been completely deleted and is safe.</p></div></div>` });
}
