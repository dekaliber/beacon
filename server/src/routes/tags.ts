import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const tagRoutes = Router();

const tagSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

// List all tags
tagRoutes.get("/", async (_req, res) => {
  const tags = await prisma.tag.findMany({ orderBy: { name: "asc" } });
  res.json(tags);
});

// Create tag
tagRoutes.post("/", async (req, res) => {
  const parsed = tagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.tag.findUnique({ where: { name: parsed.data.name } });
  if (existing) return res.status(409).json({ error: "A tag with this name already exists" });

  const tag = await prisma.tag.create({ data: parsed.data });
  res.status(201).json(tag);
});

// Update tag
tagRoutes.put("/:id", async (req, res) => {
  const parsed = tagSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.name) {
    const existing = await prisma.tag.findFirst({
      where: { name: parsed.data.name, NOT: { id: req.params.id } },
    });
    if (existing) return res.status(409).json({ error: "A tag with this name already exists" });
  }

  const tag = await prisma.tag.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(tag);
});

// Delete tag (cascades to join tables via DB)
tagRoutes.delete("/:id", async (req, res) => {
  await prisma.tag.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
