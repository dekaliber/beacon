import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const desiredCategories: Record<string, string[]> = {
  "Auto": ["Auto Insurance", "Auto Payment", "Auto Registration", "Fuel & Charging", "Maintenance & Service", "Parking", "Parts & Supplies"],
  "Business": ["Business Expenses", "CPA", "Rental Expense"],
  "Cash": ["Cash & ATM"],
  "Cash Back": ["Rewards Programs", "Statement Credits"],
  "Dining": ["Drinks", "Fast Food", "Food Delivery", "Restaurants"],
  "Entertainment": ["Concerts & Events", "Entertainment", "Movies & Concessions", "Music", "Streaming", "Video Games"],
  "Gifts & Donations": ["Donations", "Gifts"],
  "Groceries": ["Groceries"],
  "Health & Wellness": ["Gym & Fitness", "Health Insurance", "Medical Office Visits", "Medication & Prescriptions", "Supplements & Nutrition"],
  "Housing": ["Home Insurance", "Home Services", "Household Supplies", "Mortgage & HOA", "Rent"],
  "Miscellaneous": ["Fees", "Government Services", "Postage & Shipping", "Repairs"],
  "Personal Care": ["Dry Cleaning", "Haircut", "Massage & Spa"],
  "Pets": ["Pet Food & Supplies", "Pet Sitting", "Veterinary"],
  "Shopping": ["Art", "Clothing", "Electronics", "Furniture & Home", "Hobbies", "Reselling", "Shopping", "Sporting Goods"],
  "Subscriptions": ["Publications", "Software Subscriptions", "Subscriptions", "Web Hosting"],
  "Taxes": ["Taxes"],
  "Travel": ["Car Rental", "Flights", "Hotel", "Public Transportation", "Rideshare & Taxi", "Travel"],
  "Utilities": ["Utilities"],
};

async function main() {
  console.log("Syncing categories...");

  // Get all existing categories
  const existingParents = await prisma.category.findMany({
    where: { parentId: null },
    include: { children: true },
  });

  const parentMap = new Map(existingParents.map((p) => [p.name, p]));
  const keptCategoryIds = new Set<string>();

  // Upsert parents and children
  for (const [parentName, subcategories] of Object.entries(desiredCategories)) {
    let parent = parentMap.get(parentName);
    if (!parent) {
      const created = await prisma.category.create({
        data: { name: parentName },
      });
      parent = { ...created, children: [] };
      console.log(`  + Created parent: ${parentName}`);
    } else {
      console.log(`  = Kept parent: ${parentName}`);
    }
    keptCategoryIds.add(parent.id);

    const childMap = new Map((parent.children ?? []).map((c) => [c.name, c]));

    for (const subName of subcategories) {
      const child = childMap.get(subName);
      if (!child) {
        await prisma.category.create({
          data: { name: subName, parentId: parent.id },
        });
        console.log(`    + Created sub: ${subName}`);
      } else {
        if (child.parentId !== parent.id) {
          await prisma.category.update({
            where: { id: child.id },
            data: { parentId: parent.id },
          });
          console.log(`    ~ Moved sub: ${subName} -> ${parentName}`);
        } else {
          console.log(`    = Kept sub: ${subName}`);
        }
        keptCategoryIds.add(child.id);
      }
    }

    // Remove children of this parent that aren't in the desired list
    for (const existingChild of parent.children ?? []) {
      if (!keptCategoryIds.has(existingChild.id)) {
        const count = await prisma.expense.count({ where: { categoryId: existingChild.id } });
        if (count > 0) {
          await prisma.expense.updateMany({
            where: { categoryId: existingChild.id },
            data: { categoryId: null },
          });
          console.log(`    - Removed sub: ${existingChild.name} (${count} expenses set to uncategorized)`);
        } else {
          console.log(`    - Removed sub: ${existingChild.name}`);
        }
        await prisma.category.delete({ where: { id: existingChild.id } });
      }
    }
  }

  // Remove parent categories that aren't in the desired list
  for (const existing of existingParents) {
    if (!keptCategoryIds.has(existing.id)) {
      const childIds = (existing.children ?? []).map((c) => c.id);
      const allIds = [existing.id, ...childIds];
      const count = await prisma.expense.count({ where: { categoryId: { in: allIds } } });
      if (count > 0) {
        await prisma.expense.updateMany({
          where: { categoryId: { in: allIds } },
          data: { categoryId: null },
        });
        console.log(`  - Removed parent: ${existing.name} (${count} expenses set to uncategorized)`);
      } else {
        console.log(`  - Removed parent: ${existing.name}`);
      }
      if (childIds.length > 0) {
        await prisma.category.deleteMany({ where: { id: { in: childIds } } });
      }
      await prisma.category.delete({ where: { id: existing.id } });
    }
  }

  // Print summary
  const finalCategories = await prisma.category.findMany({
    where: { parentId: null },
    include: { children: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });

  console.log("\n--- Final Category Structure ---");
  for (const cat of finalCategories) {
    console.log(`${cat.name}`);
    for (const child of cat.children) {
      console.log(`  > ${child.name}`);
    }
  }
  console.log(`\nTotal: ${finalCategories.length} categories, ${finalCategories.reduce((sum, c) => sum + c.children.length, 0)} subcategories`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
