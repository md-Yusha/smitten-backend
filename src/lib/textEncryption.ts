import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = 'enc:v1:';
export const TEXT_ENCRYPTION_KEY_VERSION = 'v1';

function textKey(): Buffer {
  return Buffer.from(config.CHAT_ENCRYPTION_KEY.trim(), 'hex');
}

function fallbackTextKeys(): Buffer[] {
  return (config.CHAT_ENCRYPTION_FALLBACK_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => /^[0-9a-fA-F]{64}$/.test(key) && key.toLowerCase() !== config.CHAT_ENCRYPTION_KEY.toLowerCase())
    .map((key) => Buffer.from(key, 'hex'));
}

export function isEncryptedText(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(PREFIX));
}

export function encryptText(plain: string): string {
  if (isEncryptedText(plain)) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, textKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, enc]).toString('base64url')}`;
}

export function decryptText(value: string): string {
  if (!isEncryptedText(value)) return value;
  const blob = Buffer.from(value.slice(PREFIX.length), 'base64url');
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error('Invalid encrypted text');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const keys = [textKey(), ...fallbackTextKeys()];
  let lastError: unknown;
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Invalid encrypted text');
}
