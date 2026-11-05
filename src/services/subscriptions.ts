import type { Subscription } from '@prisma/client';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { prisma } from '../lib/prisma.js';
import { notifyCoupleOfSubscriptionExpired, notifySubscriptionExpiringSoon } from './pushNotifications.js';

type ExpirableSubscription = Subscription & {
  user: {
    id: string;
    coupleId: string | null;
  };
};

let running = false;

async function expireSubscriptions(subscriptions: ExpirableSubscription[], now: Date): Promise<number> {
  let expired = 0;

  for (const subscription of subscriptions) {
    const result = await prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        status: 'ACTIVE',
        expiresAt: { lte: now },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    if (result.count !== 1) continue;
    expired += 1;

    if (subscription.user.coupleId) {
      emitCoupleEvent(subscription.user.coupleId, 'couple:updated', {
        reason: 'subscription_expired',
      });
    }

    void notifyCoupleOfSubscriptionExpired({
      coupleId: subscription.user.coupleId,
      ownerId: subscription.user.id,
    }).catch((err) => {
      console.warn('[subscriptions] expiry push failed', err);
    });
  }

  if (expired > 0) {
    console.log(`[subscriptions] Marked ${expired} subscription(s) as expired`);
  }

  return expired;
}

export async function expireDueSubscriptions(now = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lte: now },
    },
    include: {
      user: {
        select: {
          id: true,
          coupleId: true,
        },
      },
    },
  });

  return expireSubscriptions(due as ExpirableSubscription[], now);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysUntil(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

export async function sendSubscriptionRenewalReminders(now = new Date()): Promise<number> {
  const today = dateKey(now);
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const due = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { gt: now, lte: weekFromNow },
      OR: [{ lastExpiryReminderDate: null }, { lastExpiryReminderDate: { not: today } }],
    },
    include: {
      user: {
        select: {
          id: true,
          expoPushToken: true,
          expoPushTokens: true,
          pushNotificationsEnabled: true,
        },
      },
    },
  });

  let sent = 0;
  for (const subscription of due) {
    if (!subscription.expiresAt) continue;
    const didSend = await notifySubscriptionExpiringSoon({
      owner: subscription.user,
      daysLeft: daysUntil(subscription.expiresAt, now),
      expiresAt: subscription.expiresAt,
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { lastExpiryReminderDate: today },
    });
    if (didSend) sent += 1;
  }

  if (sent > 0) {
    console.log(`[subscriptions] Sent ${sent} renewal reminder(s)`);
  }
  return sent;
}

export async function confirmSubscriptionStatusForUser(userId: string, now = new Date()): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscription: true,
        couple: {
          include: {
            users: {
              include: {
                subscription: true,
              },
            },
          },
        },
      },
    });

    if (!user) return 0;

    const subscriptions = new Map<string, ExpirableSubscription>();
    const addIfExpired = (
      subscription: Subscription | null | undefined,
      owner: { id: string; coupleId: string | null },
    ) => {
      if (
        subscription?.status === 'ACTIVE' &&
        subscription.expiresAt &&
        subscription.expiresAt <= now
      ) {
        subscriptions.set(subscription.id, {
          ...subscription,
          user: owner,
        });
      }
    };

    addIfExpired(user.subscription, { id: user.id, coupleId: user.coupleId });

    const coupleOwner = user.couple?.users.find((u) => u.isCoupleOwner);
    if (coupleOwner) {
      addIfExpired(coupleOwner.subscription, {
        id: coupleOwner.id,
        coupleId: coupleOwner.coupleId,
      });
    }

    return expireSubscriptions([...subscriptions.values()], now);
  } catch (err) {
    console.error('[subscriptions] status confirmation failed', err);
    return 0;
  } finally {
    running = false;
  }
}
