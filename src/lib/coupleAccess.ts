import { prisma } from './prisma.js';

export async function requireCoupleMembership(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { couple: { include: { users: { include: { subscription: true } } } } },
  });
  if (!user?.coupleId || !user.couple) {
    return null;
  }
  const now = new Date();
  const subscribed = user.couple.users.some(
    (u) =>
      u.subscription?.status === 'ACTIVE' &&
      Boolean(u.subscription.expiresAt && u.subscription.expiresAt > now),
  );
  if (!subscribed) return null;
  return user.coupleId;
}
