import { randomBytes } from 'crypto';
import { prisma } from './prisma.js';

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CHARSET[bytes[i]! % CHARSET.length];
  }
  return code;
}

export async function generateUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = generateInviteCode();
    const existing = await prisma.couple.findUnique({ where: { inviteCode: code } });
    if (!existing) return code;
  }
  throw new Error('Could not generate unique invite code');
}
