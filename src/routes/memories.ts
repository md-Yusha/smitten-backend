import { Router } from 'express';
import { config } from '../config.js';
import fs from 'node:fs';
import { z } from 'zod';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { requireCoupleMembership } from '../lib/coupleAccess.js';
import { createImageUpload, multerSingle } from '../lib/imageUpload.js';
import { mediaContentType, mediaContentTypeForFile } from '../lib/mediaContentType.js';
import {
  deleteMemoryMedia,
  memoryMediaApiPath,
  memoryMediaVersion,
  persistEncryptedMemoryFile,
  readDecryptedMemoryFile,
} from '../lib/memoryMedia.js';
import { prisma } from '../lib/prisma.js';
import { decryptText, encryptText, TEXT_ENCRYPTION_KEY_VERSION } from '../lib/textEncryption.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyPartnerOfMemory } from '../services/pushNotifications.js';

const upload = createImageUpload('memories', {
  privateStore: true,
  allowVideo: true,
  maxFileSizeMb: null,
});

const createSchema = z.object({
  title: z.string().min(1).max(120).transform((s) => s.trim()),
  description: z.string().max(2000).optional(),
  memoryAt: z.string().min(8).max(32),
  isSpecialMoment: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

const patchSchema = z
  .object({
    title: z.string().min(1).max(120).transform((s) => s.trim()).optional(),
    description: z.string().max(2000).optional(),
    memoryAt: z.string().min(8).max(32).optional(),
    isSpecialMoment: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value) => value === undefined ? undefined : value === true || value === 'true'),
    removeMedia: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value) => value === undefined ? undefined : value === true || value === 'true'),
  })
  .refine((d) => d.title !== undefined || d.description !== undefined || d.memoryAt !== undefined || d.isSpecialMoment !== undefined || d.removeMedia !== undefined, {
    message: 'Nothing to update',
  });

const router = Router();

function notifyMemories(coupleId: string) {
  emitCoupleEvent(coupleId, 'content:updated', { kind: 'memory' });
}

function parseMemoryAt(raw: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date(raw);
}

function memoryToPublic(m: {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  mediaType?: string | null;
  memoryAt: Date;
  isSpecialMoment: boolean;
  creatorId: string;
  creator: { name: string };
  createdAt: Date;
  updatedAt?: Date;
}, viewerId?: string) {
  return {
    id: m.id,
    title: decryptText(m.title),
    description: decryptText(m.description),
    imageUrl: m.imageUrl ? memoryMediaApiPath(m.id) : null,
    mediaVersion: memoryMediaVersion(m.imageUrl),
    mediaType: m.mediaType === 'video' ? 'video' : 'image',
    memoryAt: m.memoryAt.toISOString(),
    isSpecialMoment: m.isSpecialMoment,
    creatorId: m.creatorId,
    creatorName: m.creator.name,
    canManage: Boolean(viewerId),
    createdAt: m.createdAt.toISOString(),
    updatedAt: (m.updatedAt ?? m.createdAt).toISOString(),
  };
}

router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use memories' });
    return;
  }

  const rows = await prisma.memory.findMany({
    where: { coupleId },
    orderBy: { memoryAt: 'desc' },
    include: { creator: { select: { id: true, name: true } } },
  });

  res.json({
    memories: rows.map((row) => memoryToPublic(row, req.userId!)),
  });
});

router.post('/', requireAuth, multerSingle('image', upload), async (req: AuthedRequest, res) => {
  try {
    const coupleId = await requireCoupleMembership(req.userId!);
    if (!coupleId) {
      res.status(403).json({ error: 'Join a couple to use memories' });
      return;
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid memory', details: parsed.error.flatten() });
      return;
    }

    const { title, description, isSpecialMoment } = parsed.data;
    const memoryAt = parseMemoryAt(parsed.data.memoryAt);
    const uploadedType = req.file ? mediaContentTypeForFile(req.file.path) : null;
    if (req.file && uploadedType?.startsWith('video/') && !config.MEMORIES_VIDEO_UPLOAD_ENABLED) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: 'Video uploads are temporarily disabled in Memories' });
      return;
    }
    const mediaType = uploadedType?.startsWith('video/')
      ? 'video'
      : uploadedType?.startsWith('image/')
        ? 'image'
        : null;
    if (req.file && !mediaType) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: 'Unsupported media format' });
      return;
    }
    const imageUrl = req.file ? await persistEncryptedMemoryFile(req.file.path) : null;

    const row = await prisma.memory.create({
      data: {
        coupleId,
        creatorId: req.userId!,
        title: encryptText(title),
        description: encryptText(description?.trim() ?? ''),
        keyVersion: TEXT_ENCRYPTION_KEY_VERSION,
        memoryAt,
        imageUrl,
        mediaType: mediaType ?? 'image',
        isSpecialMoment: isSpecialMoment ?? false,
      },
      include: { creator: { select: { id: true, name: true } } },
    });

    notifyMemories(coupleId);
    void notifyPartnerOfMemory(coupleId, req.userId!, parsed.data.title).catch(() => {});
    res.status(201).json({
      memory: memoryToPublic(row, req.userId!),
    });
  } catch (e) {
    console.error('[memories] create error', e);
    res.status(500).json({ error: 'Could not save memory' });
  }
});

