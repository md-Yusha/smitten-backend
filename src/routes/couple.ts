import { Router } from 'express';
import { z } from 'zod';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { prisma } from '../lib/prisma.js';
import { toUserPublic, userInclude } from '../lib/userDto.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyPartnerOfLovePing, notifyPartnerOfCoupleJoin } from '../services/pushNotifications.js';
import { config } from '../config.js';
import { sendPartnerWelcomeEmail } from '../services/mail.js';

const router = Router();

const petNameSchema = z.string().min(1).max(40).transform((s) => s.trim());

const joinSchema = z.object({
  inviteCode: z.string().min(6).max(12).transform((s) => s.trim().toUpperCase()),
  name: z.string().min(1).max(80).transform((s) => s.trim()).optional(),
  partnerPetName: petNameSchema.optional(),
});

const inviteCodeSchema = z.object({
  inviteCode: z.string().min(6).max(12).transform((s) => s.trim().toUpperCase()),
});

async function deleteCoupleScopedData(coupleId: string) {
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { coupleId } }),
    prisma.vaultItem.deleteMany({ where: { coupleId } }),
    prisma.memory.deleteMany({ where: { coupleId } }),
    prisma.note.deleteMany({ where: { coupleId } }),
    prisma.specialMoment.deleteMany({ where: { coupleId } }),
    prisma.lovePing.deleteMany({ where: { coupleId } }),
    prisma.loveChallenge.deleteMany({ where: { coupleId } }),
    prisma.ticTacToe.deleteMany({ where: { coupleId } }),
  ]);
}

router.post('/validate-key', async (req, res) => {
  const parsed = inviteCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid invite code format' });
    return;
  }

  const couple = await prisma.couple.findUnique({
    where: { inviteCode: parsed.data.inviteCode },
    include: { users: { include: { subscription: true } } },
  });

  if (!couple) {
    res.status(404).json({ error: 'Invalid invite code', valid: false });
    return;
  }

  const partnerSlotTaken = couple.users.some((u) => !u.isCoupleOwner);
  if (partnerSlotTaken || couple.status === 'ACTIVE') {
    res.status(409).json({ error: 'This couple key is already in use', valid: false });
    return;
  }

  const owner = couple.users.find((u) => u.isCoupleOwner);
  if (!owner?.partnerKnownSince) {
    res.status(409).json({ error: 'The key owner needs to complete their story first', valid: false });
    return;
  }
  const ownerSubscribed =
    owner?.subscription?.status === 'ACTIVE' &&
    Boolean(owner.subscription.expiresAt && owner.subscription.expiresAt > new Date());
  if (!ownerSubscribed) {
    res.status(402).json({ error: 'This couple key needs an active subscription', valid: false });
    return;
  }
  res.json({
    valid: true,
    ownerName: owner?.name ?? 'Your partner',
    partnerKnownSince: owner?.partnerKnownSince?.toISOString() ?? null,
    reserved: Boolean(couple.reservedPartnerEmail),
  });
});

router.post('/join', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid invite code or profile' });
    return;
  }

  const userId = req.userId!;
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const couple = await prisma.couple.findUnique({
    where: { inviteCode: parsed.data.inviteCode },
    include: { users: { include: { subscription: true } } },
  });

  if (!couple) {
    res.status(404).json({ error: 'Invalid invite code' });
    return;
  }

  if (user.coupleId) {
    if (user.coupleId === couple.id) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        include: userInclude,
      });
      if (!current) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: await toUserPublic(current) });
      return;
    }
    res.status(400).json({ error: 'You are already linked to a couple' });
    return;
  }

  if (user.isCoupleOwner) {
    res.status(400).json({ error: 'Key owners should share their own key, not join with one' });
    return;
  }

  const reservedPartnerEmail = couple.reservedPartnerEmail?.toLowerCase().trim() || null;
  if (reservedPartnerEmail && user.email.toLowerCase().trim() !== reservedPartnerEmail) {
    res.status(403).json({ error: 'This couple key is reserved for the original partner email' });
    return;
  }

  const hasPartner = couple.users.some((u) => !u.isCoupleOwner);
  if (hasPartner) {
    res.status(409).json({ error: 'This couple key is already in use' });
    return;
  }
  const owner = couple.users.find((u) => u.isCoupleOwner);
  if (!owner?.partnerKnownSince) {
    res.status(409).json({ error: 'The key owner needs to complete their story first' });
    return;
  }
  const ownerSubscribed =
    owner.subscription?.status === 'ACTIVE' &&
    Boolean(owner.subscription.expiresAt && owner.subscription.expiresAt > new Date());
  if (!ownerSubscribed) {
    res.status(402).json({ error: 'This couple key needs an active subscription' });
    return;
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.couple.update({
      where: { id: couple.id },
      data: { status: 'ACTIVE', reservedPartnerEmail: null },
    });

    const joinedUser = await tx.user.update({
      where: { id: userId },
      data: {
        coupleId: couple.id,
        isCoupleOwner: false,
        partnerKnownSince: owner.partnerKnownSince,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.partnerPetName ? { partnerPetName: parsed.data.partnerPetName } : {}),
      },
      include: userInclude,
    });

    return joinedUser;
  });

  const publicUser = await toUserPublic(updated);
  emitCoupleEvent(couple.id, 'couple:updated', { reason: 'partner_joined' });
  void notifyPartnerOfCoupleJoin(couple.id, userId).catch(() => {});
  void sendPartnerWelcomeEmail(user.email, user.name, owner.name).catch((error) => {
    console.warn('Failed to send partner welcome email', error);
  });
  res.json({ user: publicUser });
});

