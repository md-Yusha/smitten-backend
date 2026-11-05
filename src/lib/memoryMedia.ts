import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { decryptMedia, encryptMediaFile } from './mediaEncryption.js';

const MEMORY_DIR = path.join(process.cwd(), 'data', 'memories');
const LEGACY_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'memories');

export function ensureMemoryMediaDir(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

export function memoryStoragePath(filename: string): string {
  return path.join(MEMORY_DIR, filename);
}

export function memoryMediaApiPath(memoryId: string): string {
  const base = (config.PUBLIC_API_URL?.trim() || `http://localhost:${config.PORT}`).replace(/\/$/, '');
  return `${base}/api/v1/memories/${memoryId}/image`;
}

export function memoryMediaVersion(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const filename = path.basename(stored.split('?')[0]);
  return createHash('sha256').update(filename).digest('hex').slice(0, 16);
}

export function createEncryptedMemoryFilename(): string {
  return `${randomBytes(12).toString('hex')}.enc`;
}

export async function persistEncryptedMemoryFile(tempPath: string, encFilename = createEncryptedMemoryFilename()): Promise<string> {
  ensureMemoryMediaDir();
  try {
    await encryptMediaFile(tempPath, memoryStoragePath(encFilename));
    return encFilename;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* temp cleanup optional */
    }
  }
}

export function readDecryptedMemoryFile(stored: string): Buffer | null {
  const filename = path.basename(stored.split('?')[0]);
  const encryptedName = filename.endsWith('.enc') ? filename : `${filename}.enc`;
  const encryptedPath = memoryStoragePath(encryptedName);
  if (fs.existsSync(encryptedPath)) {
    return decryptMedia(fs.readFileSync(encryptedPath));
  }

  const legacyPath = path.join(LEGACY_UPLOAD_DIR, filename);
  if (fs.existsSync(legacyPath)) {
    return fs.readFileSync(legacyPath);
  }

  return null;
}

export function deleteMemoryMedia(stored: string | null | undefined): void {
  if (!stored) return;
  const filename = path.basename(stored.split('?')[0]);
  const candidates = [
    memoryStoragePath(filename.endsWith('.enc') ? filename : `${filename}.enc`),
    path.join(LEGACY_UPLOAD_DIR, filename),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
}
