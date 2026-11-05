import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- CLEARING DATABASE ROWS ---');

  // Deleting records from tables in correct order of dependency (foreign keys)
  try {
    const deletedTicTacToes = await prisma.ticTacToe.deleteMany({});
    console.log(`Deleted ${deletedTicTacToes.count} TicTacToe games`);

    const deletedChallenges = await prisma.loveChallenge.deleteMany({});
    console.log(`Deleted ${deletedChallenges.count} LoveChallenge items`);

    const deletedRefreshTokens = await prisma.refreshToken.deleteMany({});
    console.log(`Deleted ${deletedRefreshTokens.count} RefreshTokens`);

    const deletedPasswordResetTokens = await prisma.passwordResetToken.deleteMany({});
    console.log(`Deleted ${deletedPasswordResetTokens.count} PasswordResetTokens`);

    const deletedEmailVerificationTokens = await prisma.emailVerificationToken.deleteMany({});
    console.log(`Deleted ${deletedEmailVerificationTokens.count} EmailVerificationTokens`);

    const deletedPayments = await prisma.payment.deleteMany({});
    console.log(`Deleted ${deletedPayments.count} Payments`);

    const deletedSubscriptions = await prisma.subscription.deleteMany({});
    console.log(`Deleted ${deletedSubscriptions.count} Subscriptions`);

    const deletedMessages = await prisma.message.deleteMany({});
    console.log(`Deleted ${deletedMessages.count} Messages`);

    const deletedSpecialMoments = await prisma.specialMoment.deleteMany({});
    console.log(`Deleted ${deletedSpecialMoments.count} SpecialMoments`);

    const deletedNotes = await prisma.note.deleteMany({});
    console.log(`Deleted ${deletedNotes.count} Notes`);

    const deletedMemories = await prisma.memory.deleteMany({});
    console.log(`Deleted ${deletedMemories.count} Memories`);

    const deletedVaultItems = await prisma.vaultItem.deleteMany({});
    console.log(`Deleted ${deletedVaultItems.count} VaultItems`);

    const deletedLovePings = await prisma.lovePing.deleteMany({});
    console.log(`Deleted ${deletedLovePings.count} LovePings`);

    // Remove users before couples or set user foreign keys to null
    const deletedUsers = await prisma.user.deleteMany({});
    console.log(`Deleted ${deletedUsers.count} Users`);

    const deletedCouples = await prisma.couple.deleteMany({});
    console.log(`Deleted ${deletedCouples.count} Couples`);

    console.log('Database rows cleared successfully!');
  } catch (error) {
    console.error('Error clearing database rows:', error);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
