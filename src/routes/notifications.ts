import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const registerSchema = z.object({
  expoPushToken: z.string().min(1).max(200),
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  chat: z.boolean().optional(),
  buzz: z.boolean().optional(),
  memories: z.boolean().optional(),
  diary: z.boolean().optional(),
  games: z.boolean().optional(),
});

const settingsSelect = {
  pushNotificationsEnabled: true,
  notificationChatEnabled: true,
  notificationBuzzEnabled: true,
  notificationMemoryEnabled: true,
  notificationDiaryEnabled: true,
  notificationGamesEnabled: true,
  expoPushToken: true,
  expoPushTokens: true,
} as const;

function settingsResponse(user: {
  pushNotificationsEnabled: boolean;
  notificationChatEnabled: boolean | null;
  notificationBuzzEnabled: boolean | null;
  notificationMemoryEnabled: boolean | null;
  notificationDiaryEnabled: boolean | null;
  notificationGamesEnabled: boolean | null;
  expoPushToken: string | null;
  expoPushTokens: string[];
}) {
  return {
    enabled: user.pushNotificationsEnabled,
    chat: user.notificationChatEnabled ?? true,
    buzz: user.notificationBuzzEnabled ?? true,
    memories: user.notificationMemoryEnabled ?? true,
    diary: user.notificationDiaryEnabled ?? true,
    games: user.notificationGamesEnabled ?? true,
    registered: Boolean(user.expoPushToken || user.expoPushTokens.length),
  };
}

router.get('/settings', requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: settingsSelect,
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(settingsResponse(user));
});

router.patch('/settings', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings' });
    return;
  }
  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      ...(parsed.data.enabled !== undefined ? { pushNotificationsEnabled: parsed.data.enabled } : {}),
      ...(parsed.data.chat !== undefined ? { notificationChatEnabled: parsed.data.chat } : {}),
      ...(parsed.data.buzz !== undefined ? { notificationBuzzEnabled: parsed.data.buzz } : {}),
      ...(parsed.data.memories !== undefined ? { notificationMemoryEnabled: parsed.data.memories } : {}),
      ...(parsed.data.diary !== undefined ? { notificationDiaryEnabled: parsed.data.diary } : {}),
      ...(parsed.data.games !== undefined ? { notificationGamesEnabled: parsed.data.games } : {}),
    },
    select: settingsSelect,
  });
  res.json(settingsResponse(user));
});

router.post('/register', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid push token' });
    return;
  }
  const token = parsed.data.expoPushToken.trim();
  if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
    res.status(400).json({ error: 'Invalid Expo push token' });
    return;
  }

  const previousUsers = await prisma.user.findMany({
    where: { OR: [{ expoPushToken: token }, { expoPushTokens: { has: token } }], NOT: { id: req.userId! } },
    select: { id: true, expoPushToken: true, expoPushTokens: true },
  });
  await Promise.all(
    previousUsers.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: {
          expoPushToken: user.expoPushToken === token ? null : user.expoPushToken,
          expoPushTokens: { set: user.expoPushTokens.filter((stored) => stored !== token) },
        },
      }),
    ),
  );

  const current = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { expoPushTokens: true },
  });
  const tokens = Array.from(new Set([...(current?.expoPushTokens ?? []), token]));

  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: { expoPushToken: token, expoPushTokens: { set: tokens } },
    select: { pushNotificationsEnabled: true, expoPushToken: true, expoPushTokens: true },
  });

  res.json({
    ok: true,
    enabled: user.pushNotificationsEnabled,
    registered: Boolean(user.expoPushToken || user.expoPushTokens.length),
  });
});

router.delete('/register', requireAuth, async (req: AuthedRequest, res) => {
  await prisma.user.update({
    where: { id: req.userId! },
    data: { expoPushToken: null, expoPushTokens: { set: [] } },
  });
  res.json({ ok: true });
});

export default router;
