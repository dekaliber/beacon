/**
 * Idempotent seed for the built-in asset class taxonomy.
 * Safe to run multiple times — uses upsert on slug.
 *
 * Hierarchy:
 *   US Stocks         → Large Cap, Mid Cap, Small Cap
 *   International Stocks → Developed Markets, Emerging Markets
 *   US Bonds          → Government, Corporate, Municipal
 *   International Bonds → Government, Corporate
 *   Alternatives      → Real Estate, Commodities, Gold, Energy, Other
 *   Cash              (leaf — no children)
 */

import type { PrismaClient } from "@prisma/client";

const taxonomy = [
  {
    name: "US Stocks",
    slug: "us-stocks",
    color: "#4f46e5",
    displayOrder: 0,
    children: [
      { name: "Large Cap", slug: "us-large-cap", displayOrder: 0 },
      { name: "Mid Cap",   slug: "us-mid-cap",   displayOrder: 1 },
      { name: "Small Cap", slug: "us-small-cap", displayOrder: 2 },
    ],
  },
  {
    name: "International Stocks",
    slug: "intl-stocks",
    color: "#0891b2",
    displayOrder: 1,
    children: [
      { name: "Developed Markets", slug: "intl-developed", displayOrder: 0 },
      { name: "Emerging Markets",  slug: "intl-emerging",  displayOrder: 1 },
    ],
  },
  {
    name: "US Bonds",
    slug: "us-bonds",
    color: "#059669",
    displayOrder: 2,
    children: [
      { name: "Government", slug: "us-bonds-govt", displayOrder: 0 },
      { name: "Corporate",  slug: "us-bonds-corp", displayOrder: 1 },
      { name: "Municipal",  slug: "us-bonds-muni", displayOrder: 2 },
    ],
  },
  {
    name: "International Bonds",
    slug: "intl-bonds",
    color: "#16a34a",
    displayOrder: 3,
    children: [
      { name: "Government", slug: "intl-bonds-govt", displayOrder: 0 },
      { name: "Corporate",  slug: "intl-bonds-corp", displayOrder: 1 },
    ],
  },
  {
    name: "Alternatives",
    slug: "alternatives",
    color: "#d97706",
    displayOrder: 4,
    children: [
      { name: "Real Estate", slug: "alt-real-estate",  displayOrder: 0 },
      { name: "Commodities", slug: "alt-commodities",  displayOrder: 1 },
      { name: "Gold",        slug: "alt-gold",         displayOrder: 2 },
      { name: "Energy",      slug: "alt-energy",       displayOrder: 3 },
      { name: "Other",       slug: "alt-other",        displayOrder: 4 },
    ],
  },
  {
    name: "Cash",
    slug: "cash",
    color: "#6b7280",
    displayOrder: 5,
    children: [],
  },
];

export async function seedAssetClasses(prisma: PrismaClient) {
  console.log("Seeding system asset classes...");

  for (const top of taxonomy) {
    const parent = await prisma.assetClass.upsert({
      where: { slug: top.slug },
      update: { name: top.name, color: top.color, displayOrder: top.displayOrder },
      create: {
        name: top.name,
        slug: top.slug,
        color: top.color,
        isSystem: true,
        displayOrder: top.displayOrder,
      },
    });

    for (const child of top.children) {
      await prisma.assetClass.upsert({
        where: { slug: child.slug },
        update: { name: child.name, displayOrder: child.displayOrder },
        create: {
          name: child.name,
          slug: child.slug,
          isSystem: true,
          parentId: parent.id,
          displayOrder: child.displayOrder,
        },
      });
    }
  }

  const count = await prisma.assetClass.count({ where: { isSystem: true } });
  console.log(`Done. ${count} system asset classes in database.`);
}

