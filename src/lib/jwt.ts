import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { config } from '../config.js';
import { prisma } from './prisma.js';

export type AccessTokenPayload = {
  sub: string;
  email: string;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = jwt.sign({ sub: userId, type: 'refresh' }, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  const decoded = jwt.decode(raw) as { exp?: number } | null;
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt,
    },
  });

  return raw;
}

export async function rotateRefreshToken(oldToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  let payload: { sub: string; type?: string };
  try {
    // A stored refresh token remains valid until logout/password reset removes it.
    payload = jwt.verify(oldToken, config.JWT_REFRESH_SECRET, { ignoreExpiration: true }) as { sub: string; type?: string };
  } catch {
    return null;
  }

  if (payload.type !== 'refresh' || !payload.sub) return null;

  const tokenHash = hashToken(oldToken);
  const stored = await prisma.refreshToken.findFirst({
    where: { userId: payload.sub, tokenHash },
  });

  if (!stored) return null;

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return null;

  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  // Reuse the refresh token so concurrent 401 retries cannot invalidate each other.
  return { accessToken, refreshToken: oldToken };
}

export async function revokeRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}
