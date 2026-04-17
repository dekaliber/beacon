import { PrismaClient } from "@prisma/client";
import { seedAssetClasses } from "./seedAssetClasses";

const prisma = new PrismaClient();

const defaultCategories = [
  { name: "Auto", children: ["Auto Insurance", "Auto Payment", "Auto Registration", "Fuel & Charging", "Maintenance & Service", "Parking", "Parts & Supplies"] },
  { name: "Business", children: ["Business Expenses", "CPA", "Rental Expense"] },
  { name: "Cash", children: ["Cash & ATM"] },
  { name: "Cash Back", children: ["Rewards Programs", "Statement Credits"] },
  { name: "Dining", children: ["Drinks", "Fast Food", "Food Delivery", "Restaurants"] },
  { name: "Entertainment", children: ["Concerts & Events", "Entertainment", "Movies & Concessions", "Music", "Streaming", "Video Games"] },
  { name: "Gifts & Donations", children: ["Donations", "Gifts"] },
  { name: "Groceries", children: ["Groceries"] },
  { name: "Health & Wellness", children: ["Gym & Fitness", "Health Insurance", "Medical Office Visits", "Medication & Prescriptions", "Supplements & Nutrition"] },
  { name: "Housing", children: ["Home Insurance", "Home Services", "Household Supplies", "Mortgage & HOA", "Rent"] },
  { name: "Miscellaneous", children: ["Fees", "Government Services", "Postage & Shipping", "Repairs"] },
  { name: "Personal Care", children: ["Dry Cleaning", "Haircut", "Massage & Spa"] },
  { name: "Pets", children: ["Pet Food & Supplies", "Pet Sitting", "Veterinary"] },
  { name: "Shopping", children: ["Art", "Clothing", "Electronics", "Furniture & Home", "Hobbies", "Reselling", "Shopping", "Sporting Goods"] },
  { name: "Subscriptions", children: ["Publications", "Software Subscriptions", "Subscriptions", "Web Hosting"] },
  { name: "Taxes", children: ["Taxes"] },
  { name: "Travel", children: ["Car Rental", "Flights", "Hotel", "Public Transportation", "Rideshare & Taxi", "Travel"] },
  { name: "Utilities", children: ["Utilities"] },
];

async function main() {
  console.log("Seeding database...");

  for (const cat of defaultCategories) {
    const parent = await prisma.category.create({
      data: {
        name: cat.name,
        isDefault: true,
      },
    });

    for (const childName of cat.children) {
      await prisma.category.create({
        data: {
          name: childName,
          parentId: parent.id,
          isDefault: true,
        },
      });
    }
  }

  // Create default accounts
  await prisma.account.create({
    data: { name: "Checking Account", type: "CHECKING" },
  });
  await prisma.account.create({
    data: { name: "Savings Account", type: "SAVINGS" },
  });
  await prisma.account.create({
    data: { name: "Credit Card", type: "CREDIT_CARD" },
  });
  await prisma.account.create({
    data: { name: "Cash", type: "CASH" },
  });

  await seedAssetClasses(prisma);

  console.log("Seeding complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
