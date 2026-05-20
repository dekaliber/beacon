import { prisma } from "../db/client.js";

function getEtDate(): { year: number; month: number; day: number } {
  const etString = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const d = new Date(etString);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export async function takeNetWorthSnapshot(): Promise<void> {
  const { year, month, day } = getEtDate();
  // Store as UTC midnight of the ET calendar date
  const snapshotDate = new Date(Date.UTC(year, month - 1, day));
  // Noon value used for CC cutoff date comparisons (mirrors dashboard.ts)
  const todayNoon = new Date(year, month - 1, day, 12, 0, 0);

  const users = await prisma.account.findMany({
    where: { userId: { not: null }, isActive: true },
    select: { userId: true },
    distinct: ["userId"],
  });

  for (const { userId } of users) {
    if (!userId) continue;
    try {
      await snapshotForUser(userId, snapshotDate, year, month, day, todayNoon);
    } catch (err) {
      console.error(`net-worth snapshot failed for user ${userId}:`, err);
    }
  }
}

async function snapshotForUser(
  userId: string,
  snapshotDate: Date,
  todayYear: number,
  todayMonth: number,
  todayDay: number,
  todayNoon: Date
): Promise<void> {
  // ── 1. Banking cash ────────────────────────────────────────────────────────
  const bankingAccounts = await prisma.account.findMany({
    where: { userId, isActive: true, isHidden: false, type: { in: ["CHECKING", "SAVINGS"] } },
    select: { id: true, type: true, balance: true },
  });
  const bankingCash = bankingAccounts.reduce((s, a) => s + parseFloat(a.balance.toString()), 0);

  // ── 2. Investment holdings + settlement cash ───────────────────────────────
  const investmentAccounts = await prisma.account.findMany({
    where: { userId, isActive: true, isHidden: false, type: "INVESTMENT" },
    select: {
      id: true,
      cashBalance: true,
      holdings: { select: { ticker: true, lots: { select: { quantity: true } } } },
      manualInvestments: { select: { marketValue: true } },
    },
  });

  const allTickers = [...new Set(investmentAccounts.flatMap((a) => a.holdings.map((h) => h.ticker)))];
  const prices = await prisma.tickerPrice.findMany({
    where: { ticker: { in: allTickers } },
    select: { ticker: true, price: true },
  });
  const priceMap = new Map(prices.map((p) => [p.ticker, parseFloat(p.price.toString())]));

  let investments = 0;
  let investmentCash = 0;
  const accountValues: { accountId: string; accountType: string; value: number }[] = [];

  for (const acct of investmentAccounts) {
    let holdingsValue = 0;
    for (const holding of acct.holdings) {
      const price = priceMap.get(holding.ticker);
      if (price == null) continue;
      const qty = holding.lots.reduce((s, l) => s + parseFloat(l.quantity.toString()), 0);
      holdingsValue += qty * price;
    }
    for (const m of acct.manualInvestments) {
      holdingsValue += parseFloat(m.marketValue.toString());
    }
    const cashVal = acct.cashBalance != null ? parseFloat(acct.cashBalance.toString()) : 0;
    investments += holdingsValue;
    investmentCash += cashVal;
    accountValues.push({ accountId: acct.id, accountType: "INVESTMENT", value: holdingsValue + cashVal });
  }

  for (const acct of bankingAccounts) {
    accountValues.push({ accountId: acct.id, accountType: acct.type, value: parseFloat(acct.balance.toString()) });
  }

  // ── 3. Credit card outstanding balances ────────────────────────────────────
  const ccAccounts = await prisma.account.findMany({
    where: { userId, isActive: true, isHidden: false, type: "CREDIT_CARD", closingDay: { not: null }, dueDay: { not: null } },
    select: { id: true, closingDay: true, dueDay: true },
  });

  function ccCutoff(closingDay: number, dueDay: number): Date {
    const sameMonth = dueDay > closingDay;
    const paymentMade = todayDay >= dueDay;
    const monthsBack = sameMonth ? (paymentMade ? 0 : 1) : (paymentMade ? 1 : 2);
    return new Date(todayYear, todayMonth - 1 - monthsBack, closingDay, 12, 0, 0);
  }

  let creditCardDebt = 0;
  for (const cc of ccAccounts) {
    const cutoff = ccCutoff(cc.closingDay!, cc.dueDay!);
    const result = await prisma.expense.aggregate({
      where: { accountId: cc.id, date: { gte: cutoff, lte: todayNoon }, parentExpenseId: null },
      _sum: { amount: true },
    });
    const debt = parseFloat((result._sum.amount ?? 0).toString());
    creditCardDebt += debt;
    accountValues.push({ accountId: cc.id, accountType: "CREDIT_CARD", value: -debt });
  }

  const total = investments + investmentCash + bankingCash - creditCardDebt;

  // ── Upsert snapshot + account rows ────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    const snapshot = await tx.netWorthSnapshot.upsert({
      where: { userId_date: { userId, date: snapshotDate } },
      update: { investments, investmentCash, bankingCash, creditCardDebt, total },
      create: { userId, date: snapshotDate, investments, investmentCash, bankingCash, creditCardDebt, total },
    });
    await tx.netWorthAccountSnapshot.deleteMany({ where: { snapshotId: snapshot.id } });
    await tx.netWorthAccountSnapshot.createMany({
      data: accountValues.map((av) => ({
        snapshotId: snapshot.id,
        accountId: av.accountId,
        accountType: av.accountType,
        value: av.value,
      })),
    });
  });
}
