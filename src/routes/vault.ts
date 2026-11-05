import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { requireCoupleMembership } from '../lib/coupleAccess.js';
import { createImageUpload, multerSingle } from '../lib/imageUpload.js';
import { decryptMedia, encryptMedia, MEDIA_ENCRYPTION_KEY_VERSION } from '../lib/mediaEncryption.js';
import { mediaContentType, mediaContentTypeForFile } from '../lib/mediaContentType.js';
import { ensureVaultDir, persistEncryptedVaultFile, vaultMediaApiPath, vaultStoragePath } from '../lib/vaultMedia.js';
import { evictCachedVaultMedia, getCachedVaultMedia, setCachedVaultMedia } from '../lib/vaultMediaCache.js';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyPartnerOfVaultImage } from '../services/pushNotifications.js';

const upload = createImageUpload('vault', {
  privateStore: true,
  allowVideo: true,
  maxFileSizeMb: null,
});
const SHARED_VAULT_TTL_MS = 30_000;
const shareSchema = z.object({
  disappearingAfterMs: z.number().int().min(5_000).max(86_400_000).default(SHARED_VAULT_TTL_MS),
});

const router = Router();

const settingsSchema = z.object({
  vaultDisappearingAfterMs: z.number().int().nullable().optional(),
});

function notifyVault(coupleId: string) {
  emitCoupleEvent(coupleId, 'content:updated', { kind: 'vault' });
}

function vaultFileCandidatesFor(stored: string) {
  const primary = stored.includes('://')
    ? path.join(process.cwd(), 'uploads', 'vault', path.basename(stored.split('?')[0]))
    : vaultStoragePath(stored.endsWith('.enc') ? stored : `${stored}.enc`);
  const legacy = vaultStoragePath(stored.replace(/\.enc$/, '.jpg'));
  return primary === legacy ? [primary] : [primary, legacy];
}

