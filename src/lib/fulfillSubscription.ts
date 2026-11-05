import type { Plan } from '@prisma/client';
import { prisma } from './prisma.js';
import { generateUniqueInviteCode } from './inviteCode.js';
import { planDurationDays, planEnumToSlug, type PlanSlug } from './planPricing.js';
import { toUserPublic, userInclude } from './userDto.js';
import { sendWelcomeEmail } from '../services/mail.js';

/** Activates subscription and creates the couple after a successful payment. */
export async function fulfillSubscription(userId: string, plan: Plan) {
  const planSlug = planEnumToSlug(plan);
  const now = new Date();

  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, coupleId: true, isCoupleOwner: true, subscription: true },
  });
  if (!existingUser) throw new Error('User not found');
  const isFirstPayment = !existingUser.subscription;

  const startsAt =
    existingUser.subscription?.status === 'ACTIVE' &&
    existingUser.subscription.expiresAt &&
    existingUser.subscription.expiresAt > now
      ? new Date(existingUser.subscription.expiresAt)
      : now;
  const expiresAt = new Date(startsAt);
  expiresAt.setDate(expiresAt.getDate() + planDurationDays(planSlug));

  let coupleId = existingUser.coupleId;
  if (!coupleId) {
    const inviteCode = await generateUniqueInviteCode();
    const couple = await prisma.couple.create({
      data: { inviteCode, status: 'PENDING_PARTNER' },
    });
    coupleId = couple.id;
  }

  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      plan,
      status: 'ACTIVE',
      expiresAt,
    },
    update: {
      plan,
      status: 'ACTIVE',
      expiresAt,
      lastExpiryReminderDate: null,
    },
  });

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      coupleId,
      isCoupleOwner: true,
    },
    include: userInclude,
  });

  if (isFirstPayment) {
    sendWelcomeEmail(existingUser.email, existingUser.name).catch((error) => {
      console.warn('Failed to send first-payment welcome email', error);
    });
  }

  return { inviteCode: user.couple?.inviteCode ?? '', user: await toUserPublic(user) };
}

export function assertOwnerCanPurchase(user: {
  coupleId: string | null;
  isCoupleOwner: boolean;
  subscription?: { status: string; expiresAt: Date | null } | null;
}) {
  if (user.coupleId && !user.isCoupleOwner) {
    throw new Error('Partners cannot purchase a couple key');
  }
}

export type { PlanSlug };
