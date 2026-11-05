import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { decryptMedia, encryptMediaFile } from './mediaEncryption.js';

const CHAT_DIR = path.join(process.cwd(), 'data', 'chat');

export function ensureChatMediaDir(): void {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
}

export function chatStoragePath(fileId: string): string {
  return path.join(CHAT_DIR, `${fileId}.enc`);
}

export function chatMediaApiPath(mediaId: string): string {
  const base = (config.PUBLIC_API_URL?.trim() || `http://localhost:${config.PORT}`).replace(/\/$/, '');
  return `${base}/api/v1/chat/media/${encodeURIComponent(mediaId)}`;
}

/** mediaId = `{coupleId}:{fileId}` */
export function createChatMediaId(coupleId: string): string {
  return `${coupleId}:${randomBytes(12).toString('hex')}`;
}

export function parseChatMediaId(mediaId: string): { coupleId: string; fileId: string } | null {
  const sep = mediaId.indexOf(':');
  if (sep <= 0) return null;
  const coupleId = mediaId.slice(0, sep);
  const fileId = mediaId.slice(sep + 1);
  if (!coupleId || !fileId) return null;
  return { coupleId, fileId };
}

export async function persistEncryptedChatFile(tempPath: string, fileId: string): Promise<void> {
  ensureChatMediaDir();
  try {
    await encryptMediaFile(tempPath, chatStoragePath(fileId));
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* temp cleanup optional */
    }
  }
}

export function readDecryptedChatFile(fileId: string): Buffer | null {
  const filePath = chatStoragePath(fileId);
  if (!fs.existsSync(filePath)) return null;
  return decryptMedia(fs.readFileSync(filePath));
}

export function chatMediaIdFromUrl(value: string): string | null {
  const match = value.match(/\/api\/v1\/chat\/media\/([^/?#]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Remove a chat attachment only when its signed-in couple owns the media id. */
export function deleteChatMediaFromUrl(value: string, coupleId: string): void {
  const mediaId = chatMediaIdFromUrl(value);
  if (!mediaId) return;
  const parsed = parseChatMediaId(mediaId);
  if (!parsed || parsed.coupleId !== coupleId) return;
  try {
    fs.unlinkSync(chatStoragePath(parsed.fileId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[chat] Could not remove encrypted attachment', error);
    }
  }
}
