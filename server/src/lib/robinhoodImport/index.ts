import type { Prisma, OptionsPosition } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getAssignedBatches } from "../assignedBatches.js";
import { rollPosition, RollError, type RollInput } from "../optionsRoll.js";
import { parseImportFile, type ImportFile } from "./schema.js";
import { planImport, type ImportFlags, type ImportPlan, type ImportSnapshot, type PlannedRow, type RollAllocation } from "./plan.js";
import { splitCents } from "./allocate.js";

// Robinhood options import — the server module behind the import modal and, later,
// a custom MCP connector. Nothing here knows about HTTP.
//
//   stageImport(userId, raw, { dryRun })  → parse, dedupe, match, create imported drafts
//   confirmImportedDraft(userId, id, …)   → an open goes live; a roll runs the shared roll
//   confirmImportedDrafts(userId, ids)    → bulk confirm of clean drafts, in fill-time order

export { ImportFileError } from "./schema.js";
export { RollError } from "../optionsRoll.js";

const SOURCE = "robinhood";

export class ConfirmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────────

async function resolveAccountId(userId: string, name: string): Promise<string | null> {
  const accounts = await prisma.account.findMany({
    where: { userId, type: "INVESTMENT", isActive: true, isManaged: false },
    select: { id: true, name: true },
  });
  const exact = accounts.filter((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact.length === 1 ? exact[0].id : null;
}

async function loadSnapshot(userId: string, file: ImportFile): Promise<ImportSnapshot> {
  const accountId = await resolveAccountId(userId, file.account);

  const [known, positions] = await Promise.all([
    prisma.optionsPosition.findMany({
      where: { userId, externalId: { in: file.events.map((e) => e.externalId) } },
      select: { externalId: true },
    }),
    prisma.optionsPosition.findMany({
      where: { userId, isActive: true },
      select: {
        id: true, externalId: true, externalSource: true, rhOptionId: true, optionType: true, strikePrice: true,
        expirationDate: true, contracts: true, openedAt: true, status: true, isDraft: true,
        investmentAccountId: true, ticker: { select: { symbol: true } },
      },
    }),
  ]);

  const callTickers = [...new Set(
    file.events.filter((e) => e.kind === "open" && e.strategy === "covered_call").map((e) => e.ticker.trim().toUpperCase()),
  )];
  const lotBatches: ImportSnapshot["lotBatches"] = new Map();
  const sharesHeld: ImportSnapshot["sharesHeld"] = new Map();
  if (accountId && callTickers.length > 0) {
    for (const t of callTickers) {
      const batches = await getAssignedBatches(prisma, userId, t, accountId);
      lotBatches.set(t, batches.map((b) => ({
        strikePrice: Number(b.strikePrice),
        expirationDate: b.expirationDate,
        contractsRemaining: b.contractsRemaining,
        weightedCostPerShare: b.weightedCostPerShare,
      })));
    }
    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId, ticker: { in: callTickers } },
      select: { ticker: true, lots: { select: { quantity: true } } },
    });
    for (const h of holdings) {
      sharesHeld.set(h.ticker.toUpperCase(), h.lots.reduce((s, l) => s + Number(l.quantity), 0));
    }
  }

  return {
    knownExternalIds: new Set(known.map((k) => k.externalId!)),
    accountId,
    lotBatches,
    sharesHeld,
    positions: positions.map((p) => ({
      id: p.id,
      externalId: p.externalId,
      externalSource: p.externalSource,
      rhOptionId: p.rhOptionId,
      ticker: p.ticker.symbol.toUpperCase(),
      optionType: p.optionType,
      strike: Number(p.strikePrice),
      expiration: p.expirationDate.toISOString().slice(0, 10),
      contracts: p.contracts,
      openedAtMs: p.openedAt.getTime(),
      status: p.status,
      isDraft: p.isDraft,
      investmentAccountId: p.investmentAccountId,
    })),
  };
}

// ── Stage ───────────────────────────────────────────────────────────────────

