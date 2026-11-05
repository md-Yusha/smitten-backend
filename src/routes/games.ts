import { Router } from 'express';
import { z } from 'zod';
import type { Server as SocketServer } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  notifyPartnerOfChallenge,
  notifyPartnerOfChallengeAnswer,
  notifyPartnerOfGameInvite,
  notifyPartnerOfGameMove,
} from '../services/pushNotifications.js';

let io: SocketServer | null = null;

export function setGamesIo(server: SocketServer) {
  io = server;
}

const challengeSchema = z.object({
  question: z.string().min(1).max(200).transform((s) => s.trim()),
  options: z.array(z.string().min(1).max(100)).min(3).max(4),
  correctIdx: z.number().int().min(0).max(3),
});

const answerSchema = z.object({
  answeredIdx: z.number().int().min(0).max(3),
});

const moveSchema = z.object({
  cellIdx: z.number().int().min(0).max(8),
});

function ticTacToePublic(game: {
  id: string;
  board: string;
  status?: string | null;
  invitedById?: string | null;
  declinedById?: string | null;
  turnUserId: string;
  playerXId: string;
  playerOId: string;
  winnerId: string | null;
  isDraw: boolean;
  rematchNumber?: number | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: game.id,
    board: game.board.split(','),
    status: game.status ?? 'ACTIVE',
    invitedById: game.invitedById ?? null,
    declinedById: game.declinedById ?? null,
    turnUserId: game.turnUserId,
    playerXId: game.playerXId,
    playerOId: game.playerOId,
    winnerId: game.winnerId,
    isDraw: game.isDraw,
    rematchNumber: game.rematchNumber ?? 0,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString(),
  };
}

async function getCoupleInfo(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { couple: { include: { users: { include: { subscription: true } } } } },
  });
  if (!user || !user.coupleId || !user.couple) return null;
  const now = new Date();
  const subscribed = user.couple.users.some(
    (u) =>
      u.subscription?.status === 'ACTIVE' &&
      Boolean(u.subscription.expiresAt && u.subscription.expiresAt > now),
  );
  if (!subscribed) return null;
  const partner = user.couple.users.find((u) => u.id !== userId) || null;
  return { coupleId: user.coupleId, partnerId: partner?.id ?? null };
}

const router = Router();

// Retrieve all game data (scores, challenges, tic-tac-toe)
router.get('/state', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const { coupleId, partnerId } = info;

  // The responder scores for a correct answer; otherwise the creator scores.
  // Prisma does not support field-to-field comparison in queries, so fetch and compute in JS
  const allChallengesForScore = await prisma.loveChallenge.findMany({
    where: { coupleId },
    select: { creatorId: true, answeredIdx: true, correctIdx: true },
  });

  const selfScore = partnerId
    ? allChallengesForScore.filter(
        (c) =>
          c.answeredIdx !== null &&
          ((c.creatorId === partnerId && c.answeredIdx === c.correctIdx) ||
            (c.creatorId === req.userId && c.answeredIdx !== c.correctIdx)),
      ).length
    : 0;

  const partnerScore = partnerId
    ? allChallengesForScore.filter(
        (c) =>
          c.answeredIdx !== null &&
          ((c.creatorId === req.userId && c.answeredIdx === c.correctIdx) ||
            (c.creatorId === partnerId && c.answeredIdx !== c.correctIdx)),
      ).length
    : 0;

  const loveChallenges = await prisma.loveChallenge.findMany({
    where: { coupleId },
    orderBy: { createdAt: 'desc' },
  });

  const ticTacToe = await prisma.ticTacToe.findFirst({
    where: {
      coupleId,
      status: { in: ['PENDING', 'ACTIVE'] },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const ticTacToeSelfScore = await prisma.ticTacToe.count({
    where: { coupleId, status: 'COMPLETED', winnerId: req.userId! },
  });
  const ticTacToePartnerScore = partnerId
    ? await prisma.ticTacToe.count({
        where: { coupleId, status: 'COMPLETED', winnerId: partnerId },
      })
    : 0;

  res.json({
    scores: { self: selfScore, partner: partnerScore },
    loveChallenges: loveChallenges.map((c) => ({
      id: c.id,
      creatorId: c.creatorId,
      question: c.question,
      options: JSON.parse(c.options) as string[],
      correctIdx: c.correctIdx,
      answeredIdx: c.answeredIdx,
      createdAt: c.createdAt.toISOString(),
    })),
    ticTacToe: ticTacToe ? ticTacToePublic(ticTacToe) : null,
    ticTacToeScores: { self: ticTacToeSelfScore, partner: ticTacToePartnerScore },
  });
});

// Create a new Love Challenge
router.post('/love-challenge', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid challenge fields' });
    return;
  }

  const { question, options, correctIdx } = parsed.data;

  const challenge = await prisma.loveChallenge.create({
    data: {
      coupleId: info.coupleId,
      creatorId: req.userId!,
      question,
      options: JSON.stringify(options),
      correctIdx,
    },
  });

  const responseObj = {
    id: challenge.id,
    creatorId: challenge.creatorId,
    question: challenge.question,
    options: JSON.parse(challenge.options) as string[],
    correctIdx: challenge.correctIdx,
    answeredIdx: challenge.answeredIdx,
    createdAt: challenge.createdAt.toISOString(),
  };

  io?.to(`couple:${info.coupleId}`).emit('games:challenge_updated', responseObj);
  void notifyPartnerOfChallenge(info.coupleId, req.userId!).catch(() => {});
  res.status(201).json({ challenge: responseObj });
});

