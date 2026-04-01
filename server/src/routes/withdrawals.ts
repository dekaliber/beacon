import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";

export const withdrawalRoutes = Router();

// ── Investment settings (singleton) ──────────────────────────────────────────

async function getOrCreateInvestmentSettings() {
  const existing = await prisma.investmentSettings.findFirst();
  if (existing) return existing;
  return prisma.investmentSettings.create({ data: {} });
}

const investmentSettingsSchema = z.object({
  withdrawalRateDenominator: z.number().positive().nullable(),
  withdrawalRateTarget: z.number().min(0).max(1).nullable(),
});

// GET /api/withdrawals/settings
withdrawalRoutes.get("/settings", async (_req, res) => {
  const settings = await getOrCreateInvestmentSettings();
  res.json({
    withdrawalRateDenominator: settings.withdrawalRateDenominator
      ? parseFloat(settings.withdrawalRateDenominator.toString())
      : null,
    withdrawalRateTarget: settings.withdrawalRateTarget
      ? parseFloat(settings.withdrawalRateTarget.toString())
      : null,
  });
});

// PATCH /api/withdrawals/settings
withdrawalRoutes.patch("/settings", async (req, res) => {
  const parsed = investmentSettingsSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await getOrCreateInvestmentSettings();
  const updated = await prisma.investmentSettings.update({
    where: { id: settings.id },
    data: {
      ...(parsed.data.withdrawalRateDenominator !== undefined && {
        withdrawalRateDenominator: parsed.data.withdrawalRateDenominator,
      }),
      ...(parsed.data.withdrawalRateTarget !== undefined && {
        withdrawalRateTarget: parsed.data.withdrawalRateTarget,
      }),
    },
  });
  res.json({
    withdrawalRateDenominator: updated.withdrawalRateDenominator
      ? parseFloat(updated.withdrawalRateDenominator.toString())
      : null,
    withdrawalRateTarget: updated.withdrawalRateTarget
      ? parseFloat(updated.withdrawalRateTarget.toString())
      : null,
  });
});

// ── Withdrawal type helpers ───────────────────────────────────────────────────

type WithdrawalType =
  | "dividend"
  | "interest"
  | "cap_gains_dist"
  | "sale_proceeds"
  | "return_of_capital"
  | "transfer"
  | "reinvestment";

interface WithdrawalEvent {
  id: string;
  date: string;
  type: WithdrawalType;
  description: string;
  account: { id: string; name: string; color: string | null; type: string };
  toAccount?: { id: string; name: string; color: string | null; type: string };
  amount: string;
  isEditable: boolean;
  incomeId?: string;
  transferId?: string;
}

const DIVIDEND_CATEGORY = "Dividend";
const INTEREST_CATEGORY = "Interest";
const CAP_GAINS_DIST_CATEGORY = "Cap Gains Distribution";

// Fetch the IDs of the special income categories
async function getSpecialCategoryIds(): Promise<{
  dividendId: string | null;
  interestId: string | null;
  capGainsDivId: string | null;
}> {
  const cats = await prisma.category.findMany({
    where: {
      name: { in: [DIVIDEND_CATEGORY, INTEREST_CATEGORY, CAP_GAINS_DIST_CATEGORY] },
      kind: "INCOME",
    },
    select: { id: true, name: true },
  });
  return {
    dividendId: cats.find((c) => c.name === DIVIDEND_CATEGORY)?.id ?? null,
    interestId: cats.find((c) => c.name === INTEREST_CATEGORY)?.id ?? null,
    capGainsDivId: cats.find((c) => c.name === CAP_GAINS_DIST_CATEGORY)?.id ?? null,
  };
}

