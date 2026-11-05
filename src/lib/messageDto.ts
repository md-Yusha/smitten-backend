import type { Message, User } from '@prisma/client';
import { decryptText } from './textEncryption.js';

type MessageWithReaction = Message & {
  reactionUserId?: string | null;
  reactionUserName?: string | null;
};

export type MessagePublic = {
  id: string;
  coupleId: string;
  senderId: string;
  kind: 'text' | 'sticker' | 'gif' | 'video' | 'system';
  body: string;
  replyToId: string | null;
  reaction: string | null;
  reactionUserId: string | null;
  reactionUserName: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  readAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export function toMessagePublic(m: MessageWithReaction): MessagePublic {
  const body = m.isDeleted ? decryptText(m.body) : decryptText(m.body);
  return {
    id: m.id,
    coupleId: m.coupleId,
    senderId: m.senderId,
    kind:
      m.kind === 'TEXT'
        ? 'text'
        : m.kind === 'STICKER'
          ? 'sticker'
          : m.kind === 'GIF'
            ? 'gif'
            : m.kind === 'VIDEO'
              ? 'video'
              : 'system',
    body,
    replyToId: m.replyToId ?? null,
    reaction: m.reaction ?? null,
    reactionUserId: m.reactionUserId ?? null,
    reactionUserName: m.reactionUserName ?? null,
    isEdited: m.isEdited,
    isDeleted: m.isDeleted,
    readAt: m.readAt?.toISOString() ?? null,
    expiresAt: m.expiresAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export function expiresAtForTtl(ttlMs: number | null | undefined): Date | null {
  if (ttlMs == null || ttlMs <= 0) return null;
  return new Date(Date.now() + ttlMs);
}

export function isPartnerOnline(lastSeenAt: Date | null | undefined): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < 2 * 60 * 1000;
}

export function pickPartner(users: User[], selfId: string): User | undefined {
  return users.find((u) => u.id !== selfId);
}
