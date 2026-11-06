import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { parseLocalDate } from "../lib/localDate.js";

export const incomeRoutes = Router();

const INCOME_ALLOWED_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

const INCOME_INCLUDE = {
  account: true,
  depositAccount: true,
  category: true,
  tags: { include: { tag: true } },
  transactionGroup: true,
  activity: true,
} as const;

// Resolves isCollectible for each income's linked activity by looking up the
// instrument via the activity's ticker (primary or alias). This keeps the
// Instrument as the single source of truth without requiring a schema relation
// between InvestmentActivity and Instrument.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function attachCollectibleFlags(incomes: any[]): Promise<any[]> {
  const tickers = new Set<string>();
  for (const inc of incomes) {
    if (inc.activity?.ticker) tickers.add(inc.activity.ticker);
  }
  if (tickers.size === 0) return incomes;

  const tickerList = Array.from(tickers);

  const [byPrimary, byAlias] = await Promise.all([
    prisma.instrument.findMany({
      where: { primaryTicker: { in: tickerList } },
      select: { primaryTicker: true, isCollectible: true },
    }),
    prisma.instrumentTicker.findMany({
      where: { ticker: { in: tickerList } },
      select: { ticker: true, instrument: { select: { isCollectible: true } } },
    }),
  ]);

  const map = new Map<string, boolean>();
  for (const inst of byPrimary) map.set(inst.primaryTicker, inst.isCollectible);
  for (const alias of byAlias) map.set(alias.ticker, alias.instrument.isCollectible);

  return incomes.map((inc) => {
    if (!inc.activity?.ticker) return inc;
    const isCollectible = map.get(inc.activity.ticker) ?? false;
    return { ...inc, activity: { ...inc.activity, isCollectible } };
  });
}

const incomeSchema = z.object({
  amount: z.number().positive(),
  categoryId: z.string().optional(),
  source: z.string().optional(),
  date: z.string().transform((s) => parseLocalDate(s)),
  notes: z.string().nullable().optional(),
  accountId: z.string(),
  // Where and when the cash landed; omitted on create → same as accountId/date.
  depositAccountId: z.string().nullable().optional(),
  depositDate: z.string().transform((s) => parseLocalDate(s)).nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  transactionGroupId: z.string().nullable().optional(),
  taxClassification: z
    .enum(["QUALIFIED", "ORDINARY", "TAX_EXEMPT", "RETURN_OF_CAPITAL", "CAPITAL_GAIN"])
    .nullable()
    .optional(),
});

async function validateIncomeAccount(userId: string, accountId: string): Promise<string | null> {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!account) return "Account not found";
  if (!INCOME_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
    return `Account type '${account.type}' cannot receive income. Allowed types: Checking, Savings, Investment.`;
  }
  return null;
}