router.post('/love', requireAuth, async (req: AuthedRequest, res) => {
  if (!req.user?.coupleHasActiveSubscription) {
    res.status(402).json({ error: 'Renew subscription to use Smittenz' });
    return;
  }
  const userId = req.userId!;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { couple: { include: { users: true } } },
  });
  if (!user?.coupleId || !user.couple) {
    res.status(403).json({ error: 'Connect with your partner first' });
    return;
  }
  const hasPartner = user.couple.users.some((u) => u.id !== userId);
  if (!hasPartner) {
    res.status(403).json({ error: 'Connect with your partner first' });
    return;
  }

  const kind = String(req.body.kind || 'love');

  const ping = await prisma.lovePing.create({
    data: {
      coupleId: user.coupleId,
      senderId: userId,
      kind,
    },
    include: { sender: { select: { id: true, name: true } } },
  });

  const payload = {
    id: ping.id,
    senderId: ping.senderId,
    senderName: ping.sender.name,
    kind: ping.kind,
    createdAt: ping.createdAt.toISOString(),
  };
  emitCoupleEvent(user.coupleId, 'love:sent', payload);
  void notifyPartnerOfLovePing(user.coupleId, userId, kind, {
    id: ping.id,
    senderName: ping.sender.name,
    createdAt: ping.createdAt,
  }).catch(() => {});
  res.status(201).json({ love: payload });
});

router.get('/love/pending', requireAuth, async (req: AuthedRequest, res) => {
  if (!req.user?.coupleHasActiveSubscription) {
    res.json({ loves: [] });
    return;
  }
  const userId = req.userId!;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.coupleId) {
    res.json({ loves: [] });
    return;
  }

  const rows = await prisma.lovePing.findMany({
    where: {
      coupleId: user.coupleId,
      senderId: { not: userId },
      readAt: null,
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    include: { sender: { select: { id: true, name: true } } },
  });

  res.json({
    loves: rows.map((r) => ({
      id: r.id,
      senderId: r.senderId,
      senderName: r.sender.name,
      kind: r.kind,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.get('/love/history', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.coupleId) {
    res.json({ loves: [] });
    return;
  }

  const rows = await prisma.lovePing.findMany({
    where: { coupleId: user.coupleId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { sender: { select: { id: true, name: true } } },
  });

  res.json({
    loves: rows.map((row) => ({
      id: row.id,
      senderId: row.senderId,
      senderName: row.sender.name,
      kind: row.kind,
      createdAt: row.createdAt.toISOString(),
      direction: row.senderId === userId ? 'sent' : 'received',
    })),
  });
});

router.post('/love/:id/read', requireAuth, async (req: AuthedRequest, res) => {
  if (!req.user?.coupleHasActiveSubscription) {
    res.status(402).json({ error: 'Renew subscription to use Smittenz' });
    return;
  }
  const userId = req.userId!;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.coupleId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const id = String(req.params.id);
  const ping = await prisma.lovePing.findFirst({
    where: { id, coupleId: user.coupleId, senderId: { not: userId } },
  });
  if (!ping) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  await prisma.lovePing.update({
    where: { id: ping.id },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

router.post('/reset-for-new-partner', requireAuth, async (req: AuthedRequest, res) => {
  const owner = await prisma.user.findUnique({
    where: { id: req.userId! },
    include: { couple: { include: { users: true } } },
  });
  if (!owner?.isCoupleOwner || !owner.couple) {
    res.status(403).json({ error: 'Only the couple owner can reset for a new partner' });
    return;
  }
  const partner = owner.couple.users.find((user) => user.id !== owner.id);
  if (partner) {
    res.status(409).json({ error: 'Remove the linked partner before resetting for a new partner' });
    return;
  }

  await deleteCoupleScopedData(owner.couple.id);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.couple.update({
      where: { id: owner.couple!.id },
      data: { status: 'PENDING_PARTNER', reservedPartnerEmail: null },
    });
    return tx.user.update({
      where: { id: owner.id },
      data: { partnerPetName: null, partnerKnownSince: null },
      include: userInclude,
    });
  });

  emitCoupleEvent(owner.couple.id, 'couple:updated', { reason: 'reset_for_new_partner' });
  res.json({ user: await toUserPublic(updated) });
});

router.get('/key', requireAuth, async (req: AuthedRequest, res) => {
  if (!req.user?.isCoupleOwner) {
    res.status(403).json({ error: 'Only the key owner can view the couple key' });
    return;
  }

  if (!req.user.hasActiveSubscription || !req.user.inviteCode) {
    res.status(402).json({ error: 'Complete subscription to receive your couple key' });
    return;
  }

  res.json({ inviteCode: req.user.inviteCode, passkeyRedirectUrl: config.PASSKEY_REDIRECT_URL });
});

export default router;
