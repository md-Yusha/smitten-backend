import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { encryptMediaFile } from './mediaEncryption.js';

const VAULT_DIR = path.join(process.cwd(), 'data', 'vault');

export function vaultStoragePath(filename: string): string {
  return path.join(VAULT_DIR, filename);
}

export function ensureVaultDir(): void {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
}

export function vaultMediaApiPath(itemId: string): string {
  const base = (config.PUBLIC_API_URL?.trim() || `http://localhost:${config.PORT}`).replace(/\/$/, '');
  return `${base}/api/v1/vault/${itemId}/media`;
}

/** Read uploaded image, encrypt, write as .enc */
export async function persistEncryptedVaultFile(tempPath: string, encFilename: string): Promise<void> {
  ensureVaultDir();
  try {
    await encryptMediaFile(tempPath, vaultStoragePath(encFilename));
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* temp cleanup optional */
    }
  }
}