// List incomes with optional filtering and pagination
incomeRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { account: { userId } };
  if (req.query.showOnlyReceived !== "false") where.isCashReceived = true;
  // An account filter matches income that originated in or was deposited to it.
  const and: Record<string, unknown>[] = [];
  const filterAccountIds = req.query.accountIds
    ? (req.query.accountIds as string).split(",").filter(Boolean)
    : req.query.accountId ? [req.query.accountId as string] : [];
  if (filterAccountIds.length > 0) {
    and.push({ OR: [{ accountId: { in: filterAccountIds } }, { depositAccountId: { in: filterAccountIds } }] });
  }
  if (req.query.categoryIds) {
    const ids = (req.query.categoryIds as string).split(",").filter(Boolean);
    where.categoryId = ids.length === 1 ? ids[0] : { in: ids };
  } else if (req.query.categoryId) {
    where.categoryId = req.query.categoryId;
  }
  if (req.query.tagIds) {
    const ids = (req.query.tagIds as string).split(",").filter(Boolean);
    where.tags = { some: { tagId: ids.length === 1 ? ids[0] : { in: ids } } };
  } else if (req.query.tagId) {
    where.tags = { some: { tagId: req.query.tagId } };
  }
  if (req.query.hasNotes === "true") and.push({ notes: { not: null } }, { NOT: { notes: "" } });
  if (and.length > 0) where.AND = and;
  if (req.query.search) {
    const searchStr = req.query.search as string;
    const asNumber = parseFloat(searchStr);
    const orConditions: Record<string, unknown>[] = [
      { source: { contains: searchStr, mode: "insensitive" } },
    ];
    if (!isNaN(asNumber) && asNumber > 0) {
      orConditions.push({ amount: { equals: asNumber } });
    }
    where.OR = orConditions;
  }
  if (req.query.startDate || req.query.endDate) {
    where.date = {
      ...(req.query.startDate ? { gte: new Date(req.query.startDate as string) } : {}),
      ...(req.query.endDate ? { lte: new Date((req.query.endDate as string) + "T23:59:59.999Z") } : {}),
    };
  }

  // Sorting
  const sortBy = req.query.sortBy as string | undefined;
  const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

  let orderBy: Record<string, unknown>[];
  if (!sortBy || sortBy === "date") {
    orderBy = [{ date: sortOrder }, { createdAt: "desc" }];
  } else if (sortBy === "account") {
    orderBy = [{ account: { name: sortOrder } }, { date: "desc" }];
  } else if (sortBy === "depositAccount") {
    // Null (not yet backfilled) deposit accounts sort as their origin would, approximately: last.
    orderBy = [{ depositAccount: { name: sortOrder } }, { account: { name: sortOrder } }, { date: "desc" }];
  } else if (sortBy === "depositDate") {
    orderBy = [{ depositDate: { sort: sortOrder, nulls: "last" } }, { date: sortOrder }];
  } else if (sortBy === "category") {
    orderBy = [{ category: { name: sortOrder } }, { date: "desc" }];
  } else {
    orderBy = [{ [sortBy]: sortOrder }, { date: "desc" }];
  }

  const [incomes, total] = await Promise.all([
    prisma.income.findMany({
      where,
      include: INCOME_INCLUDE,
      orderBy,
      skip,
      take: limit,
    }),
    prisma.income.count({ where }),
  ]);

  const enriched = await attachCollectibleFlags(incomes);

  res.json({
    data: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Get single income
incomeRoutes.get("/:id", async (req, res) => {
  const userId = getUserId(req);
  const income = await prisma.income.findFirst({
    where: { id: req.params.id, account: { userId } },
    include: INCOME_INCLUDE,
  });
  if (!income) return res.status(404).json({ error: "Income not found" });
  const [enriched] = await attachCollectibleFlags([income]);
  res.json(enriched);
});

// Create income
incomeRoutes.post("/", async (req, res) => {
  const userId = getUserId(req);
  const parsed = incomeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, taxClassification, depositAccountId, depositDate, ...data } = parsed.data;

  // Validate account types allow income
  const accountError = await validateIncomeAccount(userId, data.accountId);
  if (accountError) return res.status(400).json({ error: accountError });
  if (depositAccountId && depositAccountId !== data.accountId) {
    const depositError = await validateIncomeAccount(userId, depositAccountId);
    if (depositError) return res.status(400).json({ error: depositError });
  }

  const taxableAmount = taxClassification === "RETURN_OF_CAPITAL" ? 0
    : taxClassification != null ? data.amount
    : undefined;

  const income = await prisma.income.create({
    data: {
      ...data,
      depositAccountId: depositAccountId ?? data.accountId,
      depositDate: depositDate ?? data.date,
      taxClassification: taxClassification ?? null,
      ...(taxableAmount !== undefined ? { taxableAmount } : {}),
      ...(tagIds?.length ? { tags: { create: tagIds.map((id) => ({ tagId: id })) } } : {}),
    },
    include: INCOME_INCLUDE,
  });
  res.status(201).json(income);
});

// Update income
incomeRoutes.put("/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = incomeSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, taxClassification, ...data } = parsed.data;

  // Validate account types if they are being changed
  for (const id of [data.accountId, data.depositAccountId]) {
    if (!id) continue;
    const accountError = await validateIncomeAccount(userId, id);
    if (accountError) return res.status(400).json({ error: accountError });
  }

  // Recompute taxableAmount when taxClassification or amount changes
  let taxableAmount: number | null | undefined = undefined;
  if (taxClassification !== undefined) {
    if (taxClassification === null) {
      taxableAmount = null;
    } else if (taxClassification === "RETURN_OF_CAPITAL") {
      taxableAmount = 0;
    } else {
      // Use provided amount if present, otherwise look up the existing record
      if (data.amount !== undefined) {
        taxableAmount = data.amount;
      } else {
        const existing = await prisma.income.findFirst({ where: { id: req.params.id, account: { userId } }, select: { amount: true } });
        taxableAmount = existing ? Number(existing.amount) : undefined;
      }
    }
  }

  const owned = await prisma.income.findFirst({
    where: { id: req.params.id, account: { userId } },
    select: { id: true, accountId: true, date: true, depositAccountId: true, depositDate: true },
  });
  if (!owned) return res.status(404).json({ error: "Income not found" });

  // Origin and deposit are independent; one only follows the other when the
  // income was deposited where and when it originated (account AND date the
  // same) — a deposit that differs was set deliberately and stays put.
  const landedInPlace = owned.depositAccountId == null || owned.depositAccountId === owned.accountId;
  const landedSameDay = owned.depositDate == null || owned.depositDate.getTime() === owned.date.getTime();
  if (landedInPlace && landedSameDay) {
    if (data.accountId && data.depositAccountId === undefined && owned.depositAccountId != null) {
      data.depositAccountId = data.accountId;
    }
    if (data.date && data.depositDate === undefined && owned.depositDate != null) {
      data.depositDate = data.date;
    }
  }

  const income = await prisma.income.update({
    where: { id: req.params.id },
    data: {
      ...data,
      ...(taxClassification !== undefined ? { taxClassification } : {}),
      ...(taxableAmount !== undefined ? { taxableAmount } : {}),
      ...(tagIds !== undefined
        ? {
            tags: {
              deleteMany: {},
              create: tagIds.map((id) => ({ tagId: id })),
            },
          }
        : {}),
    },
    include: INCOME_INCLUDE,
  });
  res.json(income);
});

