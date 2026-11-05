import { prisma } from '../lib/prisma.js';
import type { MessagePublic } from '../lib/messageDto.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound?: 'default' | null;
  data?: Record<string, string>;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
};

type PushRecipient = {
  id: string;
  expoPushToken: string | null;
  expoPushTokens: string[];
  pushNotificationsEnabled: boolean;
  notificationChatEnabled?: boolean | null;
  notificationBuzzEnabled?: boolean | null;
  notificationMemoryEnabled?: boolean | null;
  notificationDiaryEnabled?: boolean | null;
  notificationGamesEnabled?: boolean | null;
};

type PushCategory = 'chat' | 'buzz' | 'memories' | 'diary' | 'games' | 'account';

function formatMessageBody(message: MessagePublic): string {
  if (message.kind === 'sticker') return 'Sent a sticker 💕';
  if (message.kind === 'gif') return 'Sent a GIF';
  if (message.kind === 'video') return 'Sent a video';
  return 'New message';
}

export async function sendExpoPush(message: ExpoPushMessage): Promise<void> {
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[push] Expo API error', res.status, text.slice(0, 200));
      return;
    }
    const json = (await res.json()) as { data?: { status?: string; id?: string; details?: { error?: string } }[] };
    console.log(`[push] Sent to ${message.to}. Title: "${message.title}". Response:`, JSON.stringify(json));
    const ticket = json.data?.[0];
    if (ticket?.status === 'error') {
      console.warn('[push] ticket error', ticket.details?.error);
      if (ticket.details?.error === 'DeviceNotRegistered') {
        console.log(`[push] DeviceNotRegistered for token ${message.to}. Clearing token.`);
        await removeDeadPushToken(message.to);
      }
    }
  } catch (e) {
    console.warn('[push] send failed', e);
  }
}

function pushTokensFor(recipient: PushRecipient): string[] {
  return Array.from(new Set([recipient.expoPushToken, ...(recipient.expoPushTokens ?? [])].filter(Boolean) as string[]));
}

async function sendToRecipient(
  recipient: PushRecipient,
  message: Omit<ExpoPushMessage, 'to'>,
): Promise<void> {
  const tokens = pushTokensFor(recipient);
  await Promise.all(tokens.map((to) => sendExpoPush({ ...message, to })));
}

async function removeDeadPushToken(token: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { OR: [{ expoPushToken: token }, { expoPushTokens: { has: token } }] },
    select: { id: true, expoPushToken: true, expoPushTokens: true },
  });
  await Promise.all(
    users.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: {
          expoPushToken: user.expoPushToken === token ? null : user.expoPushToken,
          expoPushTokens: { set: user.expoPushTokens.filter((stored) => stored !== token) },
        },
      }),
    ),
  );
}

async function getRecipientAndSender(coupleId: string, senderId: string) {
  const users = await prisma.user.findMany({
    where: { coupleId },
    select: {
      id: true,
      name: true,
      partnerPetName: true,
      expoPushToken: true,
      expoPushTokens: true,
      pushNotificationsEnabled: true,
      notificationChatEnabled: true,
      notificationBuzzEnabled: true,
      notificationMemoryEnabled: true,
      notificationDiaryEnabled: true,
      notificationGamesEnabled: true,
    },
  });
  const recipient = users.find((u) => u.id !== senderId);
  const sender = users.find((u) => u.id === senderId);
  return { recipient, sender };
}

async function shouldSendPush(
  recipient: PushRecipient | undefined,
  category: PushCategory = 'account',
): Promise<boolean> {
  if (!recipient || !recipient.pushNotificationsEnabled || pushTokensFor(recipient).length === 0) return false;
  if (category === 'chat' && recipient.notificationChatEnabled === false) return false;
  if (category === 'buzz' && recipient.notificationBuzzEnabled === false) return false;
  if (category === 'memories' && recipient.notificationMemoryEnabled === false) return false;
  if (category === 'diary' && recipient.notificationDiaryEnabled === false) return false;
  if (category === 'games' && recipient.notificationGamesEnabled === false) return false;
  return true;
}

export async function notifyPartnerOfMessage(params: {
  coupleId: string;
  senderId: string;
  message: MessagePublic;
}): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(params.coupleId, params.senderId);
  if (!(await shouldSendPush(recipient, 'chat'))) return;

  const title = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';
  const body = formatMessageBody(params.message);

  await sendToRecipient(recipient!, {
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'messages',
    data: {
      type: 'chat_message',
      coupleId: params.coupleId,
      messageId: params.message.id,
    },
  });
}

