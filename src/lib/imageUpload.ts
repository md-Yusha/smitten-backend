import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import multer, { type Multer } from 'multer';
import type { Request, Response, NextFunction } from 'express';

/** Vault files live outside public /uploads (encrypted, API-only access). */
export function createImageUpload(
  subfolder: string,
  options?: { privateStore?: boolean; allowVideo?: boolean; maxFileSizeMb?: number | null },
): Multer {
  const base = options?.privateStore ? 'data' : 'uploads';
  const dir = path.join(process.cwd(), base, subfolder);

  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        } catch (e) {
          cb(e instanceof Error ? e : new Error('Could not create upload folder'), '');
        }
      },
      filename: (_req, _file, cb) => {
        cb(null, `${randomBytes(12).toString('hex')}.media`);
      },
    }),
    ...(options?.maxFileSizeMb === null
      ? {}
      : { limits: { fileSize: (options?.maxFileSizeMb ?? 12) * 1024 * 1024 } }),
    fileFilter: (_req, file, cb) => {
      const mime = (file.mimetype ?? '').toLowerCase();
      const ok =
        !mime ||
        mime.startsWith('image/') ||
        (options?.allowVideo === true && mime.startsWith('video/')) ||
        mime === 'application/octet-stream' ||
        mime === 'binary/octet-stream';
      if (!ok) {
        cb(new Error(options?.allowVideo ? 'Only image and video files are allowed' : 'Only image files are allowed'));
        return;
      }
      cb(null, true);
    },
  });
}

/** Run multer and return JSON errors instead of crashing the request. */
export function multerSingle(field: string, upload: Multer) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (!err) {
        // Route handlers encrypt and remove successful uploads themselves. This
        // fallback covers every early return (auth/couple/schema/type failures)
        // so a plaintext multer file can never be left behind on disk.
        let cleaned = false;
        const cleanupTemporaryUpload = () => {
          if (cleaned) return;
          cleaned = true;
          const filePath = req.file?.path;
          if (!filePath) return;
          void fs.promises.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
              console.error('[upload] Could not remove temporary plaintext media', error);
            }
          });
        };
        res.once('finish', cleanupTemporaryUpload);
        res.once('close', cleanupTemporaryUpload);
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Media is too large after compression'
            : err.message;
        res.status(400).json({ error: msg });
        return;
      }
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Upload failed',
      });
    });
  };
}
