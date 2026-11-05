import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { toUserPublic, userInclude } from '../lib/userDto.js';

export type AuthedRequest = Request & {
  userId?: string;
  user?: Awaited<ReturnType<typeof toUserPublic>>;
};

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: userInclude,
    });
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    req.userId = user.id;
    req.user = await toUserPublic(user);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