export interface StageResult {
  dryRun: boolean;
  batchId: string | null;
  account: { name: string; matched: boolean };
  counts: ImportPlan["counts"];
  rows: Array<{
    externalId: string;
    kind: "open" | "roll";
    ticker: string;
    optionType: "CALL" | "PUT";
    strike: number;
    expiration: string;
    openedAt: string;
    contracts: number;
    premiumPerShare: number;
    status: PlannedRow["status"];
    errors: string[];
    flags: ImportFlags;
    lotLinked: boolean;
    positionId: string | null;
  }>;
  skipped: ImportPlan["skipped"];
}

export async function stageImport(userId: string, raw: unknown, opts: { dryRun?: boolean } = {}): Promise<StageResult> {
  const file = parseImportFile(raw);
  const snap = await loadSnapshot(userId, file);
  const plan = planImport(file, snap);
  const dryRun = !!opts.dryRun;

  const createdIds = new Map<string, string>(); // externalId → position id
  let batchId: string | null = null;

  if (!dryRun) {
    await prisma.$transaction(async (tx) => {
      const batch = await tx.optionsImportBatch.create({
        data: {
          userId,
          source: SOURCE,
          generatedAt: file.generatedAt && !Number.isNaN(Date.parse(file.generatedAt)) ? new Date(file.generatedAt) : null,
          counts: plan.counts,
          rawFile: raw as Prisma.InputJsonValue,
        },
      });
      batchId = batch.id;

      const tickerIds = new Map<string, string>();
      for (const row of plan.rows) {
        if (row.status !== "new") continue;
        const tickerId = tickerIds.get(row.ticker) ?? (await ensureTicker(tx, userId, row.ticker));
        tickerIds.set(row.ticker, tickerId);

        // A roll from an open in this same file points at the draft just created.
        let stagedRollFromId: string | null = null;
        if (row.roll?.from?.kind === "position") stagedRollFromId = row.roll.from.id;
        if (row.roll?.from?.kind === "file") stagedRollFromId = createdIds.get(row.roll.from.externalId) ?? null;
        // Spread over several positions: the draft previews the earliest one's
        // basis and account; each new leg takes its own source's on confirm.
        const previewFromId = stagedRollFromId ?? row.roll?.allocations?.[0]?.positionId ?? null;
        const rollFrom = previewFromId
          ? await tx.optionsPosition.findUnique({ where: { id: previewFromId } })
          : null;

        const created = await tx.optionsPosition.create({
          data: {
            userId,
            tickerId,
            optionType: row.optionType,
            side: "SELL",
            strikePrice: row.leg.strike,
            expirationDate: new Date(row.leg.expiration + "T20:00:00.000Z"),
            openedAt: new Date(row.timeMs),
            contracts: row.leg.contracts,
            premiumPerShare: row.leg.premiumPerShare,
            feesOpen: row.leg.feesOpen,
            stockPriceAtOpen: row.leg.stockPriceAtOpen,
            deltaAtOpen: row.leg.deltaAtOpen,
            deltaAtOpenCapturedAt: row.leg.deltaAtOpen != null ? new Date(row.timeMs) : null,
            ivAtOpen: row.leg.ivAtOpen,
            derivedAtOpen: row.leg.stockPriceAtOpen != null || row.leg.deltaAtOpen != null,
            notes: row.leg.notes,
            // A roll's new leg inherits basis, lot link and account from the leg it rolls
            // (set again on confirm by the roll itself); an open takes the matched lot.
            investmentAccountId: rollFrom?.investmentAccountId ?? snap.accountId,
            shareCostBasis: rollFrom ? rollFrom.shareCostBasis : row.lot?.weightedCostPerShare ?? null,
            assignedFromStrikePrice: rollFrom ? rollFrom.assignedFromStrikePrice : row.lot?.strikePrice ?? null,
            assignedFromExpirationDate: rollFrom
              ? rollFrom.assignedFromExpirationDate
              : row.lot ? new Date(row.lot.expirationDate + "T20:00:00.000Z") : null,
            isDraft: true,
            externalSource: SOURCE,
            externalId: row.externalId,
            rhOrderId: row.leg.rhOrderId,
            rhLegId: row.leg.rhLegId,
            rhOptionId: row.leg.rhOptionId,
            importBatchId: batch.id,
            importFlags: row.flags as unknown as Prisma.InputJsonValue,
            stagedRollFromId,
            stagedBuybackPerShare: row.roll?.buybackPerShare ?? null,
            stagedFeesClose: row.roll?.feesClose ?? null,
          },
        });
        createdIds.set(row.externalId, created.id);
      }
    });
  }

  return {
    dryRun,
    batchId,
    account: { name: file.account, matched: snap.accountId != null },
    counts: plan.counts,
    rows: plan.rows.map((r) => ({
      externalId: r.externalId,
      kind: r.kind,
      ticker: r.ticker,
      optionType: r.optionType,
      strike: r.leg.strike,
      expiration: r.leg.expiration,
      openedAt: r.leg.openedAt,
      contracts: r.leg.contracts,
      premiumPerShare: r.leg.premiumPerShare,
      status: r.status,
      errors: r.errors,
      flags: r.flags,
      lotLinked: r.lot != null,
      positionId: createdIds.get(r.externalId) ?? null,
    })),
    skipped: plan.skipped,
  };
}

