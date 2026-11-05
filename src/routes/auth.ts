import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { buildAvatarPublicUrl } from '../lib/avatarUrl.js';
import { emitCoupleEvent } from '../lib/coupleEvents.js';
import { prisma } from '../lib/prisma.js';
import { issueRefreshToken, revokeRefreshTokens, rotateRefreshToken, signAccessToken } from '../lib/jwt.js';
import { toUserPublic, userInclude } from '../lib/userDto.js';
import { toMessagePublic } from '../lib/messageDto.js';
import { encryptText, TEXT_ENCRYPTION_KEY_VERSION } from '../lib/textEncryption.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { confirmSubscriptionStatusForUser } from '../services/subscriptions.js';
import { sendAccountDeletedEmail, sendAppLockRecoveryCode, sendEmailVerificationCode, sendPartnerDeletedEmail, sendPasswordResetCode } from '../services/mail.js';

const uploadsDir = path.join(process.cwd(), 'uploads');

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, _file, cb) => {
      cb(null, `${(req as AuthedRequest).userId!}.jpg`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Only image files are allowed'));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

function notifyCoupleProfile(coupleId: string | null | undefined, userId: string) {
  if (coupleId) emitCoupleEvent(coupleId, 'profile:updated', { userId });
}

async function deleteUserOwnedData(userId: string) {
  await prisma.$transaction([
    prisma.refreshToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.payment.deleteMany({ where: { userId } }),
    prisma.subscription.deleteMany({ where: { userId } }),
    prisma.message.deleteMany({ where: { senderId: userId } }),
    prisma.vaultItem.deleteMany({ where: { uploaderId: userId } }),
    prisma.memory.deleteMany({ where: { creatorId: userId } }),
    prisma.note.deleteMany({ where: { creatorId: userId } }),
    prisma.specialMoment.deleteMany({ where: { creatorId: userId } }),
    prisma.lovePing.deleteMany({ where: { senderId: userId } }),
    prisma.loveChallenge.deleteMany({ where: { creatorId: userId } }),
    prisma.ticTacToe.deleteMany({
      where: {
        OR: [
          { turnUserId: userId },
          { playerXId: userId },
          { playerOId: userId },
          { winnerId: userId },
        ],
      },
    }),
  ]);
}

async function deleteCoupleScopedData(coupleId: string) {
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { coupleId } }),
    prisma.vaultItem.deleteMany({ where: { coupleId } }),
    prisma.memory.deleteMany({ where: { coupleId } }),
    prisma.note.deleteMany({ where: { coupleId } }),
    prisma.specialMoment.deleteMany({ where: { coupleId } }),
    prisma.lovePing.deleteMany({ where: { coupleId } }),
    prisma.loveChallenge.deleteMany({ where: { coupleId } }),
    prisma.ticTacToe.deleteMany({ where: { coupleId } }),
  ]);
}

const genderSchema = z.enum(['male', 'female', 'other', 'boy', 'girl']);

const petNameSchema = z.string().min(1).max(40).transform((s) => s.trim());

const registerSchema = z.object({
  email: z.string().email().max(255),
  emailVerificationKey: z.string().min(32).max(128),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80).transform((s) => s.trim()),
  lastName: z.string().max(80).optional().transform((s) => (s?.trim() ? s.trim() : undefined)),
  phoneNumber: z
    .string()
    .max(30)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
  city: z
    .string()
    .max(80)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
  dateOfBirth: z.coerce.date().optional(),
  partnerKnownSince: z.coerce.date().optional(),
  partnerPetName: petNameSchema.optional(),
  gender: genderSchema.optional(),
  genderIdentity: z
    .string()
    .max(120)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
});

function genderToPrisma(g: z.infer<typeof genderSchema>): 'BOY' | 'GIRL' | 'OTHER' {
  if (g === 'male' || g === 'boy') return 'BOY';
  if (g === 'female' || g === 'girl') return 'GIRL';
  return 'OTHER';
}

