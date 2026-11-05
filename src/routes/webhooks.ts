import { Router } from 'express';
import { isPhonePeConfigured } from '../config.js';
import { processPhonePeWebhook } from '../services/phonepeService.js';

const router = Router();

/** PhonePe server-to-server callback — must receive raw body string for signature validation. */
router.post('/phonepe', async (req, res) => {
  if (!isPhonePeConfigured()) {
    res.status(503).json({ error: 'PhonePe not configured' });
    return;
  }

  const authorization = req.get('authorization') ?? req.get('Authorization') ?? '';
  const rawBody = typeof req.body === 'string' ? req.body : '';

  if (!rawBody) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }

  const result = await processPhonePeWebhook(authorization, rawBody);
  if (!result.ok) {
    res.status(400).json({ error: result.error ?? 'Invalid callback' });
    return;
  }

  res.json({ ok: true });
});

export default router;
