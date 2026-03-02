import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const categoryRoutes = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  parentId: z.string().optional(),
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

// Delete category
categoryRoutes.delete("/:id", async (req, res) => {
  // Move children to parent before deleting
  const category = await prisma.category.findUnique({
    where: { id: req.params.id },
    include: { children: true, expenses: true },
  });

  if (!category) return res.status(404).json({ error: "Category not found" });
  if (category.expenses.length > 0) {
    return res.status(400).json({ error: "Cannot delete a category with expenses. Reassign expenses first." });
  }

  // Reparent children
  if (category.children.length > 0) {
    await prisma.category.updateMany({
      where: { parentId: category.id },
      data: { parentId: category.parentId },
    });
  }

  await prisma.category.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
