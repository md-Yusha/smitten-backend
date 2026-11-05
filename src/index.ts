import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { setCoupleIo } from './lib/coupleEvents.js';
import { setChatIo } from './routes/chat.js';
import { setGamesIo } from './routes/games.js';
import { expireDueSubscriptions, sendSubscriptionRenewalReminders } from './services/subscriptions.js';
import { attachSocket } from './socket.js';

const app = createApp();
const httpServer = createServer(app);
const io = attachSocket(httpServer);
setCoupleIo(io);
setChatIo(io);
setGamesIo(io);

httpServer.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Smittenz API listening on http://0.0.0.0:${config.PORT} (HTTP + WebSocket)`);
});

async function runSubscriptionMaintenance() {
  await expireDueSubscriptions();
  await sendSubscriptionRenewalReminders();
}

void runSubscriptionMaintenance().catch((err) => console.warn('[subscriptions] maintenance failed', err));
setInterval(() => {
  void runSubscriptionMaintenance().catch((err) => console.warn('[subscriptions] maintenance failed', err));
}, 60 * 60 * 1000);