function firstExistingVaultFilePath(stored: string) {
  return vaultFileCandidatesFor(stored).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function vaultMediaItemIdFrom(stored: string) {
  const trimmed = stored.trim();
  const match = trimmed.match(/\/api\/v1\/vault\/([^/?#]+)\/media(?:[/?#]|$)/);
  if (match?.[1]) return decodeURIComponent(match[1]);

  try {
    const parsed = new URL(trimmed);
    const parsedMatch = parsed.pathname.match(/\/api\/v1\/vault\/([^/]+)\/media$/);
    return parsedMatch?.[1] ? decodeURIComponent(parsedMatch[1]) : null;
  } catch {
    return null;
  }
}

async function resolveExistingVaultFile(coupleId: string, stored: string, seen = new Set<string>()) {
  const direct = firstExistingVaultFilePath(stored);
  if (direct) return { filePath: direct, stored };

  const referencedItemId = vaultMediaItemIdFrom(stored);
  if (!referencedItemId || seen.has(referencedItemId)) return null;
  seen.add(referencedItemId);

  const referenced = await prisma.vaultItem.findFirst({
    where: { id: referencedItemId, coupleId },
    select: { mediaUrl: true },
  });
  if (!referenced) return null;

  return resolveExistingVaultFile(coupleId, referenced.mediaUrl, seen);
}

function assertVaultFileWasSaved(filename: string) {
  const savedPath = vaultStoragePath(filename);
  if (!fs.existsSync(savedPath) || fs.statSync(savedPath).size <= 200) {
    throw new Error('Encrypted vault file was not saved');
  }
}

function createSharedVaultCopy(sourcePath: string): string {
  ensureVaultDir();
  const encFilename = `${randomBytes(12).toString('hex')}.enc`;
  const source = fs.readFileSync(sourcePath);
  const encrypted = sourcePath.endsWith('.enc') ? source : encryptMedia(source);
  fs.writeFileSync(vaultStoragePath(encFilename), encrypted);
  assertVaultFileWasSaved(encFilename);
  return encFilename;
}

async function deleteVaultFileIfUnused(coupleId: string, stored: string) {
  const remainingReferences = await prisma.vaultItem.count({
    where: { coupleId, mediaUrl: stored },
  });
  if (remainingReferences > 0) return;

  for (const p of vaultFileCandidatesFor(stored)) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function vaultItemPublic(item: {
  id: string;
  mediaUrl: string;
  mediaType?: string | null;
  uploaderId: string;
  uploader: { name: string };
  createdAt: Date;
  visibility?: string | null;
  sourceItemId?: string | null;
  sharedAt?: Date | null;
  expiresAt?: Date | null;
  disappearingAfterMs?: number | null;
}) {
  return {
    id: item.id,
    mediaUrl: vaultMediaApiPath(item.id),
    mediaType: item.mediaType === 'video' ? 'video' : 'image',
    uploaderId: item.uploaderId,
    uploaderName: item.uploader.name,
    visibility: item.visibility ?? 'SHARED',
    sourceItemId: item.sourceItemId ?? null,
    sharedAt: item.sharedAt?.toISOString() ?? null,
    expiresAt: item.expiresAt?.toISOString() ?? null,
    disappearingAfterMs: item.disappearingAfterMs ?? SHARED_VAULT_TTL_MS,
    createdAt: item.createdAt.toISOString(),
  };
}

type VaultPublicItem = ReturnType<typeof vaultItemPublic>;
const completedVaultUploads = new Map<
  string,
  { item: VaultPublicItem; completedAt: number }
>();
const COMPLETED_UPLOAD_RETENTION_MS = 30 * 60 * 1000;

function completedUploadKey(userId: string, uploadId: string) {
  return `${userId}:${uploadId}`;
}

function rememberCompletedVaultUpload(userId: string, uploadId: string, item: VaultPublicItem) {
  if (!uploadId || uploadId === 'unknown') return;
  const now = Date.now();
  for (const [key, value] of completedVaultUploads) {
    if (now - value.completedAt > COMPLETED_UPLOAD_RETENTION_MS) completedVaultUploads.delete(key);
  }
  completedVaultUploads.set(completedUploadKey(userId, uploadId), { item, completedAt: now });
}

async function deleteExpiredSharedVaultItems(coupleId: string) {
  const expired = await prisma.vaultItem.findMany({
    where: {
      coupleId,
      visibility: 'SHARED',
      AND: [
        { expiresAt: { not: null } },
        { expiresAt: { lte: new Date() } },
      ],
    },
  });
  if (expired.length === 0) return;

  await prisma.vaultItem.deleteMany({ where: { id: { in: expired.map((item) => item.id) } } });

  for (const item of expired) {
    evictCachedVaultMedia(`${coupleId}:${item.id}`);
    await deleteVaultFileIfUnused(coupleId, item.mediaUrl);
  }
}

router.get('/upload-status/:uploadId', requireAuth, (req: AuthedRequest, res) => {
  const uploadId = decodeURIComponent(String(req.params.uploadId));
  const completed = completedVaultUploads.get(completedUploadKey(req.userId!, uploadId));
  if (!completed || Date.now() - completed.completedAt > COMPLETED_UPLOAD_RETENTION_MS) {
    res.status(404).json({ error: 'Upload result not found' });
    return;
  }
  res.json({ item: completed.item });
});

router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use the vault' });
    return;
  }

  await deleteExpiredSharedVaultItems(coupleId);
  const now = new Date();
  const items = await prisma.vaultItem.findMany({
    where: {
      coupleId,
      OR: [
        { visibility: 'PRIVATE', uploaderId: req.userId! },
        { visibility: 'SHARED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
    include: { uploader: { select: { id: true, name: true } } },
  });

  const existingItems = [];
  for (const item of items) {
    if (await resolveExistingVaultFile(coupleId, item.mediaUrl)) {
      existingItems.push(item);
    }
  }

  res.json({
    items: existingItems.map(vaultItemPublic),
    serverNow: new Date().toISOString(),
  });
});

router.post(
  '/',
  requireAuth,
  multerSingle('media', upload),
  async (req: AuthedRequest, res) => {
    try {
      const coupleId = await requireCoupleMembership(req.userId!);
      if (!coupleId) {
        res.status(403).json({ error: 'Join a couple to use the vault' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Pick media to upload' });
        return;
      }

      const uploadId = req.get('x-upload-id') || 'unknown';
      const priorUpload = completedVaultUploads.get(completedUploadKey(req.userId!, uploadId));
      if (uploadId !== 'unknown' && priorUpload) {
        res.json({ item: priorUpload.item });
        return;
      }
      const startedAt = Date.now();
      const contentType = mediaContentTypeForFile(req.file.path);
      const mediaType = contentType.startsWith('video/') ? 'video' : contentType.startsWith('image/') ? 'image' : null;
      if (!mediaType) {
        fs.unlinkSync(req.file.path);
        res.status(400).json({ error: 'Unsupported media format' });
        return;
      }

      const encFilename = `${randomBytes(12).toString('hex')}.enc`;
      await persistEncryptedVaultFile(req.file.path, encFilename);
      assertVaultFileWasSaved(encFilename);

      const item = await prisma.vaultItem.create({
        data: {
          coupleId,
          uploaderId: req.userId!,
          mediaUrl: encFilename,
          mediaType,
          keyVersion: MEDIA_ENCRYPTION_KEY_VERSION,
          visibility: 'PRIVATE',
        },
        include: { uploader: { select: { id: true, name: true } } },
      });

      const publicItem = vaultItemPublic(item);
      rememberCompletedVaultUpload(req.userId!, uploadId, publicItem);
      notifyVault(coupleId);
      console.info('[vault] upload complete', {
        uploadId,
        bytes: req.file.size,
        mediaType,
        durationMs: Date.now() - startedAt,
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
      res.status(201).json({
        item: publicItem,
      });
    } catch (e) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* best-effort cleanup */ }
      }
      console.error('[vault] upload error', {
        uploadId: req.get('x-upload-id') || 'unknown',
        bytes: req.file?.size,
        message: e instanceof Error ? e.message : String(e),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
      res.status(500).json({ error: 'Could not save vault item' });
    }
  },
);

router.post('/:id/open', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use the vault' });
    return;
  }

  const id = String(req.params.id);
  const item = await prisma.vaultItem.findFirst({
    where: { id, coupleId },
    include: { uploader: { select: { id: true, name: true } } },
  });
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const isShared = (item.visibility ?? 'SHARED') === 'SHARED';
  if (!isShared) {
    res.json({ item: vaultItemPublic(item), serverNow: new Date().toISOString() });
    return;
  }

  if (item.uploaderId === req.userId!) {
    res.json({ item: vaultItemPublic(item), serverNow: new Date().toISOString() });
    return;
  }

  const now = new Date();
  const ttlMs = Math.max(5_000, Math.min(86_400_000, item.disappearingAfterMs ?? SHARED_VAULT_TTL_MS));
  const updated =
    item.expiresAt && item.expiresAt > now
      ? item
      : await prisma.vaultItem.update({
          where: { id: item.id },
          data: {
            expiresAt: new Date(now.getTime() + ttlMs),
          },
          include: { uploader: { select: { id: true, name: true } } },
        });

  notifyVault(coupleId);
  res.json({ item: vaultItemPublic(updated), serverNow: new Date().toISOString() });
});

/** Decrypt and stream — only for authenticated couple members. */
router.get('/:id/media', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const coupleId = await requireCoupleMembership(req.userId!);
    if (!coupleId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const id = String(req.params.id);
    const item = await prisma.vaultItem.findFirst({
      where: { id, coupleId },
    });
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const isShared = (item.visibility ?? 'SHARED') === 'SHARED';
    const isExpired = Boolean(item.expiresAt && item.expiresAt <= new Date());
    const receiverHasOpened = Boolean(item.expiresAt);
    if (item.uploaderId !== req.userId! && (!isShared || !receiverHasOpened || isExpired)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (isShared && isExpired) {
      res.status(404).json({ error: 'Expired' });
      return;
    }

    const resolvedFile = await resolveExistingVaultFile(coupleId, item.mediaUrl);
    const filePath = resolvedFile?.filePath ?? null;

    const cacheKey = `${coupleId}:${id}`;
    let plain = getCachedVaultMedia(cacheKey);

    if (!plain) {
      if (!filePath) {
        res.status(404).json({ error: 'Media file missing' });
        return;
      } else if (filePath.endsWith('.enc')) {
        const encrypted = fs.readFileSync(filePath);
        plain = decryptMedia(encrypted);
      } else {
        plain = fs.readFileSync(filePath);
      }
      setCachedVaultMedia(cacheKey, plain);
    }

    res.setHeader('Content-Type', mediaContentType(plain));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('ETag', `"${id}"`);
    res.send(plain);
  } catch (e) {
    console.error('[vault] media error', e);
    res.status(500).json({ error: 'Could not load media' });
  }
});

router.post('/:id/share', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use the vault' });
    return;
  }

  const id = String(req.params.id);
  const item = await prisma.vaultItem.findFirst({
    where: { id, coupleId },
  });
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (item.uploaderId !== req.userId!) {
    res.status(403).json({ error: 'Only the uploader can share this item' });
    return;
  }

  const parsed = shareSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Choose a viewing time between 5 seconds and 24 hours' });
    return;
  }

  const now = new Date();
  const existingShare = await prisma.vaultItem.findFirst({
    where: {
      coupleId,
      uploaderId: req.userId!,
      visibility: 'SHARED',
      sourceItemId: item.id,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { uploader: { select: { id: true, name: true } } },
  });
  if (existingShare) {
    res.json({ item: vaultItemPublic(existingShare), alreadyShared: true });
    return;
  }

  const resolvedFile = await resolveExistingVaultFile(coupleId, item.mediaUrl);
  if (!resolvedFile) {
    res.status(404).json({ error: 'Source image is missing' });
    return;
  }
  const encFilename = createSharedVaultCopy(resolvedFile.filePath);

  let shared;
  try {
    shared = await prisma.vaultItem.create({
      data: {
        coupleId,
        uploaderId: req.userId!,
        mediaUrl: encFilename,
        mediaType: item.mediaType,
        keyVersion: MEDIA_ENCRYPTION_KEY_VERSION,
        visibility: 'SHARED',
        sourceItemId: item.id,
        sharedAt: now,
        expiresAt: null,
        disappearingAfterMs: parsed.data.disappearingAfterMs,
      },
      include: { uploader: { select: { id: true, name: true } } },
    });
  } catch (error) {
    try {
      fs.unlinkSync(vaultStoragePath(encFilename));
    } catch {
      /* best-effort cleanup */
    }
    console.error('[vault] share error', error);
    res.status(500).json({ error: 'Could not share this Vault item' });
    return;
  }

  notifyVault(coupleId);
  void notifyPartnerOfVaultImage(coupleId, req.userId!).catch(() => {});
  res.json({ item: vaultItemPublic(shared) });
});

router.delete('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use the vault' });
    return;
  }

  const id = String(req.params.id);
  const item = await prisma.vaultItem.findFirst({
    where: { id, coupleId },
  });
  if (!item) {
    res.json({ ok: true });
    return;
  }
  if (item.uploaderId !== req.userId) {
    res.status(403).json({ error: 'Only the uploader can delete this item' });
    return;
  }

  evictCachedVaultMedia(`${coupleId}:${id}`);
  await prisma.vaultItem.delete({ where: { id: item.id } });
  await deleteVaultFileIfUnused(coupleId, item.mediaUrl);
  notifyVault(coupleId);
  res.json({ ok: true });
});

router.patch('/settings', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings' });
    return;
  }

  const { vaultDisappearingAfterMs } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (vaultDisappearingAfterMs !== undefined && user.coupleId) {
    await prisma.user.updateMany({
      where: { coupleId: user.coupleId },
      data: { vaultDisappearingAfterMs },
    });
  }

  res.json({ ok: true });
});

export default router;
