import type { PrismaClient, Prisma } from "@prisma/client";

// Covered-call lot batches for one ticker + account: shares that came from
// assigned CSPs, grouped by the assignment's strike + expiration, with how many
// contracts are still free to write a call against and the lots' weighted cost
// per share. Backs the CC lot picker and the broker import's lot matching.
export interface AssignedBatch {
  strikePrice: string;
  expirationDate: string; // YYYY-MM-DD
  totalContracts: number;
  totalShares: number;
  contractsCovered: number;
  contractsRemaining: number;
  weightedCostPerShare: number | null;
}

export async function getAssignedBatches(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  ticker: string,
  accountId: string,
): Promise<AssignedBatch[]> {
  // All assigned CSPs for this ticker + account. Match either by the CSP's
  // investmentAccountId (the original account) or by lot location (handles
  // cases where shares were transferred to a different account after assignment).
  const assignedCsps = await db.optionsPosition.findMany({
    where: {
      userId,
      optionType: "PUT",
      outcome: "ASSIGNED",
      isActive: true,
      ticker: { symbol: ticker },
      OR: [
        { investmentAccountId: accountId },
        { assignedLots: { some: { holding: { accountId, ticker } } } },
      ],
    },
    select: {
      id: true,
      strikePrice: true,
      expirationDate: true,
      contractsAssigned: true,
      contracts: true,
    },
  });

  if (assignedCsps.length === 0) return [];

  // Group by strikePrice + expirationDate, collecting position IDs per batch
  type BatchKey = string;
  const batchMap = new Map<BatchKey, {
    strikePrice: string;
    expirationDate: string;
    totalContracts: number;
    positionIds: string[];
  }>();

  for (const csp of assignedCsps) {
    const expStr = csp.expirationDate.toISOString().split("T")[0];
    const key: BatchKey = `${csp.strikePrice}|${expStr}`;
    const existing = batchMap.get(key);
    const contracts = csp.contractsAssigned ?? csp.contracts;
    if (existing) {
      existing.totalContracts += contracts;
      existing.positionIds.push(csp.id);
    } else {
      batchMap.set(key, {
        strikePrice: csp.strikePrice.toString(),
        expirationDate: expStr,
        totalContracts: contracts,
        positionIds: [csp.id],
      });
    }
  }

  // For each batch, count open CC contracts and compute weighted avg cost basis
  const batches = await Promise.all(
    Array.from(batchMap.values()).map(async (batch) => {
      const expDate = new Date(batch.expirationDate + "T20:00:00.000Z");

      const [openCcs, lots] = await Promise.all([
        db.optionsPosition.aggregate({
          where: {
            userId,
            optionType: "CALL",
            status: "OPEN",
            isActive: true,
            ticker: { symbol: ticker },
            assignedFromStrikePrice: parseFloat(batch.strikePrice),
            assignedFromExpirationDate: expDate,
          },
          _sum: { contracts: true },
        }),
        db.investmentLot.findMany({
          where: {
            fromOptionsPositionId: { in: batch.positionIds },
            holding: { accountId, ticker },
          },
          select: { quantity: true, costPerShare: true },
        }),
      ]);

      const contractsCovered = openCcs._sum.contracts ?? 0;

      // Weighted average: SUM(qty * cost) / SUM(qty)
      let weightedCostPerShare: number | null = null;
      let totalLotShares = 0;
      if (lots.length > 0) {
        let totalCost = 0;
        for (const lot of lots) {
          const qty = Number(lot.quantity);
          totalLotShares += qty;
          totalCost += qty * Number(lot.costPerShare);
        }
        weightedCostPerShare = totalLotShares > 0 ? totalCost / totalLotShares : null;
      }

      // Use actual lot shares as the cap — shares sold outside the normal CC
      // assignment flow (e.g. a CC that was subsequently assigned) will have
      // reduced/deleted the lot, so lot quantity is ground truth for availability.
      const lotBasedContracts = Math.floor(totalLotShares / 100);
      const contractsRemaining = Math.max(0, Math.min(lotBasedContracts, batch.totalContracts) - contractsCovered);

      if (contractsRemaining === 0 && contractsCovered === 0) return null;

      return {
        strikePrice: batch.strikePrice,
        expirationDate: batch.expirationDate,
        totalContracts: batch.totalContracts,
        totalShares: batch.totalContracts * 100,
        contractsCovered,
        contractsRemaining,
        weightedCostPerShare,
      };
    })
  );

  // Filter out batches with no shares remaining, then sort by strikePrice desc, expirationDate desc
  const activeBatches = batches.filter((b) => b !== null);
  activeBatches.sort((a, b) =>
    parseFloat(b.strikePrice) - parseFloat(a.strikePrice) ||
    b.expirationDate.localeCompare(a.expirationDate)
  );
  return activeBatches;
}
