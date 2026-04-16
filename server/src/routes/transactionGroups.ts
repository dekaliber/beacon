import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";

export const transactionGroupRoutes = Router();

// Shared include for returning a group with its expense members
const groupInclude = {
  expenses: {
    where: { parentExpenseId: null },
    include: { category: true, account: true, tags: { include: { tag: true } } },
  },
};

// Helper: auto-delete a group if it has 0 or 1 remaining members
async function cleanupGroup(groupId: string): Promise<void> {
  const count = await prisma.expense.count({
    where: { transactionGroupId: groupId, parentExpenseId: null },
  });
  if (count <= 1) {
    await prisma.transactionGroup.delete({ where: { id: groupId } });
  }
}

// GET / — lightweight list used by the client for group metadata
transactionGroupRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);
  const groups = await prisma.transactionGroup.findMany({
    where: { expenses: { some: { account: { userId } } } },
    select: { id: true, primaryExpenseId: true, notes: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(groups);
});

// POST / — create a new group from a set of expense IDs
// Body: { expenseIds: string[] }
// • Removes each expense from any pre-existing group first
// • Defaults primaryExpenseId to the oldest expense in the set
transactionGroupRoutes.post("/", async (req, res) => {
  const userId = getUserId(req);
  const schema = z.object({
    expenseIds: z.array(z.string()).min(2, "A group requires at least 2 expenses"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { expenseIds } = parsed.data;

  // Fetch the expenses to find the oldest (default primary) and check existing groups
  const expenses = await prisma.expense.findMany({
    where: { id: { in: expenseIds }, parentExpenseId: null, account: { userId } },
    select: { id: true, date: true, transactionGroupId: true },
    orderBy: { date: "asc" },
  });

  if (expenses.length < 2) {
    return res.status(400).json({ error: "At least 2 valid (non-offset) expenses are required" });
  }

  const oldestExpense = expenses[0]; // already sorted asc by date

  // Collect existing group IDs that will be vacated
  const existingGroupIds = new Set(
    expenses.map((e) => e.transactionGroupId).filter(Boolean) as string[]
  );

  await prisma.$transaction(async (tx) => {
    // Detach expenses from their current groups
    if (existingGroupIds.size > 0) {
      await tx.expense.updateMany({
        where: { transactionGroupId: { in: [...existingGroupIds] } },
        data: { transactionGroupId: null },
      });
      // Delete now-empty groups
      await tx.transactionGroup.deleteMany({
        where: { id: { in: [...existingGroupIds] } },
      });
    }

    // Create the new group, connecting all expenses
    const group = await tx.transactionGroup.create({
      data: {
        primaryExpenseId: oldestExpense.id,
        expenses: {
          connect: expenses.map((e) => ({ id: e.id })),
        },
      },
      include: groupInclude,
    });

    res.status(201).json(group);
  });
});

// PATCH /:id — update the group: change primary, add members, or remove members
// Body: { primaryExpenseId?: string, addExpenseIds?: string[], removeExpenseIds?: string[] }
// • Adding expenses removes them from their existing groups first
// • After removals, auto-deletes the group if ≤ 1 member remains
transactionGroupRoutes.patch("/:id", async (req, res) => {
  const userId = getUserId(req);
  const schema = z.object({
    primaryExpenseId: z.string().optional(),
    addExpenseIds: z.array(z.string()).optional(),
    removeExpenseIds: z.array(z.string()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { primaryExpenseId, addExpenseIds = [], removeExpenseIds = [] } = parsed.data;
  const groupId = req.params.id;

  const group = await prisma.transactionGroup.findFirst({
    where: { id: groupId, expenses: { some: { account: { userId } } } },
  });
  if (!group) return res.status(404).json({ error: "Transaction group not found" });

  await prisma.$transaction(async (tx) => {
    // If adding expenses, detach them from any existing groups first
    if (addExpenseIds.length > 0) {
      const toAdd = await tx.expense.findMany({
        where: { id: { in: addExpenseIds }, parentExpenseId: null },
        select: { id: true, transactionGroupId: true },
      });
      const oldGroupIds = new Set(
        toAdd.map((e) => e.transactionGroupId).filter(Boolean) as string[]
      );
      if (oldGroupIds.size > 0) {
        // Nullify their group memberships
        await tx.expense.updateMany({
          where: { id: { in: toAdd.map((e) => e.id) } },
          data: { transactionGroupId: null },
        });
        // Clean up any of the old groups that are now undersized
        for (const oldId of oldGroupIds) {
          if (oldId !== groupId) {
            const remaining = await tx.expense.count({
              where: { transactionGroupId: oldId, parentExpenseId: null },
            });
            if (remaining <= 1) {
              await tx.transactionGroup.delete({ where: { id: oldId } });
            }
          }
        }
      }
    }

    // Apply updates
    const updated = await tx.transactionGroup.update({
      where: { id: groupId },
      data: {
        ...(primaryExpenseId !== undefined ? { primaryExpenseId } : {}),
        ...(addExpenseIds.length > 0
          ? { expenses: { connect: addExpenseIds.map((id) => ({ id })) } }
          : {}),
        ...(removeExpenseIds.length > 0
          ? { expenses: { disconnect: removeExpenseIds.map((id) => ({ id })) } }
          : {}),
      },
      include: groupInclude,
    });

    // Auto-cleanup: if the group now has 0 or 1 members, dissolve it
    const memberCount = await tx.expense.count({
      where: { transactionGroupId: groupId, parentExpenseId: null },
    });
    if (memberCount <= 1) {
      await tx.transactionGroup.delete({ where: { id: groupId } });
      return res.json(null); // group dissolved
    }

    // If the removed expenses included the current primary, reset to oldest remaining
    if (
      removeExpenseIds.includes(updated.primaryExpenseId ?? "") ||
      !updated.primaryExpenseId
    ) {
      const oldest = await tx.expense.findFirst({
        where: { transactionGroupId: groupId, parentExpenseId: null },
        orderBy: { date: "asc" },
        select: { id: true },
      });
      if (oldest) {
        await tx.transactionGroup.update({
          where: { id: groupId },
          data: { primaryExpenseId: oldest.id },
        });
      }
    }

    res.json(updated);
  });
});

// DELETE /:id — dissolve a group entirely; member expenses are kept, just unlinked
transactionGroupRoutes.delete("/:id", async (req, res) => {
  const userId = getUserId(req);
  const group = await prisma.transactionGroup.findFirst({
    where: { id: req.params.id, expenses: { some: { account: { userId } } } },
  });
  if (!group) return res.status(404).json({ error: "Transaction group not found" });
  // Deleting the group cascades transactionGroupId → null on all member expenses (SET NULL FK)
  await prisma.transactionGroup.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
