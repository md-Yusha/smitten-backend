import type { Server } from 'socket.io';

let io: Server | null = null;

export function setCoupleIo(server: Server) {
  io = server;
}

export function emitCoupleEvent(coupleId: string, event: string, payload: unknown) {
  io?.to(`couple:${coupleId}`).emit(event, payload);
}

/** True when the user has an active socket in the couple room (app foreground/background). */
export async function isUserConnectedToCoupleSocket(
  userId: string,
  coupleId: string,
): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(`couple:${coupleId}`).fetchSockets();
  return sockets.some((s) => s.data.userId === userId);
}