async function ensureTicker(tx: Prisma.TransactionClient, userId: string, symbol: string): Promise<string> {
  const existing = await tx.optionsTicker.findFirst({ where: { userId, symbol } });
  if (!existing) return (await tx.optionsTicker.create({ data: { userId, symbol } })).id;
  if (!existing.isActive) await tx.optionsTicker.update({ where: { id: existing.id }, data: { isActive: true } });
  return existing.id;
}

/** Newest fill time among imported positions — the `since` for the next export. */
export async function latestImportedFill(userId: string): Promise<string | null> {
  const row = await prisma.optionsPosition.findFirst({
    where: { userId, externalSource: SOURCE },
    orderBy: { openedAt: "desc" },
    select: { openedAt: true },
  });
  return row?.openedAt.toISOString() ?? null;
}

// ── Confirm ─────────────────────────────────────────────────────────────────

export interface ConfirmOpenInput {
  openedAt?: string;
  contracts?: number;
  premiumPerShare?: number;
  stockPriceAtOpen?: number | null;
  deltaAtOpen?: number | null;
  deltaAtOpenCapturedAt?: string | null;
  feesOpen?: number | null;
  shareCostBasis?: number | null;
  assignedFromStrikePrice?: number | null;
  assignedFromExpirationDate?: string | null; // YYYY-MM-DD
}

export type ConfirmRollInput = RollInput & {
  // One position (legacy single match) or how many contracts to close on each.
  rollFromId?: string;
  allocations?: RollAllocation[];
};

const flagsOf = (p: OptionsPosition) => (p.importFlags ?? { kind: "open" }) as unknown as ImportFlags;

async function loadDraft(userId: string, id: string) {
  const draft = await prisma.optionsPosition.findFirst({
    where: { id, userId, isActive: true, isDraft: true, externalId: { not: null } },
  });
  if (!draft) throw new ConfirmError(404, "Imported draft not found");
  return draft;
}

async function stampOpportunityCostStart(tx: Prisma.TransactionClient, tickerId: string, openedAt: Date) {
  await tx.optionsTicker.updateMany({
    where: { id: tickerId, opportunityCostStartDate: null },
    data: { opportunityCostStartDate: openedAt },
  });
}

