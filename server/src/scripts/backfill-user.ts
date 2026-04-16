/**
 * One-time backfill: stamp the Clerk userId on all existing records so they
 * become visible to the authenticated user after the multi-user migration.
 *
 * Run with:
 *   CLERK_USER_ID=user_xxxxxxxxxxxx npx tsx src/scripts/backfill-user.ts
 *
 * The CLERK_USER_ID is the `id` field from your Clerk dashboard (Users tab).
 * It looks like: user_2abc123def456ghi789
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const userId = process.env.CLERK_USER_ID;
  if (!userId) {
    console.error("Error: CLERK_USER_ID environment variable is required.");
    console.error("Usage: CLERK_USER_ID=user_xxx npx tsx src/scripts/backfill-user.ts");
    process.exit(1);
  }

  console.log(`Backfilling userId=${userId} on all existing records...`);

  const [
    accounts,
    categories,
    tags,
    annualBudgets,
    budgetSettings,
    investmentSettings,
    assetClasses,
    recurrenceRules,
    transferRules,
    assetClassTargets,
  ] = await Promise.all([
    prisma.account.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.category.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.tag.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.annualBudget.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.budgetSettings.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.investmentSettings.updateMany({ where: { userId: null }, data: { userId } }),
    // Only user-created asset classes (system classes stay userId=null)
    prisma.assetClass.updateMany({ where: { userId: null, isSystem: false }, data: { userId } }),
    prisma.recurrenceRule.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.transferRule.updateMany({ where: { userId: null }, data: { userId } }),
    // Backfill asset class targets (user's target allocations for each asset class)
    prisma.assetClassTarget.updateMany({ where: { userId: null }, data: { userId } }),
  ]);

  console.log("Updated:");
  console.log(`  accounts:          ${accounts.count}`);
  console.log(`  categories:        ${categories.count}`);
  console.log(`  tags:              ${tags.count}`);
  console.log(`  annualBudgets:     ${annualBudgets.count}`);
  console.log(`  budgetSettings:    ${budgetSettings.count}`);
  console.log(`  investmentSettings:${investmentSettings.count}`);
  console.log(`  assetClasses:      ${assetClasses.count} (user-created only)`);
  console.log(`  recurrenceRules:   ${recurrenceRules.count}`);
  console.log(`  transferRules:     ${transferRules.count}`);
  console.log(`  assetClassTargets: ${assetClassTargets.count}`);
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
