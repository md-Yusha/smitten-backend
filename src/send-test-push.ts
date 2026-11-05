import { PrismaClient } from '@prisma/client';
import { sendExpoPush } from './services/pushNotifications.js';

const prisma = new PrismaClient();

async function main() {
  console.log('--- SEARCHING FOR REGISTERED DEVICE TOKENS ---');
  const targetEmail = process.env.TEST_PUSH_EMAIL?.trim() || process.argv[2]?.trim() || 'likith@gmail.com';
  let user = await prisma.user.findFirst({
    where: {
      email: targetEmail
    },
    select: {
      name: true,
      email: true,
      expoPushToken: true
    }
  });

  if (user) {
    if (!user.expoPushToken) {
      console.warn(`❌ User ${targetEmail} exists but has NO expoPushToken registered. check-tokens:`);
      const allTokens = await prisma.user.findMany({
        where: { expoPushToken: { not: null } },
        select: { name: true, email: true, expoPushToken: true }
      });
      console.log('All users with active tokens in database:');
      console.log(allTokens);
      await prisma.$disconnect();
      return;
    }
  } else {
    console.warn(`❌ User with email ${targetEmail} not found.`);
    const allTokens = await prisma.user.findMany({
      where: { expoPushToken: { not: null } },
      select: { name: true, email: true, expoPushToken: true },
    });
    console.log('All users with active tokens in database:');
    console.log(allTokens);
    console.log('Tip: run `TEST_PUSH_EMAIL=alex@gmail.com npm run db:test-push` or `npm run db:test-push -- alex@gmail.com`.');
    await prisma.$disconnect();
    return;
  }

  if (!user || !user.expoPushToken) {
    console.warn('❌ No user has registered a push token yet. Please open the new app, log in, and try again.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found registered device token for user: ${user.name} (${user.email})`);
  console.log(`Token: ${user.expoPushToken}`);
  console.log('Sending test push notification...');

  await sendExpoPush({
    to: user.expoPushToken,
    title: 'Hello from Smittenz! ❤️',
    body: 'This is a test system notification. If you see this, notifications are working perfectly!',
    sound: 'default',
    priority: 'high',
    channelId: 'messages',
    data: {
      type: 'chat_message'
    }
  });

  console.log('Test notification request sent to Expo gateway.');
  await prisma.$disconnect();
}

void main();