/** Confirm an imported open: the draft goes live with its stored fill (or the edited values). */
export async function confirmImportedOpen(userId: string, id: string, input: ConfirmOpenInput = {}) {
  const draft = await loadDraft(userId, id);
  const flags = flagsOf(draft);
  if (flags.kind === "roll") throw new ConfirmError(400, "This draft is a roll; confirm it with the roll form.");

  const { assignedFromExpirationDate, deltaAtOpenCapturedAt, openedAt, ...rest } = input;
  const data: Prisma.OptionsPositionUncheckedUpdateInput = {
    ...rest,
    isDraft: false,
    ...(openedAt !== undefined ? { openedAt: new Date(openedAt) } : {}),
    ...(deltaAtOpenCapturedAt !== undefined
      ? { deltaAtOpenCapturedAt: deltaAtOpenCapturedAt ? new Date(deltaAtOpenCapturedAt) : null }
      : {}),
    ...(assignedFromExpirationDate !== undefined
      ? { assignedFromExpirationDate: assignedFromExpirationDate ? new Date(assignedFromExpirationDate + "T20:00:00.000Z") : null }
      : {}),
  };
  return prisma.$transaction(async (tx) => {
    const updated = await tx.optionsPosition.update({ where: { id: draft.id }, data, include: { ticker: true, group: true } });
    await stampOpportunityCostStart(tx, updated.tickerId, updated.openedAt);
    return updated;
  });
}

/**
 * Confirm an imported roll. Each source position is rolled for its allocated
 * contracts into its own new leg (its own roll chain), all at the fill time.
 * The earliest source's new leg is the draft itself, promoted in place; the
 * others are new rows carrying the same broker ids. Close and open fees are
 * split across the legs by contracts, in whole cents that sum to the total.
 */
export async function confirmImportedRoll(userId: string, id: string, input: ConfirmRollInput) {
  const draft = await loadDraft(userId, id);
  if (flagsOf(draft).kind !== "roll") throw new ConfirmError(400, "This draft is not a roll.");

  const requested: Array<{ positionId: string; contracts: number | null }> = input.allocations?.length
    ? input.allocations
    : input.rollFromId
      ? [{ positionId: input.rollFromId, contracts: input.contracts ?? null }]
      : [];
  if (requested.length === 0) throw new ConfirmError(400, "Pick the position this roll closes.");
  const ids = requested.map((a) => a.positionId);
  if (new Set(ids).size !== ids.length) throw new ConfirmError(400, "A position is listed twice.");

  const sources = await prisma.optionsPosition.findMany({ where: { id: { in: ids }, userId, isActive: true } });
  const byId = new Map(sources.map((p) => [p.id, p]));
  const legs = requested.map((a) => {
    const existing = byId.get(a.positionId);
    if (!existing) throw new ConfirmError(404, "The position being rolled was not found.");
    if (existing.isDraft) throw new ConfirmError(409, "Confirm the position being rolled first; it is still a draft.");
    if (existing.status !== "OPEN") throw new ConfirmError(409, "The position being rolled is no longer open.");
    if (existing.tickerId !== draft.tickerId || existing.optionType !== draft.optionType) {
      throw new ConfirmError(409, "The position being rolled is a different ticker or option type.");
    }
    const contracts = a.contracts ?? existing.contracts;
    if (!Number.isInteger(contracts) || contracts < 1 || contracts > existing.contracts) {
      throw new ConfirmError(409, `A position being rolled holds ${existing.contracts} contract${existing.contracts === 1 ? "" : "s"}; can't roll ${contracts}.`);
    }
    return { existing, contracts };
  });
  const total = legs.reduce((s, l) => s + l.contracts, 0);
  if (total !== draft.contracts) {
    throw new ConfirmError(409, `The roll is ${draft.contracts} contract${draft.contracts === 1 ? "" : "s"}; the positions picked add up to ${total}.`);
  }
  legs.sort((a, b) => a.existing.openedAt.getTime() - b.existing.openedAt.getTime() || a.existing.id.localeCompare(b.existing.id));

  const weights = legs.map((l) => l.contracts);
  const feesClose = splitCents(input.feesClose, weights);
  const feesOpen = splitCents(input.newFeesOpen, weights);
  const sibling: Partial<Prisma.OptionsPositionUncheckedCreateInput> = {
    externalSource: draft.externalSource,
    rhOrderId: draft.rhOrderId,
    rhLegId: draft.rhLegId,
    rhOptionId: draft.rhOptionId,
    importBatchId: draft.importBatchId,
    ivAtOpen: draft.ivAtOpen,
    derivedAtOpen: draft.derivedAtOpen,
    notes: draft.notes,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const results = [];
      for (let i = 0; i < legs.length; i++) {
        const { existing, contracts } = legs[i];
        results.push(
          await rollPosition(
            tx,
            userId,
            existing,
            { ...input, contracts, feesClose: feesClose[i], newFeesOpen: feesOpen[i] },
            i === 0 ? { intoDraftId: draft.id } : { newLegExtra: sibling },
          ),
        );
      }
      const { needsMatch: _n, matchCandidateIds: _m, rollAllocations: _a, ...flags } = flagsOf(draft);
      await tx.optionsPosition.update({
        where: { id: draft.id },
        data: { importFlags: flags as unknown as Prisma.InputJsonValue },
      });
      return { ...results[0], legs: results };
    });
  } catch (e) {
    if (e instanceof RollError) throw new ConfirmError(e.status, e.message);
    throw e;
  }
}

