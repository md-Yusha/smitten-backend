import type { Request } from 'express';
import { config } from '../config.js';

/** Public URL for a user's avatar file (cache-busted when profile changes). */
export function buildAvatarPublicUrl(_req: Request, userId: string, updatedAt: Date): string {
  const configured = config.PUBLIC_API_URL?.trim();
  const base = (configured || `http://localhost:${config.PORT}`).replace(/\/$/, '');
  return `${base}/uploads/${userId}.jpg?v=${updatedAt.getTime()}`;
}