// Bulk delete income
incomeRoutes.delete("/bulk", async (req, res) => {
  const userId = getUserId(req);
  const parsed = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ids } = parsed.data;
  const result = await prisma.income.deleteMany({ where: { id: { in: ids }, account: { userId } } });
  res.json({ deleted: result.count });
});

// Delete income
incomeRoutes.delete("/:id", async (req, res) => {
  const userId = getUserId(req);
  await prisma.income.deleteMany({ where: { id: req.params.id, account: { userId } } });
  res.status(204).send();
});

// Bulk edit income (source, category, taxClassification)
const bulkEditIncomeSchema = z.object({
  ids: z.array(z.string()).min(1),
  date: z.string().transform((s) => parseLocalDate(s)).optional(),
  source: z.string().min(1).optional(),
  categoryId: z.string().nullable().optional(),
  taxClassification: z
    .enum(["QUALIFIED", "ORDINARY", "TAX_EXEMPT", "RETURN_OF_CAPITAL", "CAPITAL_GAIN"])
    .nullable()
    .optional(),
});

incomeRoutes.patch("/bulk", async (req, res) => {
  const userId = getUserId(req);
  const parsed = bulkEditIncomeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ids, date, source, categoryId, taxClassification } = parsed.data;

  // Resolve only IDs owned by this user
  const owned = await prisma.income.findMany({
    where: { id: { in: ids }, account: { userId } },
    select: { id: true },
  });
  const ownedIds = owned.map((o) => o.id);
  if (ownedIds.length === 0) return res.json({ updated: 0 });

  const scalarUpdate: Record<string, unknown> = {};
  if (date !== undefined) scalarUpdate.date = date;
  if (source !== undefined) scalarUpdate.source = source;
  if (categoryId !== undefined) scalarUpdate.categoryId = categoryId;
  if (taxClassification !== undefined) scalarUpdate.taxClassification = taxClassification;

  if (Object.keys(scalarUpdate).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  // Rows deposited where and when they originated keep the deposit date in step;
  // any other deposit date was set deliberately and stays. Runs before `date` changes.
  if (date !== undefined) {
    await prisma.$executeRaw`UPDATE incomes SET "depositDate" = ${date} WHERE id = ANY(${ownedIds}::text[]) AND "depositDate" = date AND "depositAccountId" = "accountId"`;
  }

  // For taxClassification updates, taxableAmount must be computed per-row since it depends on amount
  if (taxClassification !== undefined && taxClassification !== null) {
    // RETURN_OF_CAPITAL → taxableAmount = 0; all others → taxableAmount = amount
    if (taxClassification === "RETURN_OF_CAPITAL") {
      await prisma.$executeRawUnsafe(
        `UPDATE incomes SET "taxClassification" = $1::"TaxClassification", "taxableAmount" = 0 WHERE id = ANY($2::text[])`,
        taxClassification,
        ownedIds
      );
    } else {
      await prisma.$executeRawUnsafe(
        `UPDATE incomes SET "taxClassification" = $1::"TaxClassification", "taxableAmount" = amount WHERE id = ANY($2::text[])`,
        taxClassification,
        ownedIds
      );
    }
    // Apply any other scalar updates (date, source, categoryId) separately
    const otherUpdate: Record<string, unknown> = {};
    if (date !== undefined) otherUpdate.date = date;
    if (source !== undefined) otherUpdate.source = source;
    if (categoryId !== undefined) otherUpdate.categoryId = categoryId;
    if (Object.keys(otherUpdate).length > 0) {
      await prisma.income.updateMany({ where: { id: { in: ownedIds } }, data: otherUpdate });
    }
  } else if (taxClassification === null) {
    // Clearing taxClassification also clears taxableAmount
    await prisma.income.updateMany({
      where: { id: { in: ownedIds } },
      data: { ...scalarUpdate, taxableAmount: null },
    });
  } else {
    await prisma.income.updateMany({ where: { id: { in: ownedIds } }, data: scalarUpdate });
  }

  res.json({ updated: ownedIds.length });
});

// Bulk import income
const importRowSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
  categoryId: z.string().optional(),
  source: z.string().optional(),
  date: z.string().transform((s) => parseLocalDate(s)),
  accountId: z.string(),
});

const importSchema = z.object({
  incomes: z.array(importRowSchema),
});

incomeRoutes.post("/import", async (req, res) => {
  const userId = getUserId(req);
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rows = parsed.data.incomes;
  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = rows[i];
      const account = await prisma.account.findFirst({ where: { id: row.accountId, userId } });
      if (!account || !INCOME_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
        errors.push({ row: i + 1, message: `Invalid account` });
        continue;
      }
      // Validate category is an income category if provided
      if (row.categoryId) {
        const category = await prisma.category.findUnique({ where: { id: row.categoryId } });
        if (!category || category.kind !== "INCOME") {
          errors.push({ row: i + 1, message: `Invalid income category` });
          continue;
        }
      }
      await prisma.income.create({ data: { ...row, depositAccountId: row.accountId, depositDate: row.date } });
      imported++;
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  res.json({ imported, errors });
});