export async function notifyPartnerOfGameInvite(coupleId: string, senderId: string, gameType: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'games'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';
  const gameName = gameType === 'love-challenge' ? 'Love Challenge' : 'Tic-Tac-Toe';
  
  await sendToRecipient(recipient!, {
    title: 'Game Invite! 🎮',
    body: `${senderName} is inviting you to play ${gameName}! Ready to join?`,
    sound: 'default',
    priority: 'high',
    channelId: 'games',
    data: {
      type: 'game_invite',
      coupleId,
      gameType,
    },
  });
}

export async function notifyPartnerOfLovePing(
  coupleId: string,
  senderId: string,
  kind: string,
  ping?: { id: string; senderName: string; createdAt: Date },
): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'buzz'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';
  const buzzLabels: Record<string, { label: string; emoji: string }> = {
    love: { label: 'Love', emoji: '❤️' },
    kiss: { label: 'Kiss', emoji: '💋' },
    sorry: { label: 'Sorry', emoji: '🥺' },
    anger: { label: 'Anger', emoji: '💢' },
    hug: { label: 'Hug', emoji: '🤗' },
    please: { label: 'Please', emoji: '🥺' },
    love_heart: { label: 'Love', emoji: '❤️' },
    love_kiss: { label: 'Kiss', emoji: '💋' },
    love_cuddle: { label: 'Hug', emoji: '🤗' },
    anger_mad: { label: 'Anger', emoji: '💢' },
    anger_hate: { label: 'Anger', emoji: '💢' },
    please_beg: { label: 'Please', emoji: '🥺' },
  };
  const buzz = buzzLabels[kind] ?? { label: 'Buzz', emoji: '❤️' };

  await sendToRecipient(recipient!, {
    title: 'Buzz! 📳',
    body: `${senderName} sent you a buzz: ${buzz.label} ${buzz.emoji}`,
    sound: 'default',
    priority: 'high',
    channelId: 'buzz',
    data: {
      type: 'love_ping',
      coupleId,
      kind,
      ...(ping
        ? {
            pingId: ping.id,
            senderId,
            senderName: ping.senderName,
            createdAt: ping.createdAt.toISOString(),
          }
        : {}),
    },
  });
}

export async function notifyPartnerOfChallenge(coupleId: string, senderId: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'games'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';

  await sendToRecipient(recipient!, {
    title: 'New Quiz! 🧠',
    body: `${senderName} created a new quiz challenge for you. Check it out!`,
    sound: 'default',
    priority: 'high',
    channelId: 'games',
    data: {
      type: 'game_challenge',
      coupleId,
    },
  });
}

export async function notifyPartnerOfChallengeAnswer(coupleId: string, senderId: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'games'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';

  await sendToRecipient(recipient!, {
    title: 'Quiz Answered! 🎯',
    body: `${senderName} just answered your quiz! See how they did.`,
    sound: 'default',
    priority: 'high',
    channelId: 'games',
    data: {
      type: 'game_challenge_answered',
      coupleId,
    },
  });
}

export async function notifyPartnerOfGameMove(
  coupleId: string, 
  senderId: string, 
  gameType: string, 
  isFinished: boolean, 
  winnerId?: string | null
): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'games'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';
  const gameName = gameType === 'tictactoe' ? 'Tic-Tac-Toe' : 'Game';

  let body = '';
  let title = 'Your Turn! ⏱️';
  if (isFinished) {
    title = 'Game Over! 🏁';
    if (winnerId === senderId) {
      body = `${senderName} won the match of ${gameName}! Better luck next time!`;
    } else if (winnerId === recipient!.id) {
      body = `You won the match of ${gameName} against ${senderName}! 🎉`;
    } else {
      body = `The match of ${gameName} ended in a draw! 🤝`;
    }
  } else {
    body = `${senderName} made a move in ${gameName}. It's your turn!`;
  }

  await sendToRecipient(recipient!, {
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'games',
    data: {
      type: 'game_move',
      coupleId,
      gameType,
    },
  });
}

// ── New notification functions for content updates ──

