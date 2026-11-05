import { config } from '../config.js';

export function buildPublicMediaUrl(relativePath: string): string {
  const configured = config.PUBLIC_API_URL?.trim();
  const base = (configured || `http://localhost:${config.PORT}`).replace(/\/$/, '');
  const path = relativePath.replace(/^\//, '');
  return `${base}/uploads/${path}`;
}
