import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const defaultCategories = [
  { name: "Housing", icon: "home", color: "#4F46E5", children: ["Rent/Mortgage", "Utilities", "Insurance", "Maintenance"] },
  { name: "Transportation", icon: "car", color: "#0891B2", children: ["Gas", "Public Transit", "Parking", "Car Payment", "Car Insurance"] },
  { name: "Food & Dining", icon: "utensils", color: "#059669", children: ["Groceries", "Restaurants", "Coffee", "Delivery"] },
  { name: "Healthcare", icon: "heart-pulse", color: "#DC2626", children: ["Doctor", "Dentist", "Pharmacy", "Insurance Premium"] },
  { name: "Entertainment", icon: "tv", color: "#7C3AED", children: ["Streaming", "Movies", "Games", "Events"] },
  { name: "Shopping", icon: "shopping-bag", color: "#DB2777", children: ["Clothing", "Electronics", "Home Goods"] },
  { name: "Personal", icon: "user", color: "#EA580C", children: ["Haircut", "Gym", "Subscriptions"] },
  { name: "Education", icon: "book", color: "#2563EB", children: ["Tuition", "Books", "Courses"] },
  { name: "Travel", icon: "plane", color: "#0D9488", children: ["Flights", "Hotels", "Activities"] },
  { name: "Financial", icon: "landmark", color: "#64748B", children: ["Credit Card Payments", "Loan Payments", "Fees"] },
  { name: "Other", icon: "ellipsis", color: "#6B7280", children: [] },
];

async function main() {
  console.log("Seeding database...");

  for (const cat of defaultCategories) {
    const parent = await prisma.category.create({
      data: {
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
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
