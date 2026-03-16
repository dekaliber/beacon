import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const categoryRoutes = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  kind: z.enum(["EXPENSE", "INCOME"]).optional().default("EXPENSE"),
  parentId: z.string().nullable().optional(),
  ignoreInBudget: z.boolean().optional(),
});

// List all categories (tree structure)
categoryRoutes.get("/", async (req, res) => {
  const where: Record<string, unknown> = { parentId: null };
  if (req.query.kind) where.kind = req.query.kind;

  const categories = await prisma.category.findMany({
    where,
    include: { children: true },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

// List flat categories (for dropdowns)
categoryRoutes.get("/flat", async (req, res) => {
  const where: Record<string, unknown> = {};
  if (req.query.kind) where.kind = req.query.kind;

  const categories = await prisma.category.findMany({
    where,
    include: { parent: true },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

// Get usage count for a category (how many expenses/incomes reference it)
categoryRoutes.get("/:id/usage", async (req, res) => {
  const category = await prisma.category.findUnique({
    where: { id: req.params.id },
    include: { children: true },
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  // Count records for this category and all its children
  const categoryIds = [category.id, ...(category.children?.map((c) => c.id) ?? [])];

  const [expenseCount, incomeCount] = await Promise.all([
    prisma.expense.count({ where: { categoryId: { in: categoryIds } } }),
    prisma.income.count({ where: { categoryId: { in: categoryIds } } }),
  ]);

  res.json({ count: expenseCount + incomeCount, categoryIds });
});

// Bulk sync categories to match a desired structure
const syncSchema = z.object({
  categories: z.record(z.string(), z.array(z.string())),
});

categoryRoutes.post("/sync", async (req, res) => {
  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const desired = parsed.data.categories; // { "ParentName": ["Sub1", "Sub2", ...] }

  // Get all existing expense categories
  const existingParents = await prisma.category.findMany({
    where: { parentId: null, kind: "EXPENSE" },
    include: { children: true },
  });

  const parentMap = new Map(existingParents.map((p) => [p.name, p]));
  const keptCategoryIds = new Set<string>();

  // Upsert parents and children
  for (const [parentName, subcategories] of Object.entries(desired)) {
    let parent = parentMap.get(parentName);
    if (!parent) {
      parent = await prisma.category.create({
        data: { name: parentName, kind: "EXPENSE" },
        include: { children: true },
      });
    }
    keptCategoryIds.add(parent.id);

    const childMap = new Map((parent.children ?? []).map((c) => [c.name, c]));

    for (const subName of subcategories) {
      let child = childMap.get(subName);
      if (!child) {
        child = await prisma.category.create({
          data: { name: subName, parentId: parent.id, kind: "EXPENSE" },
        });
      } else if (child.parentId !== parent.id) {
        child = await prisma.category.update({
          where: { id: child.id },
          data: { parentId: parent.id },
        });
      }
      keptCategoryIds.add(child.id);
    }

    // Remove children of this parent that aren't in the desired list
    for (const existingChild of parent.children ?? []) {
      if (!keptCategoryIds.has(existingChild.id)) {
        await prisma.expense.updateMany({
          where: { categoryId: existingChild.id },
          data: { categoryId: null },
        });
        await prisma.category.delete({ where: { id: existingChild.id } });
      }
    }
  }

  // Remove parent categories that aren't in the desired list
  for (const existing of existingParents) {
    if (!keptCategoryIds.has(existing.id)) {
      const childIds = (existing.children ?? []).map((c) => c.id);
      const allIds = [existing.id, ...childIds];
      await prisma.expense.updateMany({
        where: { categoryId: { in: allIds } },
        data: { categoryId: null },
      });
      if (childIds.length > 0) {
        await prisma.category.deleteMany({ where: { id: { in: childIds } } });
      }
      await prisma.category.delete({ where: { id: existing.id } });
    }
  }

  // Return the updated tree
  const updated = await prisma.category.findMany({
    where: { parentId: null, kind: "EXPENSE" },
    include: { children: true },
    orderBy: { name: "asc" },
  });

  res.json(updated);
});

// Create category
categoryRoutes.post("/", async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await prisma.category.create({ data: parsed.data });
  res.status(201).json(category);
});

// Update category
categoryRoutes.put("/:id", async (req, res) => {
  const parsed = categorySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await prisma.category.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(category);
});

// Delete category with optional reassignment
categoryRoutes.delete("/:id", async (req, res) => {
  const reassignTo = req.query.reassignTo as string | undefined;

  const category = await prisma.category.findUnique({
    where: { id: req.params.id },
    include: { children: true },
  });

  if (!category) return res.status(404).json({ error: "Category not found" });

  // Collect all category IDs to delete (this category + its children)
  const categoryIds = [category.id, ...(category.children?.map((c) => c.id) ?? [])];

  // Reassign or nullify expenses and incomes in parallel
  const newCategoryId = reassignTo ?? null;
  await Promise.all([
    prisma.expense.updateMany({
      where: { categoryId: { in: categoryIds } },
      data: { categoryId: newCategoryId },
    }),
    prisma.income.updateMany({
      where: { categoryId: { in: categoryIds } },
      data: { categoryId: newCategoryId },
    }),
  ]);

  // Delete children first, then the parent
  if (category.children.length > 0) {
    await prisma.category.deleteMany({
      where: { id: { in: category.children.map((c) => c.id) } },
    });
  }

  await prisma.category.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
