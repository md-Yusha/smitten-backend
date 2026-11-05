import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      expoPushToken: true,
      pushNotificationsEnabled: true
    }
  });

  console.log('--- USER PUSH TOKEN REGISTERED STATUS ---');
  for (const user of users) {
    console.log(`User: ${user.name} (${user.email})`);
    console.log(`  Push Enabled: ${user.pushNotificationsEnabled}`);
    console.log(`  Push Token  : ${user.expoPushToken}`);
    console.log('-----------------------------------------');
  }

  await prisma.$disconnect();
}

void main();
