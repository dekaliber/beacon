import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { generateUpcomingExpenses, computeNextOccurrence } from "./recurrence.js";

export const expenseRoutes = Router();

const EXPENSE_ALLOWED_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

const expenseSchema = z.object({
  amount: z.number().refine((v) => v !== 0, "Amount cannot be zero"),
  description: z.string().min(1),
  vendor: z.string().min(1),
  date: z.string().transform((s) => new Date(s)),
  notes: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string(),
  isReimbursementExpected: z.boolean().optional(),
  reimbursementNote: z.string().nullable().optional(),
  ignoreInBudget: z.boolean().optional(),
  tagIds: z.array(z.string()).optional(),
  transactionGroupId: z.string().nullable().optional(),
  recurrenceRuleId: z.string().nullable().optional(),
  parentExpenseId: z.string().nullable().optional(),
});

// List expenses with filtering and pagination
expenseRoutes.get("/", async (req, res) => {
  // Auto-generate upcoming recurring expenses (best-effort, don't block listing)
  try {
    await generateUpcomingExpenses();
  } catch (err) {
    console.error("Failed to generate upcoming expenses:", err);
  }

  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    parentExpenseId: null, // Exclude offset rows from main list
  };

  if (req.query.categoryId === "uncategorized") {
    where.categoryId = null;
  } else if (req.query.categoryIds) {
    const ids = (req.query.categoryIds as string).split(",").filter(Boolean);
    where.categoryId = ids.length === 1 ? ids[0] : { in: ids };
  } else if (req.query.categoryId) {
    where.categoryId = req.query.categoryId;
  }
  if (req.query.accountIds) {
    const ids = (req.query.accountIds as string).split(",").filter(Boolean);
    where.accountId = ids.length === 1 ? ids[0] : { in: ids };
  } else if (req.query.accountId) {
    where.accountId = req.query.accountId;
  }
  if (req.query.isReimbursementExpected === "true") where.isReimbursementExpected = true;
  if (req.query.tagIds) {
    const ids = (req.query.tagIds as string).split(",").filter(Boolean);
    where.tags = { some: { tagId: ids.length === 1 ? ids[0] : { in: ids } } };
  } else if (req.query.tagId) {
    where.tags = { some: { tagId: req.query.tagId } };
  }
  if (req.query.vendor) where.vendor = { contains: req.query.vendor as string, mode: "insensitive" };
  if (req.query.search) {
    const searchStr = req.query.search as string;
    const asNumber = parseFloat(searchStr);
    const orConditions: Record<string, unknown>[] = [
      { description: { contains: searchStr, mode: "insensitive" } },
      { vendor: { contains: searchStr, mode: "insensitive" } },
    ];
    if (!isNaN(asNumber) && asNumber > 0) {
      orConditions.push({ amount: { equals: new Prisma.Decimal(searchStr) } });
      orConditions.push({ amount: { equals: new Prisma.Decimal(-asNumber) } });
    }
    where.OR = orConditions;
  }
  if (req.query.startDate || req.query.endDate) {
    where.date = {
      ...(req.query.startDate ? { gte: new Date(req.query.startDate as string) } : {}),
      ...(req.query.endDate ? { lte: new Date(req.query.endDate as string) } : {}),
    };
  }

  // Sorting
  const sortBy = req.query.sortBy as string | undefined;
  const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

  const expenseInclude = {
    category: true,
    account: true,
    tags: { include: { tag: true } },
    transactionGroup: {
      select: { id: true, primaryExpenseId: true, notes: true, createdAt: true, updatedAt: true },
    },
  };

  // For date sorting, use a raw SQL query so grouped expenses sort by their
  // group's primary expense's date (rather than their own date). This keeps all
  // members of a group adjacent in the result, anchored at the primary's date.
  if (!sortBy || sortBy === "date") {
    const dir = sortOrder === "asc" ? "ASC" : "DESC";

    // Build WHERE clause dynamically with positional params
    const conds: string[] = [`e."parentExpenseId" IS NULL`];
    const params: unknown[] = [];
    let p = 1;

    if (req.query.categoryId === "uncategorized") {
      conds.push(`e."categoryId" IS NULL`);
    } else if (req.query.categoryIds) {
      const ids = (req.query.categoryIds as string).split(",").filter(Boolean);
      conds.push(`e."categoryId" = ANY($${p++}::text[])`);
      params.push(ids);
    } else if (req.query.categoryId) {
      conds.push(`e."categoryId" = $${p++}`);
      params.push(req.query.categoryId);
    }

    if (req.query.accountIds) {
      const ids = (req.query.accountIds as string).split(",").filter(Boolean);
      conds.push(`e."accountId" = ANY($${p++}::text[])`);
      params.push(ids);
    } else if (req.query.accountId) {
      conds.push(`e."accountId" = $${p++}`);
      params.push(req.query.accountId);
    }

    if (req.query.isReimbursementExpected === "true") {
      conds.push(`e."isReimbursementExpected" = TRUE`);
    }

    if (req.query.tagIds || req.query.tagId) {
      const ids = req.query.tagIds
        ? (req.query.tagIds as string).split(",").filter(Boolean)
        : [req.query.tagId as string];
      conds.push(
        `EXISTS (SELECT 1 FROM expense_tags et WHERE et."expenseId" = e.id AND et."tagId" = ANY($${p++}::text[]))`,
      );
      params.push(ids);
    }

    if (req.query.vendor) {
      conds.push(`e.vendor ILIKE $${p++}`);
      params.push(`%${req.query.vendor}%`);
    }

    if (req.query.search) {
      const searchStr = req.query.search as string;
      const asNumber = parseFloat(searchStr);
      const term = `%${searchStr}%`;
      const orParts: string[] = [`e.description ILIKE $${p}`, `e.vendor ILIKE $${p}`];
      params.push(term);
      p++;
      if (!isNaN(asNumber) && asNumber > 0) {
        orParts.push(`ABS(e.amount) = $${p++}::numeric`);
        params.push(String(asNumber));
      }
      conds.push(`(${orParts.join(" OR ")})`);
    }

    if (req.query.startDate) {
      conds.push(`e.date >= $${p++}::timestamp`);
      params.push(req.query.startDate as string);
    }
    if (req.query.endDate) {
      conds.push(`e.date <= $${p++}::timestamp`);
      params.push(req.query.endDate as string);
    }

    const whereSQL = conds.join(" AND ");

    // Subquery: for each group, the effective sort date is the primary expense's date
    // if one is set, otherwise the oldest member's date.
    const sortSQL = `
      SELECT e.id
      FROM expenses e
      LEFT JOIN transaction_groups tg ON e."transactionGroupId" = tg.id
      LEFT JOIN expenses pe ON tg."primaryExpenseId" = pe.id
      LEFT JOIN (
        SELECT "transactionGroupId", MIN(date) AS min_date
        FROM expenses
        WHERE "parentExpenseId" IS NULL
        GROUP BY "transactionGroupId"
      ) grp_min ON e."transactionGroupId" = grp_min."transactionGroupId"
      WHERE ${whereSQL}
      ORDER BY COALESCE(pe.date, grp_min.min_date, e.date) ${dir}, e."recurrenceRuleId" ASC NULLS LAST, e."createdAt" ASC
      LIMIT $${p} OFFSET $${p + 1}
    `;
    params.push(limit, skip);

    const countSQL = `
      SELECT COUNT(*) AS cnt
      FROM expenses e
      WHERE ${whereSQL}
    `;
    // Count params exclude LIMIT/OFFSET (last two)
    const countParams = params.slice(0, params.length - 2);

    const [rawRows, countRows] = await Promise.all([
      prisma.$queryRawUnsafe<{ id: string }[]>(sortSQL, ...params),
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(countSQL, ...countParams),
    ]);

    const ids = rawRows.map((r) => r.id);
    const total = Number(countRows[0]?.cnt ?? 0);

    const expenses = ids.length > 0
      ? await prisma.expense.findMany({
          where: { id: { in: ids } },
          include: {
            ...expenseInclude,
            offsets: {
              include: expenseInclude,
              orderBy: { createdAt: "asc" as const },
            },
          },
        })
      : [];

    // Re-sort to match the raw SQL order (findMany with `in` doesn't preserve order)
    const idOrder = Object.fromEntries(ids.map((id, i) => [id, i]));
    expenses.sort((a, b) => (idOrder[a.id] ?? 0) - (idOrder[b.id] ?? 0));

    return res.json({
      data: expenses,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }

  // Non-date sorts: fall back to Prisma orderBy (groups not specially sorted)
  let orderBy: Record<string, unknown>[];
  if (sortBy === "category") {
    orderBy = [{ category: { name: sortOrder } }, { date: "desc" }];
  } else if (sortBy === "account") {
    orderBy = [{ account: { name: sortOrder } }, { date: "desc" }];
  } else {
    orderBy = [{ [sortBy]: sortOrder }, { date: "desc" }];
  }

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        ...expenseInclude,
        offsets: {
          include: expenseInclude,
          orderBy: { createdAt: "asc" as const },
        },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.expense.count({ where }),
  ]);

  res.json({
    data: expenses,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Get distinct vendors for autocomplete
expenseRoutes.get("/vendors", async (_req, res) => {
  const expenses = await prisma.expense.findMany({
    where: { vendor: { not: "" } },
    select: { vendor: true },
    distinct: ["vendor"],
    orderBy: { vendor: "asc" },
  });
  res.json(expenses.map((e) => e.vendor));
});

// Get the last-used categoryId for a given vendor
expenseRoutes.get("/vendor-category", async (req, res) => {
  const vendor = req.query.vendor as string;
  if (!vendor) return res.json({ categoryId: null });

  const expense = await prisma.expense.findFirst({
    where: { vendor: { equals: vendor, mode: "insensitive" } },
    orderBy: { date: "desc" },
    select: { categoryId: true },
  });
  res.json({ categoryId: expense?.categoryId ?? null });
});

// Count uncategorized expenses (exclude offsets)
expenseRoutes.get("/uncategorized-count", async (_req, res) => {
  const count = await prisma.expense.count({
    where: { categoryId: null, parentExpenseId: null },
  });
  res.json({ count });
});

// Get single expense
expenseRoutes.get("/:id", async (req, res) => {
  const expense = await prisma.expense.findUnique({
    where: { id: req.params.id },
    include: {
      category: true,
      account: true,
      recurrenceRule: true,
      tags: { include: { tag: true } },
      transactionGroup: true,
      offsets: {
        include: {
          category: true,
          account: true,
          tags: { include: { tag: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  res.json(expense);
});

// Create expense
expenseRoutes.post("/", async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, ...data } = parsed.data;

  // Validate account type allows expenses
  const account = await prisma.account.findUnique({ where: { id: data.accountId } });
  if (!account) return res.status(400).json({ error: "Account not found" });
  if (!EXPENSE_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
    return res.status(400).json({
      error: `Account type '${account.type}' cannot have expenses. Allowed types: Checking, Savings, Credit Card, Cash.`,
    });
  }

  const expense = await prisma.expense.create({
    data: {
      ...data,
      ...(tagIds?.length ? { tags: { create: tagIds.map((id) => ({ tagId: id })) } } : {}),
    },
    include: {
      category: true,
      account: true,
      tags: { include: { tag: true } },
      transactionGroup: true,
      offsets: {
        include: { category: true, account: true, tags: { include: { tag: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  res.status(201).json(expense);
});

// Bulk import expenses
// TODO: If an imported row matches a pending recurring expense instance (same date, amount, vendor,
// account), update/confirm the pending instance rather than creating a duplicate.
const importRowSchema = z.object({
  amount: z.number().refine((v) => v !== 0, "Amount cannot be zero"),
  description: z.string().min(1),
  vendor: z.string().min(1),
  date: z.string().transform((s) => new Date(s)),
  categoryId: z.string().nullable().optional(),
  accountId: z.string(),
});

const importSchema = z.object({
  expenses: z.array(importRowSchema),
});

expenseRoutes.post("/import", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error("[import] Zod validation failed:", JSON.stringify(parsed.error.flatten()));
    return res.status(400).json({ error: "Invalid import data: " + JSON.stringify(parsed.error.flatten().fieldErrors) });
  }

  const rows = parsed.data.expenses;
  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = rows[i];
      // Validate account type
      const account = await prisma.account.findUnique({ where: { id: row.accountId } });
      if (!account || !EXPENSE_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
        errors.push({ row: i + 1, message: `Invalid account` });
        continue;
      }
      await prisma.expense.create({ data: row });
      imported++;
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  res.json({ imported, errors });
});

// Bulk edit expenses (description, category, tags)
const bulkEditSchema = z.object({
  ids: z.array(z.string()).min(1),
  description: z.string().min(1).optional(),
  categoryId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  tagMode: z.enum(["add", "remove", "replace"]).default("add"),
});

expenseRoutes.patch("/bulk", async (req, res) => {
  const parsed = bulkEditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ids, description, categoryId, tagIds, tagMode } = parsed.data;

  const scalarUpdate: Record<string, unknown> = {};
  if (description !== undefined) scalarUpdate.description = description;
  if (categoryId !== undefined) scalarUpdate.categoryId = categoryId;

  await prisma.$transaction(async (tx) => {
    if (Object.keys(scalarUpdate).length > 0) {
      await tx.expense.updateMany({
        where: { id: { in: ids } },
        data: scalarUpdate,
      });
    }

    if (tagIds !== undefined) {
      if (tagMode === "replace") {
        await tx.expenseTag.deleteMany({ where: { expenseId: { in: ids } } });
        if (tagIds.length > 0) {
          await tx.expenseTag.createMany({
            data: ids.flatMap((expenseId) => tagIds.map((tagId) => ({ expenseId, tagId }))),
            skipDuplicates: true,
          });
        }
      } else if (tagMode === "remove") {
        if (tagIds.length > 0) {
          await tx.expenseTag.deleteMany({
            where: { expenseId: { in: ids }, tagId: { in: tagIds } },
          });
        }
      } else {
        // add
        if (tagIds.length > 0) {
          await tx.expenseTag.createMany({
            data: ids.flatMap((expenseId) => tagIds.map((tagId) => ({ expenseId, tagId }))),
            skipDuplicates: true,
          });
        }
      }
    }
  });

  res.json({ updated: ids.length });
});

// Update expense
expenseRoutes.put("/:id", async (req, res) => {
  const parsed = expenseSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, ...data } = parsed.data;
  const updateFuture = req.query.updateFuture === "true";

  // Get original expense to check recurrence rule linkage
  const original = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!original) return res.status(404).json({ error: "Expense not found" });

  // Validate account type if accountId is being changed
  if (data.accountId) {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } });
    if (!account) return res.status(400).json({ error: "Account not found" });
    if (!EXPENSE_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
      return res.status(400).json({
        error: `Account type '${account.type}' cannot have expenses. Allowed types: Checking, Savings, Credit Card, Cash.`,
      });
    }
  }

  const expense = await prisma.expense.update({
    where: { id: req.params.id },
    data: {
      ...data,
      ...(tagIds !== undefined
        ? { tags: { deleteMany: {}, create: tagIds.map((id) => ({ tagId: id })) } }
        : {}),
    },
    include: {
      category: true,
      account: true,
      tags: { include: { tag: true } },
      transactionGroup: true,
      offsets: {
        include: { category: true, account: true, tags: { include: { tag: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // Propagate changes to rule and future pending expenses (only when explicitly requested)
  if (updateFuture && original.recurrenceRuleId) {
    const rule = await prisma.recurrenceRule.findUnique({
      where: { id: original.recurrenceRuleId },
    });
    if (rule && rule.isActive) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      // Update non-date fields on the rule and all future pending expenses
      const syncFields = ["amount", "description", "vendor", "categoryId", "accountId"] as const;
      const ruleUpdate: Record<string, unknown> = {};
      for (const field of syncFields) {
        if (field in data) {
          ruleUpdate[field] = (data as Record<string, unknown>)[field];
        }
      }
      if (Object.keys(ruleUpdate).length > 0) {
        await prisma.recurrenceRule.update({
          where: { id: original.recurrenceRuleId },
          data: ruleUpdate,
        });
        await prisma.expense.updateMany({
          where: {
            recurrenceRuleId: original.recurrenceRuleId,
            date: { gt: today },
            id: { not: original.id },
          },
          data: ruleUpdate,
        });
      }

      // If date changed, recalculate dates on future pending expenses
      if (data.date) {
        const newDate = data.date;
        // Get all future pending expenses for this rule, sorted by date
        const futureExpenses = await prisma.expense.findMany({
          where: {
            recurrenceRuleId: original.recurrenceRuleId,
            date: { gt: today },
            id: { not: original.id },
          },
          orderBy: { date: "asc" },
        });

        // Recalculate dates from the edited expense's new date
        let anchor = newDate;
        for (const fe of futureExpenses) {
          const nextDate = computeNextOccurrence(anchor, rule.frequency, rule.interval);
          await prisma.expense.update({
            where: { id: fe.id },
            data: { date: nextDate },
          });
          anchor = nextDate;
        }

        // Update rule's nextOccurrence to the next date past all generated ones
        const lastGenerated = futureExpenses.length > 0
          ? computeNextOccurrence(anchor, rule.frequency, rule.interval)
          : computeNextOccurrence(newDate, rule.frequency, rule.interval);
        await prisma.recurrenceRule.update({
          where: { id: original.recurrenceRuleId },
          data: { nextOccurrence: lastGenerated },
        });
      }
    }
  }

  res.json(expense);
});

// Delete expense
expenseRoutes.delete("/:id", async (req, res) => {
  const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  const deleteFuture = req.query.deleteFuture === "true";

  if (deleteFuture && expense.recurrenceRuleId) {
    // Deactivate rule and delete all future pending instances
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await prisma.recurrenceRule.update({
      where: { id: expense.recurrenceRuleId },
      data: { isActive: false },
    });
    await prisma.expense.deleteMany({
      where: {
        recurrenceRuleId: expense.recurrenceRuleId,
        date: { gt: today },
        id: { not: expense.id },
      },
    });
  }

  await prisma.expense.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