/** The staged allocation of a roll draft, or null when it still needs a match. */
function stagedAllocations(d: OptionsPosition): RollAllocation[] | null {
  const f = flagsOf(d);
  if (f.rollAllocations?.length) return f.rollAllocations;
  if (d.stagedRollFromId) return [{ positionId: d.stagedRollFromId, contracts: d.contracts }];
  return null;
}

/** Why a draft can't go through bulk confirm, or null when it's clean. */
export function bulkBlocker(draft: OptionsPosition): string | null {
  const f = flagsOf(draft);
  if (f.possibleDuplicateOfId) return "possible duplicate";
  if (f.lotChoices?.length && draft.assignedFromStrikePrice == null) return "lot to pick";
  if (f.kind === "roll" && !stagedAllocations(draft)) return "needs a match";
  return null;
}

/** Bulk confirm with the stored fills, in fill-time order. Rows with flags are left for one-by-one review. */
export async function confirmImportedDrafts(userId: string, ids: string[]) {
  const drafts = await prisma.optionsPosition.findMany({
    where: { id: { in: ids }, userId, isActive: true, isDraft: true, externalId: { not: null } },
    orderBy: [{ openedAt: "asc" }, { id: "asc" }],
  });
  const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
  for (const d of drafts) {
    const blocker = bulkBlocker(d);
    if (blocker) {
      results.push({ id: d.id, ok: false, reason: blocker });
      continue;
    }
    try {
      if (flagsOf(d).kind === "roll") {
        await confirmImportedRoll(userId, d.id, {
          allocations: stagedAllocations(d)!,
          closedAt: d.openedAt,
          closePremiumPerShare: d.stagedBuybackPerShare != null ? Number(d.stagedBuybackPerShare) : null,
          feesClose: d.stagedFeesClose != null ? Number(d.stagedFeesClose) : null,
          newPremiumPerShare: Number(d.premiumPerShare),
          newStrikePrice: Number(d.strikePrice),
          newExpirationDate: d.expirationDate.toISOString().slice(0, 10),
          newStockPriceAtOpen: d.stockPriceAtOpen != null ? Number(d.stockPriceAtOpen) : null,
          newDeltaAtOpen: d.deltaAtOpen != null ? Number(d.deltaAtOpen) : null,
          newDeltaAtOpenCapturedAt: d.deltaAtOpenCapturedAt,
          newFeesOpen: d.feesOpen != null ? Number(d.feesOpen) : null,
        });
      } else {
        await confirmImportedOpen(userId, d.id);
      }
      results.push({ id: d.id, ok: true });
    } catch (e) {
      results.push({ id: d.id, ok: false, reason: e instanceof Error ? e.message : "Failed" });
    }
  }
  return results;
}

