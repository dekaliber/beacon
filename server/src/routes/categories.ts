import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const categoryRoutes = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  parentId: z.string().nullable().optional(),
});

// List all categories (tree structure)
categoryRoutes.get("/", async (_req, res) => {
  const categories = await prisma.category.findMany({
    where: { parentId: null },
    include: { children: true },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

// List flat categories (for dropdowns)
categoryRoutes.get("/flat", async (_req, res) => {
  const categories = await prisma.category.findMany({
    include: { parent: true },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

// Get usage count for a category (how many expenses reference it)
categoryRoutes.get("/:id/usage", async (req, res) => {
  const category = await prisma.category.findUnique({
    where: { id: req.params.id },
    include: { children: true },
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  // Count expenses for this category and all its children
  const categoryIds = [category.id, ...(category.children?.map((c) => c.id) ?? [])];
  const count = await prisma.expense.count({
    where: { categoryId: { in: categoryIds } },
  });

  res.json({ count, categoryIds });
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

  // Reassign or nullify expenses
  if (reassignTo) {
    await prisma.expense.updateMany({
      where: { categoryId: { in: categoryIds } },
      data: { categoryId: reassignTo },
    });
  } else {
    await prisma.expense.updateMany({
      where: { categoryId: { in: categoryIds } },
      data: { categoryId: null },
    });
  }

  // Delete children first, then the parent
  if (category.children.length > 0) {
    await prisma.category.deleteMany({
      where: { id: { in: category.children.map((c) => c.id) } },
    });
  }

  await prisma.category.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
