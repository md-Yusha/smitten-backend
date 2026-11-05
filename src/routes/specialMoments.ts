import { Router } from 'express';
import { z } from 'zod';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { requireCoupleMembership } from '../lib/coupleAccess.js';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyPartnerOfSpecialMoment } from '../services/pushNotifications.js';

const createSchema = z.object({
  title: z.string().min(1).max(120).transform((s) => s.trim()),
  momentAt: z.string().min(8).max(32),
});

const patchSchema = z
  .object({
    title: z.string().min(1).max(120).transform((s) => s.trim()).optional(),
    momentAt: z.string().min(8).max(32).optional(),
  })
  .refine((d) => d.title !== undefined || d.momentAt !== undefined, {
    message: 'Nothing to update',
  });

const router = Router();

function parseMomentAt(raw: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date(raw);
}

function notifySpecial(coupleId: string) {
  emitCoupleEvent(coupleId, 'content:updated', { kind: 'specialMoment' });
}

function specialMomentToPublic(m: {
  id: string;
  title: string;
  momentAt: Date;
  creatorId: string;
  creator: { name: string };
  createdAt: Date;
}, viewerId?: string) {
  return {
    id: m.id,
    title: m.title,
    momentAt: m.momentAt.toISOString(),
    creatorId: m.creatorId,
    creatorName: m.creator.name,
    canManage: Boolean(viewerId),
    createdAt: m.createdAt.toISOString(),
  };
}

router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple first' });
    return;
  }

  const rows = await prisma.specialMoment.findMany({
    where: { coupleId },
    orderBy: { momentAt: 'asc' },
    include: { creator: { select: { id: true, name: true } } },
  });

  res.json({
    moments: rows.map((row) => specialMomentToPublic(row, req.userId!)),
  });
});

router.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple first' });
    return;
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid special moment' });
    return;
  }

  const momentAt = parseMomentAt(parsed.data.momentAt);
  const row = await prisma.specialMoment.create({
    data: {
      coupleId,
      creatorId: req.userId!,
      title: parsed.data.title,
      momentAt,
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  notifySpecial(coupleId);
  void notifyPartnerOfSpecialMoment(coupleId, req.userId!, parsed.data.title).catch(() => {});
  res.status(201).json({
    moment: specialMomentToPublic(row, req.userId!),
  });
});

router.patch('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple first' });
    return;
  }

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }

  const id = String(req.params.id);
  const existing = await prisma.specialMoment.findFirst({ where: { id, coupleId } });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { title, momentAt: momentAtRaw } = parsed.data;
  const row = await prisma.specialMoment.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(momentAtRaw !== undefined ? { momentAt: parseMomentAt(momentAtRaw) } : {}),
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  notifySpecial(coupleId);
  res.json({
    moment: specialMomentToPublic(row, req.userId!),
  });
});

router.delete('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple first' });
    return;
  }

  const id = String(req.params.id);
  const row = await prisma.specialMoment.findFirst({ where: { id, coupleId } });
  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  await prisma.specialMoment.delete({ where: { id } });
  notifySpecial(coupleId);
  res.json({ ok: true });
});

export default router;
