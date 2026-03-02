import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const transactionGroupRoutes = Router();

const groupSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
});

const memberSchema = z.object({
  expenseIds: z.array(z.string()).optional(),
  incomeIds: z.array(z.string()).optional(),
});

// List all transaction groups with their members
transactionGroupRoutes.get("/", async (_req, res) => {
  const groups = await prisma.transactionGroup.findMany({
    include: {
      expenses: { include: { category: true, account: true } },
      incomes: { include: { account: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(groups);
});

// Get single group
transactionGroupRoutes.get("/:id", async (req, res) => {
  const group = await prisma.transactionGroup.findUnique({
    where: { id: req.params.id },
    include: {
      expenses: { include: { category: true, account: true } },
      incomes: { include: { account: true } },
    },
  });
  if (!group) return res.status(404).json({ error: "Transaction group not found" });
  res.json(group);
});

// Create group (optionally with initial member IDs)
transactionGroupRoutes.post("/", async (req, res) => {
  const parsedMeta = groupSchema.safeParse(req.body);
  if (!parsedMeta.success) return res.status(400).json({ error: parsedMeta.error.flatten() });

  const parsedMembers = memberSchema.safeParse(req.body);
  const { expenseIds = [], incomeIds = [] } = parsedMembers.success ? parsedMembers.data : {};

  const group = await prisma.transactionGroup.create({
    data: {
      ...parsedMeta.data,
      ...(expenseIds.length ? { expenses: { connect: expenseIds.map((id) => ({ id })) } } : {}),
      ...(incomeIds.length ? { incomes: { connect: incomeIds.map((id) => ({ id })) } } : {}),
    },
    include: {
      expenses: { include: { category: true, account: true } },
      incomes: { include: { account: true } },
    },
  });
  res.status(201).json(group);
});

// Update group name/notes
transactionGroupRoutes.put("/:id", async (req, res) => {
  const parsed = groupSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const group = await prisma.transactionGroup.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: {
      expenses: { include: { category: true, account: true } },
      incomes: { include: { account: true } },
    },
  });
  res.json(group);
});

// Add/remove members from a group
transactionGroupRoutes.patch("/:id/members", async (req, res) => {
  const schema = z.object({
    addExpenseIds: z.array(z.string()).optional(),
    removeExpenseIds: z.array(z.string()).optional(),
    addIncomeIds: z.array(z.string()).optional(),
    removeIncomeIds: z.array(z.string()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { addExpenseIds = [], removeExpenseIds = [], addIncomeIds = [], removeIncomeIds = [] } = parsed.data;

  const group = await prisma.transactionGroup.update({
    where: { id: req.params.id },
    data: {
      expenses: {
        connect: addExpenseIds.map((id) => ({ id })),
        disconnect: removeExpenseIds.map((id) => ({ id })),
      },
      incomes: {
        connect: addIncomeIds.map((id) => ({ id })),
        disconnect: removeIncomeIds.map((id) => ({ id })),
      },
    },
    include: {
      expenses: { include: { category: true, account: true } },
      incomes: { include: { account: true } },
    },
  });
  res.json(group);
});

// Delete group (unlinks members, does not delete them)
transactionGroupRoutes.delete("/:id", async (req, res) => {
  await prisma.transactionGroup.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
