# Smittenz API

Node.js + Express + MongoDB + Prisma. JWT auth with refresh tokens.

## Database setup

### Local MongoDB (recommended)

Data is stored at `/Smitten/dbdata/mongo`.

1. Start MongoDB:

```bash
/Smitten/appsdata/mongodb/start.sh
```

2. Copy `.env.example` to `.env` — `DATABASE_URL` points to local MongoDB.

3. Apply schema:

```bash
npm run db:push
```

### Docker alternative

```bash
docker compose up -d
mongosh --eval 'rs.initiate()'
npm run db:push
```

## Local API

1. Ensure MongoDB is running (`start.sh` above).
2. Copy `.env.example` to `.env`.
3. Apply schema: `npm run db:push`
4. Run the API:

```bash
npm run dev
```

API base: `http://localhost:4000`  
Health: `GET /health`

## Mobile app connection

- **Android emulator:** `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000`
- **Physical device:** use your PC LAN IP, e.g. `EXPO_PUBLIC_API_URL=http://192.168.1.10:4000`

Add to the project root `.env` (Expo loads `EXPO_PUBLIC_*`).

## PhonePe (receive-only)

Set all `PHONEPE_*` variables in `backend/.env` (see `.env.example`). Credentials stay on the server only.

| Step | Endpoint |
|------|----------|
| Start checkout | `POST /api/v1/payments/initiate` `{ "plan": "monthly" \| "quarterly" }` |
| Poll status | `GET /api/v1/payments/verify/:merchantOrderId` |
| Webhook (PhonePe dashboard) | `POST /api/v1/webhooks/phonepe` |
| Local dev without PhonePe | `POST /api/v1/payments/mock-checkout` |

Webhook username/password in the dashboard must match `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD`.

### Local sandbox (Zelton-style — no tunnel)

Leave redirect empty and poll (same as Zelton):

```env
PHONEPE_REDIRECT_BASE_URL=
```

Restart the API. On the PhonePe page pick **Debit/Credit Card** or **Net Banking** (not UPI PhonePe). Test card: `4242 4242 4242 4242`, OTP `123456`. Return to the app — polling confirms payment.

Do **not** use `http://192.168.x.x` or `https://192.168.x.x` — PhonePe cannot reach your LAN.

### Optional: HTTPS redirect page

If you want a browser redirect after pay:

```bash
cd backend && npm run phonepe:tunnel
# or: npm run phonepe:tunnel:ngrok  (uses @expo/ngrok from the repo root)
```

Set `PHONEPE_REDIRECT_BASE_URL=https://….loca.lt` (or ngrok URL) and whitelist `…/payment-complete` in the PhonePe dashboard.

## Auth flow (phase 1)

| Step | Endpoint |
|------|----------|
| Register | `POST /api/v1/auth/register` |
| Login | `POST /api/v1/auth/login` |
| Pay + get key | PhonePe initiate → verify, or mock-checkout |
| Validate partner key | `POST /api/v1/couple/validate-key` |
| Partner join | `POST /api/v1/couple/join` |
| Session | `GET /api/v1/auth/me` |