router.patch('/:id', requireAuth, multerSingle('image', upload), async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use memories' });
    return;
  }

  const parsed:
    | { success: true; data: { title?: string; description?: string; memoryAt?: string; isSpecialMoment?: boolean; removeMedia?: boolean } }
    | ReturnType<typeof patchSchema.safeParse> =
    req.file && Object.keys(req.body ?? {}).length === 0
      ? ({ success: true, data: {} } as const)
      : patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }

  const id = String(req.params.id);
  const existing = await prisma.memory.findFirst({ where: { id, coupleId } });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const { title, description, memoryAt: memoryAtRaw, isSpecialMoment, removeMedia } = parsed.data;
  const uploadedType = req.file ? mediaContentTypeForFile(req.file.path) : null;
  if (req.file && uploadedType?.startsWith('video/') && !config.MEMORIES_VIDEO_UPLOAD_ENABLED) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'Video uploads are temporarily disabled in Memories' });
    return;
  }
  const replacementMediaType = uploadedType?.startsWith('video/')
    ? 'video'
    : uploadedType?.startsWith('image/')
      ? 'image'
      : null;
  if (req.file && !replacementMediaType) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'Unsupported media format' });
    return;
  }
  if (removeMedia && !req.file) deleteMemoryMedia(existing.imageUrl);
  const row = await prisma.memory.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title: encryptText(title) } : {}),
      ...(description !== undefined ? { description: encryptText(description.trim()) } : {}),
      ...(title !== undefined || description !== undefined || req.file ? { keyVersion: TEXT_ENCRYPTION_KEY_VERSION } : {}),
      ...(memoryAtRaw !== undefined ? { memoryAt: parseMemoryAt(memoryAtRaw) } : {}),
      ...(isSpecialMoment !== undefined ? { isSpecialMoment } : {}),
      ...(removeMedia && !req.file ? { imageUrl: null, mediaType: 'image' } : {}),
      ...(req.file
        ? {
            imageUrl: await (async () => {
              const next = await persistEncryptedMemoryFile(req.file!.path);
              deleteMemoryMedia(existing.imageUrl);
              return next;
            })(),
            mediaType: replacementMediaType!,
          }
        : {}),
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  notifyMemories(coupleId);
  res.json({
    memory: memoryToPublic(row, req.userId!),
  });
});

router.get('/:id/image', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const coupleId = await requireCoupleMembership(req.userId!);
    if (!coupleId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const id = String(req.params.id);
    const row = await prisma.memory.findFirst({ where: { id, coupleId } });
    if (!row?.imageUrl) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const plain = readDecryptedMemoryFile(row.imageUrl);
    if (!plain) {
      res.status(404).json({ error: 'Image file missing' });
      return;
    }

    res.setHeader('Content-Type', mediaContentType(plain));
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', `"${id}-${memoryMediaVersion(row.imageUrl) ?? 'none'}"`);
    res.send(plain);
  } catch (e) {
    console.error('[memories] image error', e);
    res.status(500).json({ error: 'Could not load memory image' });
  }
});

router.delete('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use memories' });
    return;
  }

  const id = String(req.params.id);
  const row = await prisma.memory.findFirst({
    where: { id, coupleId },
  });
  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  await prisma.memory.delete({ where: { id: row.id } });
  deleteMemoryMedia(row.imageUrl);
  notifyMemories(coupleId);
  res.json({ ok: true });
});

export default router;