export async function notifyPartnerOfNote(coupleId: string, senderId: string, noteTitle: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'diary'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';

  await sendToRecipient(recipient!, {
    title: 'New Note 📝',
    body: `${senderName} added a private note.`,
    sound: 'default',
    priority: 'high',
    channelId: 'updates',
    data: {
      type: 'note_created',
      coupleId,
    },
  });
}

export async function notifyPartnerOfMemory(coupleId: string, senderId: string, memoryTitle: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'memories'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';

  await sendToRecipient(recipient!, {
    title: 'New Memory 📸',
    body: `${senderName} saved a private memory.`,
    sound: 'default',
    priority: 'high',
    channelId: 'updates',
    data: {
      type: 'memory_created',
      coupleId,
    },
  });
}

export async function notifyPartnerOfVaultImage(coupleId: string, senderId: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'memories'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';

  await sendToRecipient(recipient!, {
    title: 'Vault image shared',
    body: `${senderName} shared a temporary vault image with you.`,
    sound: 'default',
    priority: 'high',
    channelId: 'updates',
    data: {
      type: 'vault_shared',
      coupleId,
    },
  });
}

export async function notifyPartnerOfSpecialMoment(coupleId: string, senderId: string, momentTitle: string): Promise<void> {
  const { recipient, sender } = await getRecipientAndSender(coupleId, senderId);
  if (!(await shouldSendPush(recipient, 'memories'))) return;

  const senderName = recipient!.partnerPetName?.trim() || sender?.name || 'Your partner';

  await sendToRecipient(recipient!, {
    title: 'Special Moment ✨',
    body: `${senderName} marked a private special moment.`,
    sound: 'default',
    priority: 'high',
    channelId: 'updates',
    data: {
      type: 'special_moment',
      coupleId,
    },
  });
}

export async function notifyPartnerOfCoupleJoin(coupleId: string, joinedUserId: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { coupleId },
    select: {
      id: true,
      name: true,
      expoPushToken: true,
      expoPushTokens: true,
      pushNotificationsEnabled: true,
    },
  });
  // Notify the owner (the one who did NOT just join)
  const owner = users.find((u) => u.id !== joinedUserId);
  const joiner = users.find((u) => u.id === joinedUserId);
  if (!owner || !(await shouldSendPush(owner))) return;

  const joinerName = joiner?.name || 'Your partner';

  await sendToRecipient(owner, {
    title: 'Partner Joined! 💕',
    body: `${joinerName} just joined your couple — your Smittenz journey begins!`,
    sound: 'default',
    priority: 'high',
    channelId: 'updates',
    data: {
      type: 'partner_joined',
      coupleId,
    },
  });
}

export async function notifyCoupleOfSubscriptionExpired(params: {
  coupleId: string | null;
  ownerId: string;
}): Promise<void> {
  const users = await prisma.user.findMany({
    where: params.coupleId ? { coupleId: params.coupleId } : { id: params.ownerId },
    select: {
      id: true,
      expoPushToken: true,
      expoPushTokens: true,
      pushNotificationsEnabled: true,
    },
  });

  await Promise.all(
    users.map(async (user) => {
      if (!(await shouldSendPush(user))) return;
      const owner = user.id === params.ownerId;
      await sendToRecipient(user, {
        title: 'Subscription expired',
        body: owner
          ? 'Renew your Smittenz subscription to unlock your private space again.'
          : 'Your private space is locked until the couple owner renews the subscription.',
        sound: 'default',
        priority: 'high',
        channelId: 'updates',
        data: {
          type: 'subscription_expired',
          ...(params.coupleId ? { coupleId: params.coupleId } : {}),
        },
      });
    }),
  );
}

export async function notifySubscriptionExpiringSoon(params: {
  owner: PushRecipient;
  daysLeft: number;
  expiresAt: Date;
}): Promise<boolean> {
  if (!(await shouldSendPush(params.owner))) return false;
  const dayLabel = params.daysLeft === 1 ? '1 day' : `${params.daysLeft} days`;
  await sendToRecipient(params.owner, {
    title: 'Subscription ending soon',
    body: `Your Smittenz plan expires in ${dayLabel}. Renew now to keep your private space going.`,
    sound: 'default',
    priority: 'high',
    channelId: 'updates',
    data: {
      type: 'subscription_renewal_reminder',
      expiresAt: params.expiresAt.toISOString(),
    },
  });
  return true;
}
