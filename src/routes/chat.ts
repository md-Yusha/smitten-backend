import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireCoupleMembership } from '../lib/coupleAccess.js';
import {
  chatMediaApiPath,
  createChatMediaId,
  deleteChatMediaFromUrl,
  parseChatMediaId,
  persistEncryptedChatFile,
  readDecryptedChatFile,
} from '../lib/chatMedia.js';
import { createImageUpload, multerSingle } from '../lib/imageUpload.js';
import { mediaContentType, mediaContentTypeForFile } from '../lib/mediaContentType.js';
import { expiresAtForTtl, isPartnerOnline, pickPartner, toMessagePublic } from '../lib/messageDto.js';
import { decryptText, encryptText, TEXT_ENCRYPTION_KEY_VERSION } from '../lib/textEncryption.js';
import { toUserPublic, userInclude } from '../lib/userDto.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import type { Server as SocketServer } from 'socket.io';
import { notifyPartnerOfMessage } from '../services/pushNotifications.js';

let io: SocketServer | null = null;

export function setChatIo(server: SocketServer) {
  io = server;
}

const sendSchema = z.object({
  kind: z.enum(['text', 'sticker', 'gif', 'video']).default('text'),
  body: z.string().min(1).max(4000),
  replyToId: z.string().min(3).max(32).nullable().optional(),
});

const settingsSchema = z.object({
  chatDisappearingAfterMs: z.number().int().nullable().optional(),
  chatThemeId: z.string().min(1).max(32).optional(),
  partnerPetName: z.string().min(1).max(40).optional(),
});

const editMessageSchema = z.object({
  body: z.string().min(1).max(4000).transform((s) => s.trim()),
});

const reactionSchema = z.object({
  reaction: z.string().max(64).nullable(),
});

const replaceMediaSchema = z.object({
  mediaId: z.string().min(3).max(300),
});

const router = Router();
const chatMediaUpload = createImageUpload('chat', {
  privateStore: true,
  allowVideo: true,
  maxFileSizeMb: null,
});

async function requireCouple(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { couple: { include: { users: true } } },
  });
  if (!user?.coupleId || !user.couple) {
    return null;
  }
  return user;
}

