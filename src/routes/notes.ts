import { Router } from 'express';
import { z } from 'zod';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { requireCoupleMembership } from '../lib/coupleAccess.js';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyPartnerOfNote } from '../services/pushNotifications.js';

const createSchema = z.object({
  title: z.string().min(1).max(120).transform((s) => s.trim()),
  description: z.string().max(5000).optional(),
  visibility: z.enum(['SHARED', 'PRIVATE']).default('SHARED'),
  noteAt: z.string().min(8).max(32),
});

const patchSchema = z
  .object({
    title: z.string().min(1).max(120).transform((s) => s.trim()).optional(),
    description: z.string().max(5000).optional(),
    visibility: z.enum(['SHARED', 'PRIVATE']).optional(),
    noteAt: z.string().min(8).max(32).optional(),
  })
  .refine((d) => d.title !== undefined || d.description !== undefined || d.visibility !== undefined || d.noteAt !== undefined, {
    message: 'Nothing to update',
  });

const router = Router();

function parseNoteAt(raw: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date(raw);
}

function notifyNotes(coupleId: string) {
  emitCoupleEvent(coupleId, 'content:updated', { kind: 'note' });
}

function noteToPublic(n: {
  id: string;
  title: string;
  description: string;
  visibility: string | null;
  noteAt: Date;
  creatorId: string;
  creator: { name: string };
  createdAt: Date;
}, viewerId?: string) {
  return {
    id: n.id,
    title: n.title,
    description: n.description,
    visibility: n.visibility === 'PRIVATE' ? 'PRIVATE' : 'SHARED',
    noteAt: n.noteAt.toISOString(),
    creatorId: n.creatorId,
    creatorName: n.creator.name,
    canManage: n.creatorId === viewerId,
    createdAt: n.createdAt.toISOString(),
  };
}

router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use notes' });
    return;
  }

  const rows = await prisma.note.findMany({
    where: {
      coupleId,
      OR: [
        { creatorId: req.userId! },
        { visibility: 'SHARED' },
        { visibility: null },
      ],
    },
    orderBy: { noteAt: 'desc' },
    include: { creator: { select: { id: true, name: true } } },
  });

  res.json({
    notes: rows.map((row) => noteToPublic(row, req.userId!)),
  });
});

router.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use notes' });
    return;
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid note' });
    return;
  }

  const { title, description, visibility } = parsed.data;
  const noteAt = parseNoteAt(parsed.data.noteAt);

  const row = await prisma.note.create({
    data: {
      coupleId,
      creatorId: req.userId!,
      title,
      description: description?.trim() ?? '',
      visibility,
      noteAt,
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  notifyNotes(coupleId);
  if (visibility === 'SHARED') {
    void notifyPartnerOfNote(coupleId, req.userId!, parsed.data.title).catch(() => {});
  }
  res.status(201).json({
    note: noteToPublic(row, req.userId!),
  });
});

router.patch('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use notes' });
    return;
  }

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }

  const id = String(req.params.id);
  const existing = await prisma.note.findFirst({ where: { id, coupleId } });
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (existing.creatorId !== req.userId!) {
    res.status(403).json({ error: 'Only the author can edit this diary entry' });
    return;
  }
  const { title, description, visibility, noteAt: noteAtRaw } = parsed.data;
  const row = await prisma.note.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description: description?.trim() ?? '' } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(noteAtRaw !== undefined ? { noteAt: parseNoteAt(noteAtRaw) } : {}),
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  notifyNotes(coupleId);
  res.json({
    note: noteToPublic(row, req.userId!),
  });
});

router.delete('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const coupleId = await requireCoupleMembership(req.userId!);
  if (!coupleId) {
    res.status(403).json({ error: 'Join a couple to use notes' });
    return;
  }

  const id = String(req.params.id);
  const row = await prisma.note.findFirst({ where: { id, coupleId } });
  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (row.creatorId !== req.userId!) {
    res.status(403).json({ error: 'Only the author can delete this diary entry' });
    return;
  }
  await prisma.note.delete({ where: { id } });
  notifyNotes(coupleId);
  res.json({ ok: true });
});

export default router;
