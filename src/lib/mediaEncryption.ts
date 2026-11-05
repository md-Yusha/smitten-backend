import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
export const MEDIA_ENCRYPTION_KEY_VERSION = 'v1';

function mediaKey(): Buffer {
  return Buffer.from(config.MEDIA_ENCRYPTION_KEY.trim(), 'hex');
}

function fallbackMediaKeys(): Buffer[] {
  return (config.MEDIA_ENCRYPTION_FALLBACK_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => /^[0-9a-fA-F]{64}$/.test(key) && key.toLowerCase() !== config.MEDIA_ENCRYPTION_KEY.toLowerCase())
    .map((key) => Buffer.from(key, 'hex'));
}

/** Encrypt file bytes for vault storage (IV + auth tag + ciphertext). */
export function encryptMedia(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, mediaKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/**
 * Encrypt a file without holding the upload and multiple encrypted copies in memory.
 * The existing on-disk format remains IV + auth tag + ciphertext.
 */
export async function encryptMediaFile(sourcePath: string, destinationPath: string): Promise<void> {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, mediaKey(), iv);
  fs.writeFileSync(destinationPath, Buffer.concat([iv, Buffer.alloc(TAG_LEN)]));
  try {
    await pipeline(
      fs.createReadStream(sourcePath),
      cipher,
      fs.createWriteStream(destinationPath, { flags: 'r+', start: IV_LEN + TAG_LEN }),
    );
    const handle = await fs.promises.open(destinationPath, 'r+');
    try {
      await handle.write(cipher.getAuthTag(), 0, TAG_LEN, IV_LEN);
    } finally {
      await handle.close();
    }
  } catch (error) {
    try {
      fs.unlinkSync(destinationPath);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

/** Decrypt vault blob; supports legacy unencrypted JPEG (magic FF D8). */
export function decryptMedia(blob: Buffer): Buffer {
  if (blob.length >= 2 && blob[0] === 0xff && blob[1] === 0xd8) {
    return blob;
  }
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Invalid encrypted media');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const keys = [mediaKey(), ...fallbackMediaKeys()];
  let lastError: unknown;
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Invalid encrypted media');
}