function activeDisappearingMs(user: NonNullable<Awaited<ReturnType<typeof requireCouple>>>): number | null {
  const enabled = user.couple!.users
    .map((u) => u.chatDisappearingAfterMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return enabled.length ? Math.min(...enabled) : null;
}

async function deleteExpiredMessages(coupleId: string, now: Date): Promise<void> {
  const expired = await prisma.message.findMany({
    where: { coupleId, expiresAt: { not: null, lte: now } },
    select: { id: true, body: true, kind: true },
  });
  if (expired.length === 0) return;
  await prisma.message.deleteMany({ where: { id: { in: expired.map((message) => message.id) } } });
  for (const message of expired) {
    if (message.kind !== 'GIF' && message.kind !== 'VIDEO') continue;
    deleteChatMediaFromUrl(decryptText(message.body), coupleId);
  }
}

router.get('/messages', requireAuth, async (req: AuthedRequest, res) => {
  const user = await requireCouple(req.userId!);
  if (!user) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }

  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  const now = new Date();
  const disappearingMs = activeDisappearingMs(user);

  await deleteExpiredMessages(user.coupleId!, now);

  const messages = await prisma.message.findMany({
    where: {
      coupleId: user.coupleId!,
      ...(disappearingMs ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {}),
      ...(after ? { createdAt: { gt: new Date(after) } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  const partner = pickPartner(user.couple!.users, user.id);

  res.json({
    messages: messages.map(toMessagePublic),
    partnerOnline: isPartnerOnline(partner?.lastSeenAt),
  });
});

router.post(
  '/media',
  requireAuth,
  multerSingle('media', chatMediaUpload),
  async (req: AuthedRequest, res) => {
    try {
      const coupleId = await requireCoupleMembership(req.userId!);
      if (!coupleId) {
        res.status(403).json({ error: 'Join a couple to use chat' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Pick media to send' });
        return;
      }

      const contentType = mediaContentTypeForFile(req.file.path);
      const mediaType = contentType.startsWith('video/') ? 'video' : contentType.startsWith('image/') ? 'image' : null;
      if (!mediaType) {
        fs.unlinkSync(req.file.path);
        res.status(400).json({ error: 'Unsupported media format' });
        return;
      }

      const mediaId = createChatMediaId(coupleId);
      const parsed = parseChatMediaId(mediaId);
      if (!parsed) {
        res.status(500).json({ error: 'Could not create media id' });
        return;
      }

      await persistEncryptedChatFile(req.file.path, parsed.fileId);

      res.status(201).json({
        mediaId,
        mediaUrl: chatMediaApiPath(mediaId),
        mediaType,
      });
    } catch (e) {
      console.error('[chat] media upload error', e);
      res.status(500).json({ error: 'Could not upload media' });
    }
  },
);

router.get('/media/:mediaId', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const coupleId = await requireCoupleMembership(req.userId!);
    if (!coupleId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const mediaId = decodeURIComponent(String(req.params.mediaId));
    const parsed = parseChatMediaId(mediaId);
    if (!parsed || parsed.coupleId !== coupleId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const plain = readDecryptedChatFile(parsed.fileId);
    if (!plain) {
      res.status(404).json({ error: 'Media file missing' });
      return;
    }

    res.setHeader('Content-Type', mediaContentType(plain));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(plain);
  } catch (e) {
    console.error('[chat] media read error', e);
    res.status(500).json({ error: 'Could not load media' });
  }
});

router.post('/messages', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid message' });
    return;
  }
  if (
    (parsed.data.kind === 'video' || parsed.data.kind === 'gif') &&
    (/^\//.test(parsed.data.body) || /^(file|content|ph|assets-library):\/\//i.test(parsed.data.body))
  ) {
    res.status(400).json({ error: 'Upload media before sending the message' });
    return;
  }

  const user = await requireCouple(req.userId!);
  if (!user) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }

  let replyToId: string | null = null;
  const replyToInput = parsed.data.replyToId;
  if (replyToInput) {
    const replyTarget = await prisma.message.findFirst({ where: { id: replyToInput, coupleId: user.coupleId! } });
    if (!replyTarget) {
      res.status(400).json({ error: 'The message you are replying to no longer exists' });
      return;
    }
    replyToId = replyTarget.id;
  }

  const kind =
    parsed.data.kind === 'text'
      ? 'TEXT'
      : parsed.data.kind === 'sticker'
        ? 'STICKER'
        : parsed.data.kind === 'video'
          ? 'VIDEO'
          : 'GIF';
  const expiresAt = expiresAtForTtl(activeDisappearingMs(user));

  const message = await prisma.message.create({
    data: {
      coupleId: user.coupleId!,
      senderId: user.id,
      kind,
      body: encryptText(parsed.data.body.trim()),
      replyToId,
      keyVersion: TEXT_ENCRYPTION_KEY_VERSION,
      expiresAt,
    },
  });

  const publicMsg = toMessagePublic(message);
  io?.to(`couple:${user.coupleId}`).emit('message:new', publicMsg);

  void notifyPartnerOfMessage({
    coupleId: user.coupleId!,
    senderId: user.id,
    message: publicMsg,
  }).catch((error) => {
    console.error('[push] Could not notify partner of message', error);
  });

  res.status(201).json({ message: publicMsg });
});

/** Repair legacy media messages that accidentally stored a sender-only device path. */
router.patch('/messages/:id/media', requireAuth, async (req: AuthedRequest, res) => {
  const parsedBody = replaceMediaSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: 'Invalid media id' });
    return;
  }

  const user = await requireCouple(req.userId!);
  if (!user?.coupleId) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }

  const existing = await prisma.message.findFirst({
    where: { id: String(req.params.id), coupleId: user.coupleId },
  });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (existing.senderId !== user.id || (existing.kind !== 'VIDEO' && existing.kind !== 'GIF')) {
    res.status(403).json({ error: 'You can only repair your own media messages' });
    return;
  }

  const parsedMedia = parseChatMediaId(parsedBody.data.mediaId);
  if (!parsedMedia || parsedMedia.coupleId !== user.coupleId || !readDecryptedChatFile(parsedMedia.fileId)) {
    res.status(400).json({ error: 'Uploaded media is not available' });
    return;
  }

  const updated = await prisma.message.update({
    where: { id: existing.id },
    data: {
      body: encryptText(chatMediaApiPath(parsedBody.data.mediaId)),
      keyVersion: TEXT_ENCRYPTION_KEY_VERSION,
    },
  });
  const publicMsg = toMessagePublic(updated);
  io?.to(`couple:${user.coupleId}`).emit('message:updated', publicMsg);
  res.json({ message: publicMsg });
});

/** Partner opened chat — mark your outgoing messages as read and notify via socket. */
router.patch('/messages/:id', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = editMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid message' });
    return;
  }

  const user = await requireCouple(req.userId!);
  if (!user?.coupleId) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }

  const id = String(req.params.id);
  const existing = await prisma.message.findFirst({
    where: { id, coupleId: user.coupleId },
  });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (existing.senderId !== user.id) {
    res.status(403).json({ error: 'You can only edit your own messages' });
    return;
  }
  if (existing.kind !== 'TEXT') {
    res.status(400).json({ error: 'Only text messages can be edited' });
    return;
  }

  const updated = await prisma.message.update({
    where: { id },
    data: { body: encryptText(parsed.data.body), keyVersion: TEXT_ENCRYPTION_KEY_VERSION, isEdited: true },
  });

  const publicMsg = toMessagePublic(updated);
  io?.to(`couple:${user.coupleId}`).emit('message:updated', publicMsg);
  res.json({ message: publicMsg });
});