// Process any unconfirmed portfolio↔banking transfers whose date has passed.
// INVESTMENT→BANKING: debit cashBalance (non-managed only), credit banking balance.
// BANKING→INVESTMENT: debit banking balance, credit cashBalance (non-managed only).
async function processPendingWithdrawalTransfers(): Promise<void> {
  const now = new Date();
  const bankingTypes = ["CHECKING" as const, "SAVINGS" as const];

  // INVESTMENT → BANKING (withdrawals)
  const pendingOut = await prisma.transfer.findMany({
    where: {
      isConfirmed: false,
      date: { lte: now },
      fromAccount: { type: "INVESTMENT", isJoint: false },
      toAccount: { type: { in: bankingTypes }, isJoint: false },
    },
    include: {
      fromAccount: { select: { id: true, isManaged: true } },
      toAccount: { select: { id: true } },
    },
  });

  for (const t of pendingOut) {
    const amount = parseFloat(t.amount.toString());
    await prisma.$transaction(async (tx) => {
      await tx.transfer.update({ where: { id: t.id }, data: { isConfirmed: true } });
      await tx.account.update({
        where: { id: t.toAccount.id },
        data: { balance: { increment: amount }, balanceUpdatedAt: now },
      });
      if (!t.fromAccount.isManaged) {
        await tx.account.update({
          where: { id: t.fromAccount.id },
          data: { cashBalance: { decrement: amount }, cashBalanceUpdatedAt: now },
        });
      }
    });
  }

  // BANKING → INVESTMENT (reinvestments)
  const pendingIn = await prisma.transfer.findMany({
    where: {
      isConfirmed: false,
      date: { lte: now },
      fromAccount: { type: { in: bankingTypes }, isJoint: false },
      toAccount: { type: "INVESTMENT", isJoint: false },
    },
    include: {
      fromAccount: { select: { id: true } },
      toAccount: { select: { id: true, isManaged: true } },
    },
  });

  for (const t of pendingIn) {
    const amount = parseFloat(t.amount.toString());
    await prisma.$transaction(async (tx) => {
      await tx.transfer.update({ where: { id: t.id }, data: { isConfirmed: true } });
      await tx.account.update({
        where: { id: t.fromAccount.id },
        data: { balance: { decrement: amount }, balanceUpdatedAt: now },
      });
      if (!t.toAccount.isManaged) {
        await tx.account.update({
          where: { id: t.toAccount.id },
          data: { cashBalance: { increment: amount }, cashBalanceUpdatedAt: now },
        });
      }
    });
  }
}

// ── GET /api/withdrawals/summary ─────────────────────────────────────────────

