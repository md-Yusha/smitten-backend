import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { adminSessionSecret, config, isAdminConfigured } from '../config.js';
import { generateUniqueInviteCode } from '../lib/inviteCode.js';
import { prisma } from '../lib/prisma.js';

type FieldKind = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'relation' | 'json';

type AdminField = {
  key: string;
  label: string;
  kind: FieldKind;
  virtual?: boolean;
  createOnly?: boolean;
  inList?: boolean;
  searchable?: boolean;
  editable?: boolean;
  creatable?: boolean;
  requiredForCreate?: boolean;
  enumValues?: string[];
  relation?: { model: string };
};

type AdminModel = {
  key: string;
  prismaKey: keyof typeof prisma;
  label: string;
  pluralLabel: string;
  titleField: string;
  fields: AdminField[];
  defaultSort: string;
};

const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'smitten_admin';

const modelDefs = [
  {
    key: 'user',
    prismaKey: 'user',
    label: 'User',
    pluralLabel: 'Users',
    titleField: 'email',
    defaultSort: 'createdAt',
    fields: [
      field('id', 'ID', 'string', { searchable: true }),
      field('email', 'Email', 'string', { inList: true, searchable: true, editable: true, creatable: true, requiredForCreate: true }),
      field('name', 'Name', 'string', { inList: true, searchable: true, editable: true, creatable: true, requiredForCreate: true }),
      field('password', 'Initial password', 'string', { virtual: true, createOnly: true, creatable: true, requiredForCreate: true }),
      field('phoneNumber', 'Phone number', 'string', { editable: true, creatable: true }),
      field('city', 'City', 'string', { editable: true, creatable: true }),
      field('dateOfBirth', 'Date of birth', 'date', { editable: true, creatable: true }),
      field('partnerKnownSince', 'Date met partner', 'date', { editable: true, creatable: true }),
      field('ownerRole', 'Role', 'string', { virtual: true, inList: true }),
      field('partnerEmail', 'Linked partner', 'string', { virtual: true, inList: true }),
      field('subscriptionStatus', 'Subscription', 'string', { virtual: true, inList: true }),
      field('subscriptionPlan', 'Plan', 'string', { virtual: true, inList: true }),
      field('subscriptionExpiresAt', 'Expires', 'date', { virtual: true, inList: true }),
      field('partnerPetName', 'Partner pet name', 'string', { editable: true, creatable: true }),
      field('nicknameSelf', 'Nickname', 'string', { editable: true, creatable: true }),
      enumField('gender', 'Gender', ['BOY', 'GIRL', 'OTHER'], { editable: true, creatable: true, requiredForCreate: true }),
      field('genderIdentity', 'Gender identity', 'string', { editable: true, creatable: true }),
      relationField('coupleId', 'Couple', 'couple', { editable: true, creatable: true }),
      field('isCoupleOwner', 'Couple owner', 'boolean', { editable: true, creatable: true }),
      field('lastSeenAt', 'Last seen', 'date', { inList: true, editable: true }),
      field('pushNotificationsEnabled', 'Push notifications', 'boolean', { editable: true, creatable: true }),
      field('createdAt', 'Created', 'date', { inList: true }),
      field('updatedAt', 'Updated', 'date', { inList: true }),
    ],
  },
  {
    key: 'couple',
    prismaKey: 'couple',
    label: 'Couple',
    pluralLabel: 'Couples',
    titleField: 'inviteCode',
    defaultSort: 'createdAt',
    fields: [
      field('id', 'ID', 'string', { searchable: true }),
      field('inviteCode', 'Invite code', 'string', { inList: true, searchable: true, editable: true, creatable: true, requiredForCreate: true }),
      enumField('status', 'Status', ['PENDING_PARTNER', 'ACTIVE'], { inList: true, editable: true, creatable: true }),
      field('ownerEmail', 'Main user', 'string', { virtual: true, inList: true }),
      field('partnerEmail', 'Linked partner', 'string', { virtual: true, inList: true }),
      field('createdAt', 'Created', 'date', { inList: true }),
      field('updatedAt', 'Updated', 'date', { inList: true }),
    ],
  },
  {
    key: 'subscription',
    prismaKey: 'subscription',
    label: 'Subscription',
    pluralLabel: 'Subscriptions',
    titleField: 'plan',
    defaultSort: 'createdAt',
    fields: [
      field('id', 'ID', 'string', { searchable: true }),
      relationField('userId', 'User', 'user', { inList: true, editable: true, creatable: true, requiredForCreate: true }),
      field('userEmail', 'User email', 'string', { virtual: true, inList: true }),
      field('userRole', 'Role', 'string', { virtual: true, inList: true }),
      enumField('plan', 'Plan', ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'], { inList: true, editable: true, creatable: true, requiredForCreate: true }),
      enumField('status', 'Status', ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED'], { inList: true, editable: true, creatable: true }),
      field('expiresAt', 'Expires', 'date', { inList: true, editable: true, creatable: true }),
      field('createdAt', 'Created', 'date', { inList: true }),
      field('updatedAt', 'Updated', 'date', { inList: true }),
    ],
  },
  {
    key: 'payment',
    prismaKey: 'payment',
    label: 'Payment',
    pluralLabel: 'Payments',
    titleField: 'merchantOrderId',
    defaultSort: 'createdAt',
    fields: [
      field('id', 'ID', 'string', { searchable: true }),
      relationField('userId', 'User', 'user', { inList: true, editable: true, creatable: true, requiredForCreate: true }),
      field('userEmail', 'User email', 'string', { virtual: true, inList: true }),
      field('userRole', 'Role', 'string', { virtual: true, inList: true }),
      enumField('plan', 'Plan', ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'], { inList: true, editable: true, creatable: true, requiredForCreate: true }),
      field('amountPaise', 'Amount', 'number', { inList: true, editable: true, creatable: true, requiredForCreate: true }),
      field('merchantOrderId', 'Merchant order ID', 'string', { inList: true, searchable: true, editable: true, creatable: true, requiredForCreate: true }),
      field('phonepeOrderId', 'PhonePe order ID', 'string', { searchable: true, editable: true, creatable: true }),
      field('phonepeTransactionId', 'PhonePe transaction ID', 'string', { searchable: true, editable: true, creatable: true }),
      enumField('status', 'Status', ['PENDING', 'COMPLETED', 'FAILED'], { inList: true, editable: true, creatable: true }),
      field('createdAt', 'Created', 'date', { inList: true }),
      field('updatedAt', 'Updated', 'date', { inList: true }),
    ],
  },
] satisfies AdminModel[];

const router = Router();
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().optional(),
  sortField: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

function field(key: string, label: string, kind: FieldKind, opts: Partial<AdminField> = {}): AdminField {
  return { key, label, kind, ...opts };
}

function enumField(key: string, label: string, enumValues: string[], opts: Partial<AdminField> = {}): AdminField {
  return field(key, label, 'enum', { ...opts, enumValues });
}

function relationField(key: string, label: string, model: string, opts: Partial<AdminField> = {}): AdminField {
  return field(key, label, 'relation', { ...opts, relation: { model } });
}

function timedContentModel(
  key: string,
  prismaKey: keyof typeof prisma,
  label: string,
  pluralLabel: string,
  dateField: string,
  extras: AdminField[] = [],
  privateText = false,
): AdminModel {
  return {
    key,
    prismaKey,
    label,
    pluralLabel,
    titleField: 'title',
    defaultSort: dateField,
    fields: [
      field('id', 'ID', 'string', { inList: true, searchable: true }),
      relationField('coupleId', 'Couple', 'couple', { inList: true, editable: true }),
      relationField('creatorId', 'Creator', 'user', { inList: true, editable: true }),
      field('title', 'Title', 'string', privateText ? { inList: true } : { inList: true, searchable: true, editable: true }),
      ...extras,
      field(dateField, label === 'Note' ? 'Note at' : label === 'Memory' ? 'Memory at' : 'Moment at', 'date', {
        inList: true,
        editable: true,
      }),
      field('createdAt', 'Created', 'date', { inList: true }),
    ],
  };
}

function delegate(model: AdminModel): any {
  return (prisma as any)[model.prismaKey];
}

function publicModel(model: AdminModel) {
  const { prismaKey: _prismaKey, defaultSort: _defaultSort, ...rest } = model;
  return rest;
}

function modelByKey(key: string): AdminModel | undefined {
  return modelDefs.find((m) => m.key === key);
}

function sign(value: string): string {
  return createHmac('sha256', adminSessionSecret()).update(value).digest('base64url');
}

function sessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ u: config.ADMIN_USERNAME, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const parts = raw.split(';').map((part) => part.trim());
  const found = parts.find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : undefined;
}

function setSessionCookie(res: Response) {
  res.cookie(COOKIE_NAME, sessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/admin',
    maxAge: ONE_WEEK_SECONDS * 1000,
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: '/admin' });
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminConfigured()) {
    res.status(503).json({ error: 'Admin panel is not configured' });
    return;
  }
  if (!verifySessionToken(readCookie(req, COOKIE_NAME))) {
    res.status(401).json({ error: 'Admin sign in required' });
    return;
  }
  next();
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function userRole(user: any): string {
  if (!user?.coupleId) return 'Unlinked';
  return user.isCoupleOwner ? 'Main user' : 'Linked partner';
}

function partnerFor(user: any): any | null {
  return user?.couple?.users?.find((partner: any) => partner.id !== user.id) ?? null;
}

function ownerFor(couple: any): any | null {
  return couple?.users?.find((user: any) => user.isCoupleOwner) ?? couple?.users?.[0] ?? null;
}

function linkedPartnerFor(couple: any): any | null {
  return couple?.users?.find((user: any) => !user.isCoupleOwner) ?? null;
}

function virtualValue(row: Record<string, unknown>, model: AdminModel, fieldDef: AdminField): unknown {
  if (model.key === 'user') {
    if (fieldDef.key === 'ownerRole') return userRole(row);
    if (fieldDef.key === 'partnerEmail') return partnerFor(row)?.email ?? null;
    if (fieldDef.key === 'subscriptionStatus') return (row as any).subscription?.status ?? 'No subscription';
    if (fieldDef.key === 'subscriptionPlan') return (row as any).subscription?.plan ?? null;
    if (fieldDef.key === 'subscriptionExpiresAt') return (row as any).subscription?.expiresAt ?? null;
  }
  if (model.key === 'couple') {
    if (fieldDef.key === 'ownerEmail') return ownerFor(row)?.email ?? null;
    if (fieldDef.key === 'partnerEmail') return linkedPartnerFor(row)?.email ?? null;
  }
  if (model.key === 'subscription' || model.key === 'payment') {
    if (fieldDef.key === 'userEmail') return (row as any).user?.email ?? null;
    if (fieldDef.key === 'userRole') return userRole((row as any).user);
  }
  return null;
}

function serializeRow(row: Record<string, unknown>, model: AdminModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of model.fields) {
    const raw = f.virtual ? virtualValue(row, model, f) : row[f.key];
    out[f.key] = model.key === 'payment' && f.key === 'amountPaise' && typeof raw === 'number' ? raw / 100 : serializeValue(raw);
  }
  return out;
}

