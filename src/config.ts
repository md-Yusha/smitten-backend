import { z } from 'zod';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('*'),
  /** Base URL phones use to load /uploads (LAN IP). Falls back to localhost. */
  PUBLIC_API_URL: z.string().optional(),
  PASSKEY_REDIRECT_URL: z.string().url().default('smitten://auth/have-key'),
  ANDROID_APP_LINK_SHA256_CERT_FINGERPRINT: z.string().optional(),
  IOS_TEAM_ID: z.string().optional(),
  MEMORIES_VIDEO_UPLOAD_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  /** 64-char hex (32 bytes) for AES-256-GCM text encryption. */
  CHAT_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex string'),
  /** Optional comma-separated old text keys used only to read data during key migration. */
  CHAT_ENCRYPTION_FALLBACK_KEYS: z.string().optional(),
  /** 64-char hex (32 bytes) for AES-256-GCM media encryption. */
  MEDIA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex string'),
  /** Optional comma-separated old media keys used only to read data during key migration. */
  MEDIA_ENCRYPTION_FALLBACK_KEYS: z.string().optional(),
  /** PhonePe Payment Gateway (server-only — never expose to Expo). */
  PHONEPE_CLIENT_ID: z.string().optional(),
  PHONEPE_CLIENT_SECRET: z.string().optional(),
  PHONEPE_CLIENT_VERSION: z.coerce.number().default(1),
  PHONEPE_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  PHONEPE_WEBHOOK_USERNAME: z.string().optional(),
  PHONEPE_WEBHOOK_PASSWORD: z.string().optional(),
  PHONEPE_REDIRECT_BASE_URL: z.string().optional(),
  PHONEPE_REQUEST_TIMEOUT: z.coerce.number().default(30),
  /** Admin panel (server-rendered DB browser at /admin) — never expose these to Expo. */
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  /** Signs the admin session cookie. Falls back to a hash of JWT_ACCESS_SECRET if unset. */
  ADMIN_SESSION_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export function isPhonePeConfigured(): boolean {
  return Boolean(
    config.PHONEPE_CLIENT_ID &&
      config.PHONEPE_CLIENT_SECRET &&
      config.PHONEPE_WEBHOOK_USERNAME &&
      config.PHONEPE_WEBHOOK_PASSWORD,
  );
}

/** Admin panel is only reachable once a password is set — keeps it off by default in fresh checkouts. */
export function isAdminConfigured(): boolean {
  return Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.length > 0);
}

export function adminSessionSecret(): string {
  const explicit = config.ADMIN_SESSION_SECRET?.trim();
  if (explicit) return explicit;
  return createHash('sha256').update(`admin:${config.JWT_ACCESS_SECRET}`).digest('hex');
}

export function isSmtpConfigured(): boolean {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}