// Answer a Love Challenge
router.post('/love-challenge/:id/answer', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid answer index' });
    return;
  }

  const id = String(req.params.id);
  const challenge = await prisma.loveChallenge.findFirst({
    where: { id, coupleId: info.coupleId },
  });

  if (!challenge) {
    res.status(404).json({ error: 'Challenge not found' });
    return;
  }

  if (challenge.creatorId === req.userId) {
    res.status(400).json({ error: 'You cannot answer your own challenge' });
    return;
  }

  if (challenge.answeredIdx !== null) {
    res.status(400).json({ error: 'Challenge already answered' });
    return;
  }

  const updated = await prisma.loveChallenge.update({
    where: { id },
    data: { answeredIdx: parsed.data.answeredIdx },
  });

  const responseObj = {
    id: updated.id,
    creatorId: updated.creatorId,
    question: updated.question,
    options: JSON.parse(updated.options) as string[],
    correctIdx: updated.correctIdx,
    answeredIdx: updated.answeredIdx,
    createdAt: updated.createdAt.toISOString(),
  };

  io?.to(`couple:${info.coupleId}`).emit('games:challenge_updated', responseObj);
  void notifyPartnerOfChallengeAnswer(info.coupleId, req.userId!).catch(() => {});
  res.json({ challenge: responseObj });
});

// Invite partner to a Tic-Tac-Toe match. Duplicate active/pending invites are blocked.
router.post('/tictactoe/invite', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const { coupleId, partnerId } = info;
  if (!partnerId) {
    res.status(400).json({ error: 'Partner must join before you can play' });
    return;
  }

  const existing = await prisma.ticTacToe.findFirst({
    where: {
      coupleId,
      status: { in: ['PENDING', 'ACTIVE'] },
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (existing) {
    res.status(409).json({ error: existing.status === 'PENDING' ? 'A Tic Tac Toe invite is already pending' : 'A Tic Tac Toe match is already active' });
    return;
  }

  const game = await prisma.ticTacToe.create({
    data: {
      coupleId,
      board: ',,,,,,,,',
      status: 'PENDING',
      invitedById: req.userId!,
      turnUserId: req.userId!,
      playerXId: req.userId!,
      playerOId: partnerId,
    },
  });

  const responseObj = ticTacToePublic(game);

  io?.to(`couple:${coupleId}`).emit('games:invite_received', {
    inviteId: game.id,
    senderId: req.userId!,
    gameType: 'tictactoe',
  });
  io?.to(`couple:${coupleId}`).emit('games:tictactoe_updated', responseObj);
  void notifyPartnerOfGameInvite(coupleId, req.userId!, 'tictactoe').catch(() => {});
  res.status(201).json({ game: responseObj });
});

router.post('/tictactoe/:id/accept', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const id = String(req.params.id);
  const game = await prisma.ticTacToe.findFirst({ where: { id, coupleId: info.coupleId } });
  if (!game || game.status !== 'PENDING') {
    res.status(404).json({ error: 'Invite is no longer available' });
    return;
  }
  if (game.invitedById === req.userId!) {
    res.status(400).json({ error: 'You cannot accept your own invite' });
    return;
  }
  if (req.userId! !== game.playerOId) {
    res.status(403).json({ error: 'Only the invited partner can accept' });
    return;
  }

  const updated = await prisma.ticTacToe.update({
    where: { id },
    data: { status: 'ACTIVE', turnUserId: game.playerXId },
  });
  const responseObj = ticTacToePublic(updated);
  io?.to(`couple:${info.coupleId}`).emit('games:invite_accepted', {
    inviteId: id,
    senderId: req.userId!,
    gameType: 'tictactoe',
    game: responseObj,
  });
  io?.to(`couple:${info.coupleId}`).emit('games:tictactoe_updated', responseObj);
  res.json({ game: responseObj });
});

router.post('/tictactoe/:id/decline', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const id = String(req.params.id);
  const game = await prisma.ticTacToe.findFirst({ where: { id, coupleId: info.coupleId } });
  if (!game || game.status !== 'PENDING') {
    res.status(404).json({ error: 'Invite is no longer available' });
    return;
  }
  if (game.invitedById === req.userId!) {
    res.status(400).json({ error: 'You cannot decline your own invite' });
    return;
  }

  const updated = await prisma.ticTacToe.update({
    where: { id },
    data: { status: 'DECLINED', declinedById: req.userId! },
  });
  io?.to(`couple:${info.coupleId}`).emit('games:invite_declined', {
    inviteId: id,
    senderId: req.userId!,
    gameType: 'tictactoe',
  });
  io?.to(`couple:${info.coupleId}`).emit('games:tictactoe_updated', ticTacToePublic(updated));
  res.json({ ok: true });
});

