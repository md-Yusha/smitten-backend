import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyAccessToken } from './lib/jwt.js';
import { prisma } from './lib/prisma.js';
import { setCoupleIo } from './lib/coupleEvents.js';
import { notifyPartnerOfGameInvite } from './services/pushNotifications.js';

export function attachSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        next(new Error('Unauthorized'));
        return;
      }
      const payload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user?.coupleId) {
        next(new Error('No couple'));
        return;
      }
      socket.data.userId = user.id;
      socket.data.coupleId = user.coupleId;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const coupleId = socket.data.coupleId as string;
    const userId = socket.data.userId as string;
    socket.join(`couple:${coupleId}`);

    void prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
    });
    io.to(`couple:${coupleId}`).emit('presence:update', { userId, at: new Date().toISOString() });

    socket.on('typing:start', () => {
      socket.to(`couple:${coupleId}`).emit('typing:update', { userId, typing: true });
    });

    socket.on('typing:stop', () => {
      socket.to(`couple:${coupleId}`).emit('typing:update', { userId, typing: false });
    });

    socket.on('games:invite_send', (payload: any) => {
      socket.to(`couple:${coupleId}`).emit('games:invite_received', {
        senderId: userId,
        gameType: payload?.gameType,
      });
      void notifyPartnerOfGameInvite(coupleId, userId, payload?.gameType).catch(() => {});
    });

    socket.on('games:invite_accept', (payload: any) => {
      socket.to(`couple:${coupleId}`).emit('games:invite_accepted', {
        senderId: userId,
        gameType: payload?.gameType,
      });
    });

    socket.on('games:invite_decline', (payload: any) => {
      socket.to(`couple:${coupleId}`).emit('games:invite_declined', {
        senderId: userId,
      });
    });
  });

  setCoupleIo(io);
  return io;
}