function readArgsForModel(model: AdminModel) {
  if (model.key === 'user') {
    return { include: { subscription: true, couple: { include: { users: true } } } };
  }
  if (model.key === 'couple') {
    return { include: { users: true } };
  }
  if (model.key === 'subscription' || model.key === 'payment') {
    return { include: { user: true } };
  }
  return {};
}

function parseValue(fieldDef: AdminField, value: unknown): unknown {
  if (value === '') return null;
  if (value === null || value === undefined) return null;
  if (fieldDef.kind === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${fieldDef.label} must be a number`);
    if (fieldDef.key === 'amountPaise') return Math.round(value * 100);
    return value;
  }
  if (fieldDef.kind === 'boolean') return Boolean(value);
  if (fieldDef.kind === 'date') {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new Error(`${fieldDef.label} must be a valid date`);
    return date;
  }
  if (fieldDef.kind === 'enum') {
    if (!fieldDef.enumValues?.includes(String(value))) throw new Error(`${fieldDef.label} is not valid`);
    return String(value);
  }
  return String(value);
}

function parseCreateData(model: AdminModel, body: Record<string, unknown>) {
  const creatableFields = model.fields.filter((f) => f.creatable);
  const data: Record<string, unknown> = {};

  for (const fieldDef of creatableFields) {
    const value = body[fieldDef.key];
    if (fieldDef.requiredForCreate && (value === undefined || value === null || value === '')) {
      throw new Error(`${fieldDef.label} is required`);
    }
    if (value === undefined || value === null || value === '') continue;
    if (fieldDef.createOnly || fieldDef.virtual) continue;
    data[fieldDef.key] = parseValue(fieldDef, value);
  }

  return data;
}

async function createModelRow(model: AdminModel, body: Record<string, unknown>) {
  if (model.key === 'user') {
    const password = String(body.password ?? '');
    if (password.length < 8) throw new Error('Initial password must be at least 8 characters');
    const data = parseCreateData(model, body);
    return delegate(model).create({
      data: {
        ...data,
        email: String(data.email).toLowerCase().trim(),
        name: String(data.name).trim(),
        passwordHash: await bcrypt.hash(password, 12),
      } as any,
      ...readArgsForModel(model),
    });
  }

  const data = parseCreateData(model, body);
  return delegate(model).create({ data, ...readArgsForModel(model) });
}

function searchableWhere(model: AdminModel, search: string | undefined) {
  const term = search?.trim();
  if (!term) return undefined;
  const fields = model.fields.filter((f) => !f.virtual && f.searchable && f.kind === 'string');
  if (fields.length === 0) return undefined;
  return { OR: fields.map((f) => ({ [f.key]: { contains: term, mode: 'insensitive' } })) };
}

function validSortField(model: AdminModel, sortField: string | undefined): string {
  return model.fields.some((f) => !f.virtual && f.key === sortField) ? sortField! : model.defaultSort;
}

async function relationLabel(modelKey: string, id: unknown): Promise<{ id: string; label: string } | null> {
  if (!id) return null;
  const model = modelByKey(modelKey);
  if (!model) return null;
  const row = await delegate(model).findUnique({ where: { id: String(id) }, ...readArgsForModel(model) });
  if (!row) return null;
  return {
    id: row.id,
    label: String(row[model.titleField] ?? row.id),
  };
}

router.get('/session', (_req, res) => {
  res.json({ configured: isAdminConfigured() });
});

router.post('/login', (req, res) => {
  if (!isAdminConfigured()) {
    res.status(503).json({ error: 'Admin panel is not configured' });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  if (parsed.data.username !== config.ADMIN_USERNAME || parsed.data.password !== config.ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid admin credentials' });
    return;
  }

  setSessionCookie(res);
  res.json({ ok: true });
});

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.use(requireAdmin);

router.get('/models', (_req, res) => {
  res.json({ models: modelDefs.map(publicModel) });
});

router.get('/stats', async (_req, res, next) => {
  try {
    const counts = await Promise.all(
      modelDefs.map(async (model) => ({ key: model.key, count: await delegate(model).count() })),
    );
    const [activeCouples, activeSubscriptions, completedPayments] = await Promise.all([
      prisma.couple.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.payment.count({ where: { status: 'COMPLETED' } }),
    ]);

    res.json({ counts, highlights: { activeCouples, activeSubscriptions, completedPayments } });
  } catch (err) {
    next(err);
  }
});

router.post('/generate/invite-code', async (_req, res, next) => {
  try {
    res.json({ inviteCode: await generateUniqueInviteCode() });
  } catch (err) {
    next(err);
  }
});

router.post('/generate/couple', async (_req, res, next) => {
  try {
    const couple = await prisma.couple.create({
      data: {
        inviteCode: await generateUniqueInviteCode(),
        status: 'PENDING_PARTNER',
      },
    });
    res.status(201).json({
      couple: {
        id: couple.id,
        inviteCode: couple.inviteCode,
        status: couple.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/models/:modelKey', async (req, res, next) => {
  try {
    const model = modelByKey(req.params.modelKey);
    if (!model) {
      res.status(404).json({ error: 'Unknown model' });
      return;
    }

    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid list parameters' });
      return;
    }

    const { page, pageSize, search, sortDir } = parsed.data;
    const sortField = validSortField(model, parsed.data.sortField);
    const where = searchableWhere(model, search);
    const [total, rows] = await Promise.all([
      delegate(model).count({ where }),
      delegate(model).findMany({
        where,
        orderBy: { [sortField]: sortDir },
        skip: (page - 1) * pageSize,
        take: pageSize,
        ...readArgsForModel(model),
      }),
    ]);

    res.json({
      rows: rows.map((row: Record<string, unknown>) => serializeRow(row, model)),
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/models/:modelKey/:id', async (req, res, next) => {
  try {
    const model = modelByKey(req.params.modelKey);
    if (!model) {
      res.status(404).json({ error: 'Unknown model' });
      return;
    }
    const row = await delegate(model).findUnique({ where: { id: req.params.id }, ...readArgsForModel(model) });
    if (!row) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }
    res.json({ row: serializeRow(row, model) });
  } catch (err) {
    next(err);
  }
});

router.get('/models/:modelKey/:id/relations', async (req, res, next) => {
  try {
    const model = modelByKey(req.params.modelKey);
    if (!model) {
      res.status(404).json({ error: 'Unknown model' });
      return;
    }
    const row = await delegate(model).findUnique({ where: { id: req.params.id }, ...readArgsForModel(model) });
    if (!row) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }

    const entries = await Promise.all(
      model.fields
        .filter((f) => f.kind === 'relation' && f.relation)
        .map(async (f) => [f.key, await relationLabel(f.relation!.model, row[f.key])] as const),
    );
    res.json({ relations: Object.fromEntries(entries.filter(([, value]) => value)) });
  } catch (err) {
    next(err);
  }
});

router.post('/models/:modelKey', async (req, res, next) => {
  try {
    const model = modelByKey(req.params.modelKey);
    if (!model) {
      res.status(404).json({ error: 'Unknown model' });
      return;
    }
    if (!model.fields.some((f) => f.creatable)) {
      res.status(400).json({ error: `${model.pluralLabel} cannot be created here` });
      return;
    }

    const row = await createModelRow(model, req.body ?? {});
    res.status(201).json({ row: serializeRow(row, model) });
  } catch (err) {
    next(err);
  }
});

router.patch('/models/:modelKey/:id', async (req, res, next) => {
  try {
    const model = modelByKey(req.params.modelKey);
    if (!model) {
      res.status(404).json({ error: 'Unknown model' });
      return;
    }

    const editableFields = new Map(model.fields.filter((f) => f.editable).map((f) => [f.key, f]));
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.body ?? {})) {
      const fieldDef = editableFields.get(key);
      if (!fieldDef) continue;
      data[key] = parseValue(fieldDef, value);
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No editable fields were provided' });
      return;
    }

    const row = await delegate(model).update({ where: { id: req.params.id }, data });
    res.json({ row: serializeRow(row, model) });
  } catch (err) {
    next(err);
  }
});

router.delete('/models/:modelKey/:id', async (req, res, next) => {
  try {
    const model = modelByKey(req.params.modelKey);
    if (!model) {
      res.status(404).json({ error: 'Unknown model' });
      return;
    }
    await delegate(model).delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Admin request failed';
  res.status(500).json({ error: message });
});

export default router;