router.post('/tictactoe/:id/end', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const id = String(req.params.id);
  const game = await prisma.ticTacToe.findFirst({ where: { id, coupleId: info.coupleId } });
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }
  if (req.userId! !== game.playerXId && req.userId! !== game.playerOId) {
    res.status(403).json({ error: 'Only players can end this game' });
    return;
  }
  if (game.status !== 'PENDING' && game.status !== 'ACTIVE') {
    res.json({ ok: true });
    return;
  }

  const updated = await prisma.ticTacToe.update({
    where: { id },
    data: { status: 'DECLINED', declinedById: req.userId! },
  });
  io?.to(`couple:${info.coupleId}`).emit('games:tictactoe_updated', ticTacToePublic(updated));
  res.json({ ok: true });
});

router.post('/tictactoe/:id/rematch', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const previous = await prisma.ticTacToe.findFirst({
    where: { id: String(req.params.id), coupleId: info.coupleId },
  });
  if (!previous || previous.status !== 'COMPLETED') {
    res.status(400).json({ error: 'Finish the current match before a rematch' });
    return;
  }
  if (req.userId! !== previous.playerXId && req.userId! !== previous.playerOId) {
    res.status(403).json({ error: 'Only players can request a rematch' });
    return;
  }
  const active = await prisma.ticTacToe.findFirst({
    where: { coupleId: info.coupleId, status: { in: ['PENDING', 'ACTIVE'] } },
  });
  if (active) {
    res.status(409).json({ error: 'A Tic Tac Toe match is already in progress' });
    return;
  }

  const game = await prisma.ticTacToe.create({
    data: {
      coupleId: info.coupleId,
      board: ',,,,,,,,',
      status: 'ACTIVE',
      invitedById: req.userId!,
      playerXId: previous.playerOId,
      playerOId: previous.playerXId,
      turnUserId: previous.playerOId,
      rematchNumber: (previous.rematchNumber ?? 0) + 1,
    },
  });
  const responseObj = ticTacToePublic(game);
  io?.to(`couple:${info.coupleId}`).emit('games:tictactoe_updated', responseObj);
  res.status(201).json({ game: responseObj });
});

// Make a move in Tic-Tac-Toe
router.post('/tictactoe/move', requireAuth, async (req: AuthedRequest, res) => {
  const info = await getCoupleInfo(req.userId!);
  if (!info) {
    res.status(403).json({ error: 'Join a couple to use games' });
    return;
  }

  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid cell index' });
    return;
  }

  const { cellIdx } = parsed.data;
  const game = await prisma.ticTacToe.findFirst({
    where: { coupleId: info.coupleId, status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
  });

  if (!game) {
    res.status(404).json({ error: 'No active game found' });
    return;
  }

  if (game.winnerId || game.isDraw) {
    res.status(400).json({ error: 'Game is already completed' });
    return;
  }

  if (game.turnUserId !== req.userId) {
    res.status(400).json({ error: "It is not your turn" });
    return;
  }

  const boardArray = game.board.split(',');
  if (boardArray[cellIdx] !== '') {
    res.status(400).json({ error: 'Cell is already occupied' });
    return;
  }

  // Set the symbol
  const symbol = req.userId === game.playerXId ? 'X' : 'O';
  boardArray[cellIdx] = symbol;

  // Check for winner
  let winnerId: string | null = null;
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
    [0, 4, 8], [2, 4, 6]             // diagonals
  ];

  for (const pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (boardArray[a] && boardArray[a] === boardArray[b] && boardArray[a] === boardArray[c]) {
      winnerId = req.userId;
      break;
    }
  }

  // Check for draw
  const isDraw = !winnerId && boardArray.every((cell) => cell !== '');

  // Determine next turn
  const nextTurnUserId =
    winnerId || isDraw ? game.turnUserId : req.userId === game.playerXId ? game.playerOId : game.playerXId;

  const updated = await prisma.ticTacToe.update({
    where: { id: game.id },
    data: {
      board: boardArray.join(','),
      turnUserId: nextTurnUserId,
      winnerId,
      isDraw,
      ...(winnerId || isDraw ? { status: 'COMPLETED' } : {}),
    },
  });

  const responseObj = ticTacToePublic(updated);

  io?.to(`couple:${info.coupleId}`).emit('games:tictactoe_updated', responseObj);
  if (winnerId || isDraw) {
    void notifyPartnerOfGameMove(info.coupleId, req.userId!, 'tictactoe', true, winnerId).catch(() => {});
  }
  res.json({ game: responseObj });
});

export default router;