router.patch('/messages/:id/reaction', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = reactionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid reaction' });
    return;
  }
  const user = await requireCouple(req.userId!);
  if (!user?.coupleId) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }
  const existing = await prisma.message.findFirst({ where: { id: String(req.params.id), coupleId: user.coupleId } });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const updated = await prisma.message.update({
    where: { id: existing.id },
    data: {
      reaction: parsed.data.reaction || null,
      reactionUserId: parsed.data.reaction ? user.id : null,
      reactionUserName: parsed.data.reaction ? user.name : null,
    },
  });
  const publicMsg = toMessagePublic(updated);
  io?.to(`couple:${user.coupleId}`).emit('message:updated', publicMsg);
  res.json({ message: publicMsg });
});

router.delete('/messages/:id', requireAuth, async (req: AuthedRequest, res) => {
  const user = await requireCouple(req.userId!);
  if (!user?.coupleId) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }

  const id = String(req.params.id);
  const existing = await prisma.message.findFirst({
    where: { id, coupleId: user.coupleId },
  });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (existing.senderId !== user.id) {
    res.status(403).json({ error: 'You can only delete your own messages' });
    return;
  }

  const originalBody = decryptText(existing.body);
  let deleteBody = 'this message was deleted';
  if (existing.kind === 'STICKER') {
    deleteBody = 'sticker deleted';
  } else if (existing.kind === 'GIF') {
    const isImage =
      originalBody.includes('/chat/media/') ||
      originalBody.startsWith('file://') ||
      originalBody.startsWith('content://') ||
      originalBody.startsWith('ph://');
    deleteBody = isImage ? 'image deleted' : 'gif deleted';
  } else if (existing.kind === 'VIDEO') {
    deleteBody = 'video deleted';
  }

  const updated = await prisma.message.update({
    where: { id },
    data: {
      isDeleted: true,
      body: encryptText(deleteBody),
      keyVersion: TEXT_ENCRYPTION_KEY_VERSION,
      kind: 'TEXT',
    },
  });

  if (existing.kind === 'GIF' || existing.kind === 'VIDEO') {
    deleteChatMediaFromUrl(originalBody, user.coupleId);
  }

  const publicMsg = toMessagePublic(updated);
  io?.to(`couple:${user.coupleId}`).emit('message:updated', publicMsg);
  res.json({ ok: true, message: publicMsg });
});