const profileSchema = z.object({
  name: z.string().min(1).max(80).transform((s) => s.trim()).optional(),
  lastName: z.string().max(80).nullable().optional().transform((s) => (s?.trim() ? s.trim() : null)),
  email: z.string().email().max(255).transform((s) => s.toLowerCase().trim()).optional(),
  phoneNumber: z.string().max(30).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  partnerPetName: z.string().max(40).nullable().optional(),
  nicknameSelf: z.string().max(40).transform((s) => s.trim()).optional(),
  chatDisappearingAfterMs: z.number().int().nullable().optional(),
  chatThemeId: z.string().min(1).max(32).optional(),
  mood: z.string().max(100).nullable().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const storySchema = z.object({
  city: z.string().min(1).max(80).transform((s) => s.trim()),
  dateOfBirth: z.coerce.date(),
  partnerKnownSince: z.coerce.date(),
  gender: genderSchema,
  genderIdentity: z
    .string()
    .max(120)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function isValidPhoneNumber(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.replace(/[().\s-]/g, '');
  return /^\+?[1-9]\d{7,14}$/.test(normalized);
}

function ageAtLeast(dateOfBirth: Date, minimumAge: number): boolean {
  const today = new Date();
  let age = today.getFullYear() - dateOfBirth.getFullYear();
  const birthdayPassed = today.getMonth() > dateOfBirth.getMonth() ||
    (today.getMonth() === dateOfBirth.getMonth() && today.getDate() >= dateOfBirth.getDate());
  if (!birthdayPassed) age -= 1;
  return age >= minimumAge;
}

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const emailVerificationRequestSchema = z.object({
  email: z.string().email(),
});

const emailVerificationVerifySchema = z.object({
  email: z.string().email(),
  code: z
    .string()
    .transform((value) => value.replace(/\D/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Verification code must be 6 digits')),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z
    .string()
    .transform((value) => value.replace(/\D/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Reset code must be 6 digits')),
  password: z.string().min(8).max(128),
});

const appLockRecoveryVerifySchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\D/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Recovery code must be 6 digits')),
});

function resetCodeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function legacyResetCodeHash(email: string, code: string): string {
  return createHash('sha256').update(`${email.toLowerCase().trim()}:${code}`).digest('hex');
}

function createResetCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function verificationKeyHash(value: string): string {
  return createHash('sha256').update(`email-verification:${value}`).digest('hex');
}

async function authResponse(userId: string) {
  await confirmSubscriptionStatusForUser(userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: userInclude,
  });
  if (!user) throw new Error('User missing after auth');

  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  const refreshToken = await issueRefreshToken(user.id);

  return {
    accessToken,
    refreshToken,
    user: await toUserPublic(user),
  };
}

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }

  const {
    email,
    emailVerificationKey,
    password,
    name,
    lastName,
    phoneNumber,
    city,
    dateOfBirth,
    partnerKnownSince,
    partnerPetName,
    gender,
    genderIdentity,
  } =
    parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  if (!isValidPhoneNumber(phoneNumber)) {
    res.status(400).json({ error: 'Enter a valid phone number in international format' });
    return;
  }
  if (dateOfBirth && !ageAtLeast(dateOfBirth, 16)) {
    res.status(400).json({ error: 'You must be at least 16 years old to use Smittenz' });
    return;
  }
  if (dateOfBirth && partnerKnownSince && partnerKnownSince <= dateOfBirth) {
    res.status(400).json({ error: 'The date you knew your partner must be after your date of birth' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const verification = await prisma.emailVerificationToken.findFirst({
    where: {
      email: normalizedEmail,
      verificationHash: verificationKeyHash(emailVerificationKey),
      verifiedAt: { not: null },
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!verification) {
    res.status(400).json({ error: 'Please verify your email before creating the account' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name,
        lastName: lastName ?? null,
        phoneNumber: phoneNumber ?? null,
        city: city ?? null,
        dateOfBirth: dateOfBirth ?? null,
        partnerKnownSince: partnerKnownSince ?? null,
        partnerPetName: partnerPetName ?? null,
        gender: gender ? genderToPrisma(gender) : 'OTHER',
        genderIdentity: genderIdentity ?? null,
      },
      include: userInclude,
    });
    await tx.emailVerificationToken.update({
      where: { id: verification.id },
      data: { usedAt: new Date() },
    });
    return createdUser;
  });

  const tokens = await authResponse(user.id);
  res.status(201).json(tokens);
});

router.post('/email-verification/request', async (req, res, next) => {
  try {
    const parsed = emailVerificationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a valid email address' });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const code = createResetCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.emailVerificationToken.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });
    await prisma.emailVerificationToken.create({
      data: {
        email,
        codeHash: resetCodeHash(code),
        verificationHash: null,
        expiresAt,
        verifiedAt: null,
        usedAt: null,
      },
    });

    await sendEmailVerificationCode(email, code);
    res.json({ ok: true });
  } catch (err) {
    console.error('[email-verification] Could not send verification email:', err instanceof Error ? err.message : String(err));
    next(err);
  }
});

router.post('/email-verification/verify', async (req, res, next) => {
  try {
    const parsed = emailVerificationVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter the 6-digit verification code' });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const token = await prisma.emailVerificationToken.findFirst({
      where: {
        email,
        codeHash: resetCodeHash(parsed.data.code),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }

    const verificationKey = randomBytes(24).toString('hex');
    await prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: {
        verifiedAt: new Date(),
        verificationHash: verificationKeyHash(verificationKey),
      },
    });

    res.json({ ok: true, verificationKey });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: userInclude,
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  await revokeRefreshTokens(user.id);
  const tokens = await authResponse(user.id);
  res.json(tokens);
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a valid email address' });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });

    // Avoid revealing whether an email exists in the database.
    if (!user) {
      res.json({ ok: true });
      return;
    }

    const code = createResetCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        codeHash: resetCodeHash(code),
        purpose: 'PASSWORD_RESET',
        expiresAt,
        usedAt: null,
      },
    });

    await sendPasswordResetCode(email, code);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter the code and a new password of at least 8 characters' });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const codeHashes = [resetCodeHash(parsed.data.code), legacyResetCodeHash(email, parsed.data.code)];
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        codeHash: { in: codeHashes },
        OR: [{ purpose: 'PASSWORD_RESET' }, { purpose: null }],
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetToken) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(parsed.data.password, 12) },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/app-lock-recovery/request', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { id: true, email: true } });
    if (!user) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const code = createResetCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, purpose: 'APP_LOCK_RECOVERY', usedAt: null },
      data: { usedAt: new Date() },
    });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, codeHash: resetCodeHash(code), purpose: 'APP_LOCK_RECOVERY', expiresAt, usedAt: null },
    });
    await sendAppLockRecoveryCode(user.email, code);

    const [local, domain] = user.email.split('@');
    const maskedEmail = `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
    res.json({ ok: true, maskedEmail });
  } catch (err) {
    next(err);
  }
});

router.post('/app-lock-recovery/verify', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = appLockRecoveryVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter the 6-digit recovery code' });
      return;
    }
    const token = await prisma.passwordResetToken.findFirst({
      where: {
        userId: req.userId!,
        purpose: 'APP_LOCK_RECOVERY',
        codeHash: resetCodeHash(parsed.data.code),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) {
      res.status(400).json({ error: 'Invalid or expired recovery code' });
      return;
    }
    await prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res) => {
  const refreshToken = z.string().min(1).safeParse(req.body?.refreshToken);
  if (!refreshToken.success) {
    res.status(400).json({ error: 'refreshToken required' });
    return;
  }

  const rotated = await rotateRefreshToken(refreshToken.data);
  if (!rotated) {
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  res.json(rotated);
});

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  await confirmSubscriptionStatusForUser(req.userId!);
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    include: userInclude,
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: await toUserPublic(user) });
});

router.post('/story', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = storySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Complete all story details', details: parsed.error.flatten() });
    return;
  }

  const current = await prisma.user.findUnique({
    where: { id: req.userId! },
    include: userInclude,
  });
  if (!current) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!current.coupleId || !current.couple) {
    res.status(400).json({ error: 'Choose Get a key or I have a key before completing your story' });
    return;
  }
  if (!ageAtLeast(parsed.data.dateOfBirth, 16)) {
    res.status(400).json({ error: 'You must be at least 16 years old to use Smittenz' });
    return;
  }
  if (parsed.data.partnerKnownSince <= parsed.data.dateOfBirth) {
    res.status(400).json({ error: 'The date you knew your partner must be after your date of birth' });
    return;
  }

  const relationshipDate = parsed.data.partnerKnownSince;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: current.id },
      data: {
        city: parsed.data.city,
        dateOfBirth: parsed.data.dateOfBirth,
        partnerKnownSince: relationshipDate,
        gender: genderToPrisma(parsed.data.gender),
        genderIdentity: parsed.data.genderIdentity ?? null,
      },
    });

    await tx.user.updateMany({
      where: { coupleId: current.coupleId! },
      data: { partnerKnownSince: relationshipDate },
    });
  });

  const updated = await prisma.user.findUnique({
    where: { id: current.id },
    include: userInclude,
  });
  if (!updated) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: await toUserPublic(updated) });
});

router.patch('/profile', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }

  const { name, lastName, email, phoneNumber, city, partnerPetName, nicknameSelf, chatDisappearingAfterMs, chatThemeId, mood } = parsed.data;
  if (
    !name && lastName === undefined && !email && phoneNumber === undefined && city === undefined &&
    partnerPetName === undefined &&
    nicknameSelf === undefined &&
    chatDisappearingAfterMs === undefined &&
    !chatThemeId &&
    mood === undefined
  ) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  if (!isValidPhoneNumber(phoneNumber)) {
    res.status(400).json({ error: 'Enter a valid phone number in international format' });
    return;
  }

  if (email) {
    const duplicate = await prisma.user.findFirst({ where: { email, NOT: { id: req.userId! } }, select: { id: true } });
    if (duplicate) {
      res.status(409).json({ error: 'That email address is already in use' });
      return;
    }
  }

  const updated = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      ...(name ? { name } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...(email ? { email } : {}),
      ...(phoneNumber !== undefined ? { phoneNumber: phoneNumber?.trim() || null } : {}),
      ...(city !== undefined ? { city: city?.trim() || null } : {}),
      ...(partnerPetName !== undefined
        ? { partnerPetName: typeof partnerPetName === 'string' ? partnerPetName.trim() || null : null }
        : {}),
      ...(nicknameSelf !== undefined ? { nicknameSelf: nicknameSelf || null } : {}),
      ...(chatDisappearingAfterMs !== undefined ? { chatDisappearingAfterMs } : {}),
      ...(chatThemeId ? { chatThemeId } : {}),
      ...(mood !== undefined ? { mood } : {}),
    },
    include: userInclude,
  });

  if (chatDisappearingAfterMs !== undefined && updated.coupleId) {
    // Human-readable label (handles standard AND custom values)
    let durationText: string;
    if (chatDisappearingAfterMs === null) {
      durationText = 'Off';
    } else if (chatDisappearingAfterMs === 24 * 60 * 60 * 1000) {
      durationText = '24 hours';
    } else if (chatDisappearingAfterMs === 7 * 24 * 60 * 60 * 1000) {
      durationText = '7 days';
    } else if (chatDisappearingAfterMs === 30 * 24 * 60 * 60 * 1000) {
      durationText = '30 days';
    } else {
      const totalSeconds = Math.floor(chatDisappearingAfterMs / 1000);
      const totalMinutes = Math.floor(totalSeconds / 60);
      const totalHours = Math.floor(totalMinutes / 60);
      const totalDays = Math.floor(totalHours / 24);
      if (totalDays > 0 && totalHours % 24 === 0) durationText = `${totalDays} day${totalDays > 1 ? 's' : ''}`;
      else if (totalHours > 0 && totalMinutes % 60 === 0) durationText = `${totalHours} hour${totalHours > 1 ? 's' : ''}`;
      else if (totalMinutes > 0 && totalSeconds % 60 === 0) durationText = `${totalMinutes} minute${totalMinutes > 1 ? 's' : ''}`;
      else durationText = `${totalSeconds} second${totalSeconds > 1 ? 's' : ''}`;
    }

    // Create system log message
    const sysMessage = await prisma.message.create({
      data: {
        coupleId: updated.coupleId,
        senderId: updated.id,
        kind: 'SYSTEM',
        body: encryptText(`${updated.name} set disappearing messages to ${durationText}`),
        keyVersion: TEXT_ENCRYPTION_KEY_VERSION,
        expiresAt: null,
      },
    });

    const publicMsg = toMessagePublic(sysMessage);
    emitCoupleEvent(updated.coupleId, 'message:new', publicMsg);
    emitCoupleEvent(updated.coupleId, 'profile:updated', {
      userId: updated.id,
    });
  } else {
    notifyCoupleProfile(updated.coupleId, updated.id);
  }

  const publicUser = await toUserPublic(updated);
  res.json({ user: publicUser });
});

router.post('/change-password', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Use your current password and a new password of at least 8 characters' });
    return;
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    res.status(400).json({ error: 'Choose a password different from your current password' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { passwordHash: true } });
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  await prisma.user.update({
    where: { id: req.userId! },
    data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12) },
  });
  res.json({ ok: true });
});

router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req: AuthedRequest, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'avatar image required' });
    return;
  }

  const now = new Date();
  const avatarUrl = buildAvatarPublicUrl(req, req.userId!, now);

  const updated = await prisma.user.update({
    where: { id: req.userId! },
    data: { avatarUrl },
    include: userInclude,
  });

  const publicUser = await toUserPublic(updated);
  notifyCoupleProfile(updated.coupleId, updated.id);
  res.json({ user: publicUser });
});

router.delete('/delete-account', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { couple: { include: { users: true } } },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const couple = user.couple;
    if (!couple) {
      void sendAccountDeletedEmail(user.email, user.name).catch((error) => {
        console.warn('Failed to send account deletion email', error);
      });
      await deleteUserOwnedData(userId);
      await prisma.user.delete({ where: { id: userId } });
      res.json({ ok: true });
      return;
    }

    const partner = couple.users.find((u) => u.id !== userId);
    const ownerDeleting = user.isCoupleOwner;

    void sendAccountDeletedEmail(user.email, user.name).catch((error) => {
      console.warn('Failed to send account deletion email', error);
    });
    if (partner) {
      void sendPartnerDeletedEmail(partner.email, user.name).catch((error) => {
        console.warn('Failed to send partner deletion email', error);
      });
    }

    emitCoupleEvent(couple.id, 'couple:disbanded', {
      reason: ownerDeleting ? 'owner_deleted' : 'partner_deleted',
      deletedUserId: userId,
      deletedName: user.name,
    });

    if (ownerDeleting) {
      const userIds = couple.users.map((u) => u.id);
      await deleteCoupleScopedData(couple.id);
      await prisma.$transaction([
        prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } }),
        prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } }),
        prisma.payment.deleteMany({ where: { userId: { in: userIds } } }),
        prisma.subscription.deleteMany({ where: { userId: { in: userIds } } }),
        prisma.user.deleteMany({ where: { id: { in: userIds } } }),
        prisma.couple.delete({ where: { id: couple.id } }),
      ]);
      res.json({ ok: true });
      return;
    }

    const partnerDeleteOps = partner
      ? [
          prisma.user.update({
            where: { id: partner.id },
            data: { partnerPetName: null },
          }),
        ]
      : [];

    await prisma.$transaction([
      prisma.message.deleteMany({ where: { senderId: userId } }),
      prisma.vaultItem.deleteMany({ where: { uploaderId: userId } }),
      prisma.memory.deleteMany({ where: { creatorId: userId } }),
      prisma.note.deleteMany({ where: { creatorId: userId } }),
      prisma.specialMoment.deleteMany({ where: { creatorId: userId } }),
      prisma.lovePing.deleteMany({ where: { coupleId: couple.id } }),
      prisma.loveChallenge.deleteMany({ where: { creatorId: userId } }),
      prisma.ticTacToe.deleteMany({
        where: {
          OR: [
            { coupleId: couple.id },
            { turnUserId: userId },
            { playerXId: userId },
            { playerOId: userId },
            { winnerId: userId },
          ],
        },
      }),
      prisma.refreshToken.deleteMany({ where: { userId } }),
      prisma.passwordResetToken.deleteMany({ where: { userId } }),
      prisma.payment.deleteMany({ where: { userId } }),
      prisma.subscription.deleteMany({ where: { userId } }),
      ...partnerDeleteOps,
      prisma.couple.update({
        where: { id: couple.id },
        data: {
          status: 'PENDING_PARTNER',
          reservedPartnerEmail: user.email.toLowerCase().trim(),
        },
      }),
      prisma.user.delete({ where: { id: userId } }),
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('[DeleteAccount] Error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  if (req.userId) await revokeRefreshTokens(req.userId);
  res.json({ ok: true });
});

export default router;
