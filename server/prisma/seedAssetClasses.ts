/**
 * Idempotent seed for the built-in asset class taxonomy.
 * Safe to run multiple times (runs on every deploy) — uses upsert on slug.
 *
 * Hierarchy:
 *   US Stocks         → Large Cap, Mid Cap, Small Cap
 *   International Stocks → Developed Markets, Emerging Markets
 *   US Bonds          → Government, Corporate, Municipal
 *   International Bonds → Government, Corporate
 *   Real Estate       (leaf)
 *   Gold              (leaf)
 *   Venture           (leaf)
 *   Crypto            (leaf)
 *   Cash              (leaf — no children)
 *
 * Targets and instrument weights reference asset classes by row id, so classes
 * are restructured IN PLACE (slug rename + re-parent) rather than recreated —
 * deleting a class cascades away every target and weight that points at it.
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
  { name: "Real Estate", slug: "real-estate", color: "#d97706", displayOrder: 4, children: [] },
  { name: "Gold",        slug: "gold",        color: "#eab308", displayOrder: 5, children: [] },
  { name: "Venture",     slug: "venture",     color: "#db2777", displayOrder: 6, children: [] },
  { name: "Crypto",      slug: "crypto",      color: "#ea580c", displayOrder: 7, children: [] },
  { name: "Cash",        slug: "cash",        color: "#6b7280", displayOrder: 8, children: [] },
];

// Former Alternatives children promoted to top level. Renaming the slug on the
// existing row keeps its id, so user targets and ticker weights carry over.
const SLUG_RENAMES: [from: string, to: string][] = [
  ["alt-real-estate", "real-estate"],
  ["alt-gold",        "gold"],
];

// Specific ticker weights to move off a retired class before it is removed.
const WEIGHT_MOVES: { ticker: string; from: string; to: string }[] = [
  { ticker: "VCX", from: "alt-other", to: "venture" },
];

// Retired system classes, children before parent. Each is deleted only when
// nothing references it any more — never silently cascade-delete user data.
const RETIRED_SLUGS = ["alt-commodities", "alt-energy", "alt-other", "alternatives"];

async function renameSlugs(prisma: PrismaClient) {
  for (const [from, to] of SLUG_RENAMES) {
    const old = await prisma.assetClass.findUnique({ where: { slug: from } });
    if (!old) continue; // already migrated (or fresh DB)
    const clash = await prisma.assetClass.findUnique({ where: { slug: to } });
    if (clash) {
      console.warn(`  ! Both "${from}" and "${to}" exist — leaving "${from}" in place`);
      continue;
    }
    await prisma.assetClass.update({ where: { id: old.id }, data: { slug: to, parentId: null } });
    console.log(`  Promoted "${from}" → top-level "${to}" (id kept)`);
  }
}

async function moveWeights(prisma: PrismaClient) {
  for (const { ticker, from, to } of WEIGHT_MOVES) {
    const [src, dst, instrument] = await Promise.all([
      prisma.assetClass.findUnique({ where: { slug: from } }),
      prisma.assetClass.findUnique({ where: { slug: to } }),
      prisma.instrument.findUnique({ where: { primaryTicker: ticker } }),
    ]);
    if (!src || !dst || !instrument) continue;
    const weight = await prisma.instrumentAssetClassWeight.findUnique({
      where: { instrumentId_assetClassId: { instrumentId: instrument.id, assetClassId: src.id } },
    });
    if (!weight) continue;
    const existing = await prisma.instrumentAssetClassWeight.findUnique({
      where: { instrumentId_assetClassId: { instrumentId: instrument.id, assetClassId: dst.id } },
    });
    await prisma.$transaction([
      existing
        ? prisma.instrumentAssetClassWeight.update({
            where: { id: existing.id },
            data: { weight: Number(existing.weight) + Number(weight.weight) },
          })
        : prisma.instrumentAssetClassWeight.create({
            data: { instrumentId: instrument.id, assetClassId: dst.id, weight: weight.weight },
          }),
      prisma.instrumentAssetClassWeight.delete({ where: { id: weight.id } }),
    ]);
    console.log(`  Moved ${ticker} weight "${from}" → "${to}"`);
  }
}

async function retireClasses(prisma: PrismaClient) {
  for (const slug of RETIRED_SLUGS) {
    const ac = await prisma.assetClass.findUnique({
      where: { slug },
      include: { _count: { select: { children: true, targets: true, instrumentWeights: true } } },
    });
    if (!ac) continue;
    const { children, targets, instrumentWeights } = ac._count;
    if (children + targets + instrumentWeights > 0) {
      console.warn(
        `  ! Keeping retired class "${slug}" — still referenced ` +
          `(${children} children, ${targets} targets, ${instrumentWeights} weights)`,
      );
      continue;
    }
    await prisma.assetClass.delete({ where: { id: ac.id } });
    console.log(`  Removed retired class "${slug}"`);
  }
}

export async function seedAssetClasses(prisma: PrismaClient) {
  console.log("Seeding system asset classes...");

  await renameSlugs(prisma);

  for (const top of taxonomy) {
    // Color is a default only: users can recolor system classes, so never
    // overwrite an existing color (promoted children start with none).
    let parent = await prisma.assetClass.upsert({
      where: { slug: top.slug },
      update: { name: top.name, displayOrder: top.displayOrder, parentId: null },
      create: {
        name: top.name,
        slug: top.slug,
        color: top.color,
        isSystem: true,
        displayOrder: top.displayOrder,
      },
    });
    if (!parent.color) {
      parent = await prisma.assetClass.update({ where: { id: parent.id }, data: { color: top.color } });
    }

    for (const child of top.children) {
      await prisma.assetClass.upsert({
        where: { slug: child.slug },
        update: { name: child.name, displayOrder: child.displayOrder, parentId: parent.id },
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

  await moveWeights(prisma);
  await retireClasses(prisma);

  const count = await prisma.assetClass.count({ where: { isSystem: true } });
  console.log(`Done. ${count} system asset classes in database.`);
}
