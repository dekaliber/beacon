import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";

export const tagRoutes = Router();

const tagSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  group: z.string().nullable().optional(),
});

// List all tags with expense totals
tagRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);
  const tags = await prisma.tag.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: {
      expenses: {
        include: {
          expense: {
            select: {
              date: true,
              amount: true,
              account: { select: { isJoint: true } },
              offsets: { select: { amount: true } },
            },
          },
        },
      },
    },
  });

  const result = tags.map((tag) => {
    let personalTotal = 0;
    let jointTotal = 0;
    let lastUsedAt: Date | null = null;
    for (const et of tag.expenses) {
      const offsetSum = et.expense.offsets.reduce((s, o) => s + Number(o.amount), 0);
      const amt = Number(et.expense.amount) + offsetSum;
      if (et.expense.account.isJoint) {
        jointTotal += amt;
      } else {
        personalTotal += amt;
      }
      if (!lastUsedAt || et.expense.date > lastUsedAt) lastUsedAt = et.expense.date;
    }
    const { expenses: _, ...rest } = tag;
    return { ...rest, personalTotal, jointTotal, lastUsedAt };
  });

  res.json(result);
});

// Orphaned offsets: tagged expenses that are offset children whose parent is NOT tagged with the same tag
tagRoutes.get("/:id/orphaned-offsets", async (req, res) => {
  const tagId = req.params.id;

  const offsets = await prisma.expense.findMany({
    where: {
      parentExpenseId: { not: null },
      tags: { some: { tagId } },
      parentExpense: { tags: { none: { tagId } } },
    },
    select: {
      id: true,
      amount: true,
      vendor: true,
      description: true,
      date: true,
      parentExpenseId: true,
      account: { select: { isJoint: true } },
      parentExpense: { select: { id: true, vendor: true, description: true } },
    },
    orderBy: { date: "asc" },
  });

  res.json(offsets);
});

// Create tag
tagRoutes.post("/", async (req, res) => {
  const userId = getUserId(req);
  const parsed = tagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.tag.findFirst({ where: { userId, name: parsed.data.name } });
  if (existing) return res.status(409).json({ error: "A tag with this name already exists" });

  const tag = await prisma.tag.create({ data: { ...parsed.data, userId } });
  res.status(201).json(tag);
});

// Update tag
tagRoutes.put("/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = tagSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.name) {
    const existing = await prisma.tag.findFirst({
      where: { userId, name: parsed.data.name, NOT: { id: req.params.id } },
    });
    if (existing) return res.status(409).json({ error: "A tag with this name already exists" });
  }

  const tag = await prisma.tag.updateMany({ where: { id: req.params.id, userId }, data: parsed.data });
  if (tag.count === 0) return res.status(404).json({ error: "Tag not found" });
  const updated = await prisma.tag.findUnique({ where: { id: req.params.id } });
  res.json(updated);
});

// Delete tag (cascades to join tables via DB)
tagRoutes.delete("/:id", async (req, res) => {
  const userId = getUserId(req);
  await prisma.tag.deleteMany({ where: { id: req.params.id, userId } });
  res.status(204).send();
});
