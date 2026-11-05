# Render PostgreSQL — shared dev database

Use one **Render free Postgres** instance so everyone on the team hits the same data (users, keys, couples).

> **Do not commit `backend/.env`.** Share the database URL privately (Signal, Discord DM, etc.).

---

## 1. Create the database (once, any teammate)

1. Sign in at [render.com](https://render.com).
2. **New +** → **PostgreSQL**.
3. Name: e.g. `smitten-dev`.
4. Region: pick one close to you (same for the whole team).
5. Plan: **Free**.
6. Create database.

After it’s ready, open the instance → **Connections**:

- Copy **External Database URL** (for laptops at home).
- Keep **Internal URL** for a future API hosted on Render only.

---

## 2. `backend/.env` on every machine

Paste the **External** URL and add SSL (required by Render):

```env
DATABASE_URL="postgresql://USER:PASSWORD@dpg-xxxxx-a.region-postgres.render.com/DATABASE?sslmode=require"
```

Use the exact URL from the dashboard; only ensure `?sslmode=require` is present (add `&schema=public` if you already have query params).

Keep the rest the same:

```env
JWT_ACCESS_SECRET="same-long-secret-on-all-dev-machines-min-32-chars"
JWT_REFRESH_SECRET="another-long-secret-min-32-chars"
JWT_ACCESS_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"
PORT=4000
CORS_ORIGIN="*"
```

**Tip:** Use the **same JWT secrets** on both PCs if you want refresh tokens to behave consistently when sharing test accounts (optional).

---

## 3. Apply schema (first time, once)

Whoever sets up the DB first:

```powershell
cd backend
npm install
npx prisma migrate deploy
```

Others only need `npm install` + the same `DATABASE_URL` — no second migrate unless new migrations were added in git.

---

## 4. Run the API locally

Each developer:

```powershell
cd backend
npm run dev
```

Both APIs talk to the **same** Render DB. Register on your laptop → your friend sees the same user if they call the API with the same DB.

---

## 5. Expo app (`d:\Smittenz\.env`)

`EXPO_PUBLIC_API_URL` points to **whoever’s API** the phone uses, not Postgres.

| Tester | Backend running on | Root `.env` |
|--------|-------------------|-------------|
| You, phone on Wi‑Fi | Your PC | `http://YOUR_LAN_IP:4000` |
| Friend, phone | Friend’s PC | `http://FRIEND_LAN_IP:4000` |
| Android emulator | Your PC | `http://10.0.2.2:4000` |

Same Render DB + different local APIs = **shared data**, separate API processes.

To use **one API URL** for both phones (e.g. only you run the server), deploy the backend to Render Web Service later and set:

`EXPO_PUBLIC_API_URL=https://your-api.onrender.com`

---

## 6. Free tier limits (know these)

- DB may **sleep** when idle; first request can be slow (~30s).
- Free Postgres on Render has a **90-day** lifetime unless upgraded — fine for early dev; plan a paid/migrated DB before launch.
- Don’t store production user data on free tier long term.

---

## Quick checklist

- [ ] Render Postgres created  
- [ ] External URL + `sslmode=require` in `backend/.env` (both devs)  
- [ ] `npx prisma migrate deploy` (once)  
- [ ] `npm run dev` in `backend/`  
- [ ] Root `.env` → `EXPO_PUBLIC_API_URL` for your phone/emulator  
- [ ] Restart Expo after changing root `.env`
