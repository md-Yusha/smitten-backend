import type { Plan } from '@prisma/client';

export type PlanSlug = 'monthly' | 'quarterly' | 'yearly';

const PLAN_AMOUNTS_PAISE: Record<PlanSlug, number> = {
  monthly: 99 * 100,
  quarterly: 199 * 100,
  yearly: 599 * 100,
};

export function planSlugToEnum(plan: PlanSlug): Plan {
  if (plan === 'yearly') return 'YEARLY';
  return plan === 'quarterly' ? 'QUARTERLY' : 'MONTHLY';
}

export function planEnumToSlug(plan: Plan): PlanSlug {
  if (plan === 'YEARLY') return 'yearly';
  return plan === 'QUARTERLY' ? 'quarterly' : 'monthly';
}

export function planAmountPaise(plan: PlanSlug): number {
  return PLAN_AMOUNTS_PAISE[plan];
}

export function planDurationDays(plan: PlanSlug): number {
  if (plan === 'yearly') return 365;
  return plan === 'quarterly' ? 90 : 30;
}