withdrawalRoutes.get("/summary", async (req, res) => {
  const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();

  await processPendingWithdrawalTransfers();

  const { dividendId, interestId, capGainsDivId } = await getSpecialCategoryIds();

  const startOfYear = new Date(`${year}-01-01T00:00:00.000Z`);
  const endOfYear = new Date(`${year}-12-31T23:59:59.999Z`);

  // Fetch qualifying income rows for the year
  const incomeRows = await prisma.income.findMany({
    where: {
      date: { gte: startOfYear, lte: endOfYear },
      account: { isJoint: false },
      OR: [
        // Auto-confirmed dividends
        { subtype: "DIVIDEND", isCashReceived: true },
        // Manually logged dividends
        ...(dividendId
          ? [{ categoryId: dividendId, isCashReceived: true, subtype: { not: "DIVIDEND" as const } }]
          : []),
        // Interest
        ...(interestId ? [{ categoryId: interestId }] : []),
        // Cap Gains Distribution
        ...(capGainsDivId ? [{ categoryId: capGainsDivId }] : []),
        // Sale proceeds to banking account
        {
          subtype: "CAPITAL_GAIN" as const,
          account: { type: { in: ["CHECKING", "SAVINGS"] } },
        },
        // Return of capital
        { subtype: "RETURN_OF_CAPITAL" as const },
      ],
    },
    select: { amount: true, date: true },
  });

  // INVESTMENT→BANKING confirmed transfers (positive — withdrawals)
  const outTransferRows = await prisma.transfer.findMany({
    where: {
      date: { gte: startOfYear, lte: endOfYear },
      isConfirmed: true,
      fromAccount: { type: "INVESTMENT", isJoint: false },
      toAccount: { type: { in: ["CHECKING", "SAVINGS"] }, isJoint: false },
    },
    select: { amount: true, date: true },
  });

  // BANKING→INVESTMENT confirmed transfers (negative — reinvestments)
  const inTransferRows = await prisma.transfer.findMany({
    where: {
      date: { gte: startOfYear, lte: endOfYear },
      isConfirmed: true,
      fromAccount: { type: { in: ["CHECKING", "SAVINGS"] }, isJoint: false },
      toAccount: { type: "INVESTMENT", isJoint: false },
    },
    select: { amount: true, date: true },
  });

  // Aggregate by month — reinvestments subtract from the total
  const monthTotals: Record<string, number> = {};
  for (const row of [...incomeRows, ...outTransferRows]) {
    const key = row.date.toISOString().slice(0, 7);
    monthTotals[key] = (monthTotals[key] ?? 0) + parseFloat(row.amount.toString());
  }
  for (const row of inTransferRows) {
    const key = row.date.toISOString().slice(0, 7);
    monthTotals[key] = (monthTotals[key] ?? 0) - parseFloat(row.amount.toString());
  }

  // Build month summaries for the year
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // 1-indexed

  const monthlySummaries = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    if (monthTotals[key] !== undefined || (year < currentYear || m <= currentMonth)) {
      monthlySummaries.push({ month: key, total: monthTotals[key] ?? 0 });
    }
  }

  // YTD total (months 1..currentMonth in current year, or full year if past)
  const ytdMonths = year < currentYear ? 12 : currentMonth;
  const ytdKeys = Array.from({ length: ytdMonths }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, "0")}`
  );
  const ytdTotal = ytdKeys.reduce((sum, k) => sum + (monthTotals[k] ?? 0), 0);

  res.json({ year, ytdTotal, ytdMonths, monthlySummaries });
});

// ── GET /api/withdrawals ─────────────────────────────────────────────────────

withdrawalRoutes.get("/", async (req, res) => {
  const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();

  await processPendingWithdrawalTransfers();

  const { dividendId, interestId, capGainsDivId } = await getSpecialCategoryIds();

  const startOfYear = new Date(`${year}-01-01T00:00:00.000Z`);
  const endOfYear = new Date(`${year}-12-31T23:59:59.999Z`);

  const accountSelect = { id: true, name: true, color: true, type: true };

  // Income rows
  const incomeRows = await prisma.income.findMany({
    where: {
      date: { gte: startOfYear, lte: endOfYear },
      account: { isJoint: false },
      OR: [
        { subtype: "DIVIDEND", isCashReceived: true },
        ...(dividendId
          ? [{ categoryId: dividendId, isCashReceived: true, subtype: { not: "DIVIDEND" as const } }]
          : []),
        ...(interestId ? [{ categoryId: interestId }] : []),
        ...(capGainsDivId ? [{ categoryId: capGainsDivId }] : []),
        { subtype: "CAPITAL_GAIN" as const, account: { type: { in: ["CHECKING", "SAVINGS"] } } },
        { subtype: "RETURN_OF_CAPITAL" as const },
      ],
    },
    include: {
      account: { select: accountSelect },
      category: { select: { name: true } },
    },
    orderBy: { date: "desc" },
  });

  // INVESTMENT→BANKING transfer rows (withdrawals)
  const outTransferRows = await prisma.transfer.findMany({
    where: {
      date: { gte: startOfYear, lte: endOfYear },
      isConfirmed: true,
      fromAccount: { type: "INVESTMENT", isJoint: false },
      toAccount: { type: { in: ["CHECKING", "SAVINGS"] }, isJoint: false },
    },
    include: {
      fromAccount: { select: accountSelect },
      toAccount: { select: accountSelect },
    },
    orderBy: { date: "desc" },
  });

  // BANKING→INVESTMENT transfer rows (reinvestments — shown as negative offsets)
  const inTransferRows = await prisma.transfer.findMany({
    where: {
      date: { gte: startOfYear, lte: endOfYear },
      isConfirmed: true,
      fromAccount: { type: { in: ["CHECKING", "SAVINGS"] }, isJoint: false },
      toAccount: { type: "INVESTMENT", isJoint: false },
    },
    include: {
      fromAccount: { select: accountSelect },
      toAccount: { select: accountSelect },
    },
    orderBy: { date: "desc" },
  });

  // Map income rows to WithdrawalEvent
  const incomeEvents: WithdrawalEvent[] = incomeRows.map((row) => {
    let type: WithdrawalType = "dividend";
    if (row.subtype === "CAPITAL_GAIN") type = "sale_proceeds";
    else if (row.subtype === "RETURN_OF_CAPITAL") type = "return_of_capital";
    else if (row.categoryId === interestId) type = "interest";
    else if (row.categoryId === capGainsDivId) type = "cap_gains_dist";

    return {
      id: `income-${row.id}`,
      date: row.date.toISOString(),
      type,
      description: row.source ?? row.category?.name ?? "",
      account: row.account,
      amount: row.amount.toString(),
      isEditable: false,
      incomeId: row.id,
    };
  });

  // Map INVESTMENT→BANKING transfer rows (withdrawals, positive amount)
  const transferEvents: WithdrawalEvent[] = outTransferRows.map((row) => ({
    id: `transfer-${row.id}`,
    date: row.date.toISOString(),
    type: "transfer" as WithdrawalType,
    description: row.description,
    account: row.fromAccount,
    toAccount: row.toAccount,
    amount: row.amount.toString(),
    isEditable: true,
    transferId: row.id,
  }));

  // Map BANKING→INVESTMENT transfer rows (reinvestments, stored as positive but rendered negative)
  const reinvestmentEvents: WithdrawalEvent[] = inTransferRows.map((row) => ({
    id: `transfer-${row.id}`,
    date: row.date.toISOString(),
    type: "reinvestment" as WithdrawalType,
    description: row.description,
    account: row.fromAccount,
    toAccount: row.toAccount,
    amount: row.amount.toString(),
    isEditable: true,
    transferId: row.id,
  }));

  // Merge all events and sort descending by date
  const events = [...incomeEvents, ...transferEvents, ...reinvestmentEvents].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  res.json(events);
});