router.post('/messages/read', requireAuth, async (req: AuthedRequest, res) => {
  const user = await requireCouple(req.userId!);
  if (!user?.coupleId) {
    res.status(403).json({ error: 'Join a couple to use chat' });
    return;
  }

  const partner = pickPartner(user.couple!.users, user.id);
  if (!partner) {
    res.json({ ok: true, messageIds: [] as string[] });
    return;
  }

  const unread = await prisma.message.findMany({
    where: {
      coupleId: user.coupleId,
      senderId: partner.id,
      readAt: null,
    },
    select: { id: true },
  });

  if (unread.length === 0) {
    res.json({ ok: true, messageIds: [] });
    return;
  }

  const readAt = new Date();
  await prisma.message.updateMany({
    where: {
      coupleId: user.coupleId,
      senderId: partner.id,
      readAt: null,
    },
    data: { readAt },
  });

  const messageIds = unread.map((m) => m.id);
  io?.to(`couple:${user.coupleId}`).emit('messages:read', {
    readerId: user.id,
    messageIds,
    readAt: readAt.toISOString(),
  });

  res.json({ ok: true, messageIds });
});

router.post('/presence', requireAuth, async (req: AuthedRequest, res) => {
  await prisma.user.update({
    where: { id: req.userId! },
    data: { lastSeenAt: new Date() },
  });
  const user = await requireCouple(req.userId!);
  if (user?.coupleId) {
    io?.to(`couple:${user.coupleId}`).emit('presence:update', { userId: user.id, at: new Date().toISOString() });
  }
  res.json({ ok: true });
});

router.patch('/settings', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings' });
    return;
  }

  const { chatDisappearingAfterMs, chatThemeId, partnerPetName } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (chatDisappearingAfterMs !== undefined && user.coupleId) {
    // Human-readable label (handles standard AND custom values)
    let durationText: string;
    if (chatDisappearingAfterMs === null) {
      durationText = 'Off';
    } else if (chatDisappearingAfterMs === 24 * 60 * 60 * 1000) {
      durationText = '24 hours';
    } else if (chatDisappearingAfterMs === 7 * 24 * 60 * 60 * 1000) {
      durationText = '7 days';
    } else if (chatDisappearingAfterMs === 30 * 24 * 60 * 60 * 1000) {
      durationText = '30 days';
    } else {
      // Custom value — humanize it
      const totalSeconds = Math.floor(chatDisappearingAfterMs / 1000);
      const totalMinutes = Math.floor(totalSeconds / 60);
      const totalHours = Math.floor(totalMinutes / 60);
      const totalDays = Math.floor(totalHours / 24);
      if (totalDays > 0 && totalHours % 24 === 0) durationText = `${totalDays} day${totalDays > 1 ? 's' : ''}`;
      else if (totalHours > 0 && totalMinutes % 60 === 0) durationText = `${totalHours} hour${totalHours > 1 ? 's' : ''}`;
      else if (totalMinutes > 0 && totalSeconds % 60 === 0) durationText = `${totalMinutes} minute${totalMinutes > 1 ? 's' : ''}`;
      else durationText = `${totalSeconds} second${totalSeconds > 1 ? 's' : ''}`;
    }

    // Create system log message
    const sysMessage = await prisma.message.create({
      data: {
        coupleId: user.coupleId,
        senderId: user.id,
        kind: 'SYSTEM',
        body: encryptText(`${user.name} set disappearing messages to ${durationText}`),
        keyVersion: TEXT_ENCRYPTION_KEY_VERSION,
        expiresAt: null,
      },
    });

    const publicMsg = toMessagePublic(sysMessage);
    io?.to(`couple:${user.coupleId}`).emit('message:new', publicMsg);
    io?.to(`couple:${user.coupleId}`).emit('profile:updated', {
      userId: user.id,
    });
  }

  const updated = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      ...(chatDisappearingAfterMs !== undefined ? { chatDisappearingAfterMs } : {}),
      ...(chatThemeId ? { chatThemeId } : {}),
      ...(partnerPetName ? { partnerPetName } : {}),
    },
    include: userInclude,
  });

  res.json({ user: await toUserPublic(updated) });
});

router.get('/partner-status', requireAuth, async (req: AuthedRequest, res) => {
  const user = await requireCouple(req.userId!);
  if (!user) {
    res.json({ online: false });
    return;
  }
  const partner = pickPartner(user.couple!.users, user.id);
  res.json({ online: isPartnerOnline(partner?.lastSeenAt) });
});

export default router;
