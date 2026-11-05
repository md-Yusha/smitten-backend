import type { Couple, Subscription, User } from '@prisma/client';
import { isPartnerOnline, pickPartner } from './messageDto.js';

function isSubscriptionActive(sub: Subscription | null | undefined, now = new Date()): boolean {
  return sub?.status === 'ACTIVE' && Boolean(sub.expiresAt && sub.expiresAt > now);
}

function planToPublic(plan: Subscription['plan'] | null | undefined): 'monthly' | 'quarterly' | 'yearly' | null {
  if (plan === 'YEARLY') return 'yearly';
  if (plan === 'QUARTERLY') return 'quarterly';
  if (plan === 'MONTHLY' || plan === 'WEEKLY') return 'monthly';
  return null;
}

export type UserPublic = {
  id: string;
  email: string;
  name: string;
  lastName: string | null;
  phoneNumber: string | null;
  city: string | null;
  dateOfBirth: string | null;
  partnerKnownSince: string | null;
  partnerPetName: string | null;
  nicknameSelf: string | null;
  gender: 'male' | 'female' | 'other';
  genderIdentity: string | null;
  profileSetupComplete: boolean;
  isCoupleOwner: boolean;
  coupleId: string | null;
  inviteCode: string | null;
  coupleStatus: 'pending_partner' | 'active' | null;
  hasActiveSubscription: boolean;
  /** True if anyone in the couple has an active subscription (for partner UI). */
  coupleHasActiveSubscription: boolean;
  subscriptionPlan: 'monthly' | 'quarterly' | 'yearly' | null;
  subscriptionExpiresAt: string | null;
  /** Owner's plan when the couple is subscribed (visible to both partners). */
  coupleSubscriptionPlan: 'monthly' | 'quarterly' | 'yearly' | null;
  coupleSubscriptionExpiresAt: string | null;
  partner: {
    id: string;
    name: string;
    dateOfBirth: string | null;
    partnerKnownSince: string | null;
    nicknameSelf: string | null;
    gender: 'male' | 'female' | 'other';
    avatarUrl: string | null;
    mood: string | null;
  } | null;
  coupleCreatedAt: string | null;
  memberSince: string;
  chatDisappearingAfterMs: number | null;
  chatThemeId: string;
  vaultDisappearingAfterMs: number | null;
  partnerOnline: boolean;
  avatarUrl: string | null;
  mood: string | null;
};

function mapGender(g: User['gender']): 'male' | 'female' | 'other' {
  if (g === 'BOY') return 'male';
  if (g === 'GIRL') return 'female';
  return 'other';
}

export async function toUserPublic(
  user: User & { couple?: (Couple & { users?: User[] }) | null; subscription?: Subscription | null },
): Promise<UserPublic> {
  let partner: UserPublic['partner'] = null;

  if (user.couple?.users?.length) {
    const other = user.couple.users.find((u) => u.id !== user.id);
    if (other) {
      partner = {
        id: other.id,
        name: other.name,
        dateOfBirth: other.dateOfBirth?.toISOString() ?? null,
        partnerKnownSince: other.partnerKnownSince?.toISOString() ?? null,
        nicknameSelf: other.nicknameSelf?.trim() || null,
        gender: mapGender(other.gender),
        avatarUrl: other.avatarUrl ?? null,
        mood: other.mood ?? null,
      };
    }
  }

  const now = new Date();
  const subActive = isSubscriptionActive(user.subscription, now);
  type UserWithSub = User & { subscription?: Subscription | null };
  const coupleUsers = (user.couple?.users ?? []) as UserWithSub[];
  const owner = coupleUsers.find((u) => u.isCoupleOwner);
  const ownerSub = owner?.subscription ?? null;
  const coupleSubActive = coupleUsers.some((u) => isSubscriptionActive(u.subscription, now));
  const couplePlan = isSubscriptionActive(ownerSub, now) ? planToPublic(ownerSub?.plan) : null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    lastName: user.lastName?.trim() || null,
    phoneNumber: user.phoneNumber?.trim() || null,
    city: user.city?.trim() || null,
    dateOfBirth: user.dateOfBirth?.toISOString() ?? null,
    partnerKnownSince: user.partnerKnownSince?.toISOString() ?? null,
    partnerPetName: user.partnerPetName?.trim() || null,
    nicknameSelf: user.nicknameSelf?.trim() || null,
    gender: mapGender(user.gender),
    genderIdentity: user.genderIdentity?.trim() || null,
    profileSetupComplete: Boolean(
      user.city?.trim() && user.dateOfBirth && user.partnerKnownSince,
    ),
    isCoupleOwner: user.isCoupleOwner,
    coupleId: user.coupleId,
    inviteCode: user.isCoupleOwner ? user.couple?.inviteCode ?? null : null,
    coupleStatus: user.couple
      ? user.couple.status === 'ACTIVE'
        ? 'active'
        : 'pending_partner'
      : null,
    hasActiveSubscription: Boolean(subActive),
    coupleHasActiveSubscription: coupleSubActive,
    subscriptionPlan: subActive ? planToPublic(user.subscription?.plan) : null,
    coupleSubscriptionPlan: couplePlan,
    subscriptionExpiresAt: subActive ? user.subscription?.expiresAt?.toISOString() ?? null : null,
    coupleSubscriptionExpiresAt: isSubscriptionActive(ownerSub, now) ? ownerSub?.expiresAt?.toISOString() ?? null : null,
    partner,
    coupleCreatedAt: user.couple?.createdAt?.toISOString() ?? null,
    memberSince: user.createdAt.toISOString(),
    chatDisappearingAfterMs: user.chatDisappearingAfterMs ?? null,
    chatThemeId: user.chatThemeId ?? 'cream',
    vaultDisappearingAfterMs: user.vaultDisappearingAfterMs ?? null,
    partnerOnline: user.couple?.users
      ? isPartnerOnline(pickPartner(user.couple.users, user.id)?.lastSeenAt)
      : false,
    avatarUrl: user.avatarUrl ?? null,
    mood: user.mood ?? null,
  };
}

export const userInclude = {
  couple: { include: { users: { include: { subscription: true } } } },
  subscription: true,
} as const;
