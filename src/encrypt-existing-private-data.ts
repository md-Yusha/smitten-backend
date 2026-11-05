import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { prisma } from './lib/prisma.js';
import { persistEncryptedMemoryFile } from './lib/memoryMedia.js';
import { MEDIA_ENCRYPTION_KEY_VERSION } from './lib/mediaEncryption.js';
import { decryptText, encryptText, isEncryptedText, TEXT_ENCRYPTION_KEY_VERSION } from './lib/textEncryption.js';
import { persistEncryptedVaultFile } from './lib/vaultMedia.js';
import { chatMediaIdFromUrl, chatStoragePath, parseChatMediaId } from './lib/chatMedia.js';

function legacyMemoryImagePath(imageUrl: string): string | null {
  if (imageUrl.endsWith('.enc') && !imageUrl.includes('/')) return null;
  const filename = path.basename(imageUrl.split('?')[0]);
  if (!filename) return null;
  const candidates = [
    path.join(process.cwd(), 'uploads', 'memories', filename),
    path.join(process.cwd(), 'data', 'memories', filename),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function encryptMessages(): Promise<number> {
  const rows = await prisma.message.findMany({
    select: { id: true, body: true },
  });

  let count = 0;
  for (const row of rows) {
    if (isEncryptedText(row.body)) continue;
    await prisma.message.update({
      where: { id: row.id },
      data: { body: encryptText(row.body), keyVersion: TEXT_ENCRYPTION_KEY_VERSION },
    });
    count += 1;
  }
  return count;
}

async function encryptMemories(): Promise<{ text: number; images: number }> {
  const rows = await prisma.memory.findMany({
    select: { id: true, title: true, description: true, imageUrl: true },
  });

  let text = 0;
  let images = 0;

  for (const row of rows) {
    const data: { title?: string; description?: string; imageUrl?: string; keyVersion?: string } = {};
    if (!isEncryptedText(row.title)) data.title = encryptText(row.title);
    if (!isEncryptedText(row.description)) data.description = encryptText(row.description);

    if (row.imageUrl && !row.imageUrl.endsWith('.enc')) {
      const legacyPath = legacyMemoryImagePath(row.imageUrl);
      if (legacyPath) {
        data.imageUrl = await persistEncryptedMemoryFile(legacyPath);
        images += 1;
      } else {
        console.warn(`[privacy] Memory image missing for ${row.id}: ${row.imageUrl}`);
      }
    }

    if (Object.keys(data).length > 0) {
      data.keyVersion = TEXT_ENCRYPTION_KEY_VERSION;
      await prisma.memory.update({ where: { id: row.id }, data });
      if (data.title || data.description) text += 1;
    }
  }

  return { text, images };
}

function legacyVaultMediaPath(mediaUrl: string): string | null {
  const filename = path.basename(mediaUrl.split('?')[0]);
  if (!filename) return null;
  const candidates = [
    path.join(process.cwd(), 'data', 'vault', filename),
    path.join(process.cwd(), 'uploads', 'vault', filename),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function encryptVaultMedia(): Promise<{ rows: number; orphanFiles: number }> {
  const rows = await prisma.vaultItem.findMany({
    select: { id: true, mediaUrl: true },
  });
  const migratedSources = new Map<string, string>();
  let migratedRows = 0;

  for (const row of rows) {
    if (row.mediaUrl.endsWith('.enc') && !row.mediaUrl.includes('/')) {
      await prisma.vaultItem.update({
        where: { id: row.id },
        data: { keyVersion: MEDIA_ENCRYPTION_KEY_VERSION },
      });
      continue;
    }

    const sourcePath = legacyVaultMediaPath(row.mediaUrl);
    if (!sourcePath) {
      console.warn(`[privacy] Vault media missing for ${row.id}: ${row.mediaUrl}`);
      continue;
    }
    let encryptedName = migratedSources.get(sourcePath);
    if (!encryptedName) {
      encryptedName = `${randomBytes(12).toString('hex')}.enc`;
      await persistEncryptedVaultFile(sourcePath, encryptedName);
      migratedSources.set(sourcePath, encryptedName);
    }
    await prisma.vaultItem.update({
      where: { id: row.id },
      data: { mediaUrl: encryptedName, keyVersion: MEDIA_ENCRYPTION_KEY_VERSION },
    });
    migratedRows += 1;
  }

  // Encrypt unreferenced legacy files too. They may be remnants of an older DB
  // row, but must not remain readable at rest.
  let orphanFiles = 0;
  for (const dir of [
    path.join(process.cwd(), 'data', 'vault'),
    path.join(process.cwd(), 'uploads', 'vault'),
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.enc')) continue;
      const sourcePath = path.join(dir, name);
      if (!fs.statSync(sourcePath).isFile()) continue;
      await persistEncryptedVaultFile(sourcePath, `${randomBytes(12).toString('hex')}.enc`);
      orphanFiles += 1;
    }
  }

  return { rows: migratedRows, orphanFiles };
}

async function deleteOrphanChatMedia(): Promise<number> {
  const rows = await prisma.message.findMany({
    where: { kind: { in: ['GIF', 'VIDEO'] } },
    select: { body: true },
  });
  const referencedFileIds = new Set<string>();
  for (const row of rows) {
    const mediaId = chatMediaIdFromUrl(isEncryptedText(row.body) ? decryptText(row.body) : row.body);
    const parsed = mediaId ? parseChatMediaId(mediaId) : null;
    if (parsed) referencedFileIds.add(parsed.fileId);
  }

  const chatDir = path.join(process.cwd(), 'data', 'chat');
  if (!fs.existsSync(chatDir)) return 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const name of fs.readdirSync(chatDir)) {
    if (!name.endsWith('.enc')) continue;
    const fileId = name.slice(0, -4);
    if (referencedFileIds.has(fileId)) continue;
    const filePath = chatStoragePath(fileId);
    if (fs.statSync(filePath).mtimeMs > cutoff) continue;
    fs.unlinkSync(filePath);
    deleted += 1;
  }
  return deleted;
}

async function main() {
  const [messages, memories, vault] = await Promise.all([
    encryptMessages(),
    encryptMemories(),
    encryptVaultMedia(),
  ]);
  const [messageVersions, memoryVersions] = await Promise.all([
    prisma.message.updateMany({ data: { keyVersion: TEXT_ENCRYPTION_KEY_VERSION } }),
    prisma.memory.updateMany({ data: { keyVersion: TEXT_ENCRYPTION_KEY_VERSION } }),
  ]);
  const deletedOrphanChatFiles = await deleteOrphanChatMedia();
  console.log(
    JSON.stringify({
      encryptedMessages: messages,
      encryptedMemoryTextRows: memories.text,
      encryptedMemoryImages: memories.images,
      encryptedVaultRows: vault.rows,
      encryptedOrphanVaultFiles: vault.orphanFiles,
      deletedOrphanChatFiles,
      stampedMessageKeyVersions: messageVersions.count,
      stampedMemoryKeyVersions: memoryVersions.count,
    }),
  );
}

main()
  .catch((err) => {
    console.error('[privacy] Encryption migration failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
