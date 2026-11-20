import type { ImportEvent, ImportFile } from "./schema.js";

// Pure planning step of the Robinhood import: given the parsed file and a
// snapshot of what the app already holds, decide what each event becomes —
// without touching the database. Kept pure so the acceptance cases run as
// plain unit tests (plan.test.ts).

export interface SnapshotPosition {
  id: string;
  externalId: string | null;
  // Set on anything the import wrote, including the extra legs of a roll spread
  // over several positions (those carry no externalId of their own).
  externalSource: string | null;
  rhOptionId: string | null;
  ticker: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string; // YYYY-MM-DD
  contracts: number;
  openedAtMs: number;
  status: "OPEN" | "CLOSED" | "EXPIRED" | "ASSIGNED";
  isDraft: boolean;
  investmentAccountId: string | null;
}

export interface SnapshotLotBatch {
  strikePrice: number;
  expirationDate: string; // YYYY-MM-DD
  contractsRemaining: number;
  weightedCostPerShare: number | null;
}

export interface ImportSnapshot {
  // Every externalId the app has ever stored, soft-deleted rows included.
  knownExternalIds: Set<string>;
  // Active positions (any status, drafts included).
  positions: SnapshotPosition[];
  // The investment account the file's `account` resolved to, if any.
  accountId: string | null;
  // CSP-assignment lot batches in that account, per ticker (covered-call lot matching).
  lotBatches: Map<string, SnapshotLotBatch[]>;
  // Shares held in that account, per ticker (the "uncovered?" check). Absent ticker = 0.
  sharesHeld: Map<string, number>;
}

export type RollSource = { kind: "position"; id: string } | { kind: "file"; externalId: string };

export interface ImportFlags {
  kind: "open" | "roll";
  possibleDuplicateOfId?: string;
  needsMatch?: string; // reason
  matchCandidateIds?: string[];
  uncovered?: boolean;
  lotChoices?: Array<{ strikePrice: number; expirationDate: string; contractsRemaining: number; weightedCostPerShare: number | null }>;
  robinhoodAvgCost?: number;
  netCreditPerShare?: number;
  closeLeg?: { strike: number; expiration: string; optionId: string };
  // A roll whose contracts are spread over several open positions: how many
  // contracts it closes on each. Set instead of a single staged source.
  rollAllocations?: RollAllocation[];
}

export interface RollAllocation {
  positionId: string;
  contracts: number;
}

export interface PlannedRow {
  index: number; // position in the file's events array
  externalId: string;
  kind: "open" | "roll";
  ticker: string;
  optionType: "CALL" | "PUT";
  status: "new" | "already_imported" | "invalid";
  errors: string[];
  timeMs: number;
  leg: {
    strike: number;
    expiration: string;
    openedAt: string; // ISO, as given (with offset)
    contracts: number;
    premiumPerShare: number;
    stockPriceAtOpen: number | null;
    deltaAtOpen: number | null;
    ivAtOpen: number | null;
    feesOpen: number | null;
    notes: string | null;
    rhOrderId: string;
    rhLegId: string;
    rhOptionId: string;
  };
  // Covered calls only: the assignment lot linked automatically (exactly one fit).
  lot: { strikePrice: number; expirationDate: string; weightedCostPerShare: number | null } | null;
  roll: {
    buybackPerShare: number;
    feesClose: number | null;
    // One source (a position or an open in this file), or several positions.
    from: RollSource | null;
    allocations: RollAllocation[] | null;
  } | null;
  flags: ImportFlags;
}

export interface ImportPlan {
  rows: PlannedRow[]; // in fill-time order
  skipped: ImportFile["skipped"];
  counts: {
    created: number;
    alreadyImported: number;
    possibleDuplicate: number;
    needsMatch: number;
    invalid: number;
    skipped: number;
  };
}

const OFFSET_RE = /([+-]\d{2}:\d{2}|Z)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const etDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** ET calendar date (YYYY-MM-DD) of an instant. */
export function etDate(ms: number): string {
  return etDateFmt.format(new Date(ms));
}

const sameStrike = (a: number, b: number) => Math.abs(a - b) < 0.005;

export function planImport(file: ImportFile, snap: ImportSnapshot): ImportPlan {
  const rows: PlannedRow[] = file.events.map((e, index) => toRow(e, index, snap));
  // Fill-time order, so an open earlier in the file exists before a roll of it is planned.
  rows.sort((a, b) => a.timeMs - b.timeMs || a.index - b.index);

  // Mutable working state across rows of this file.
  const lotRemaining = new Map<string, SnapshotLotBatch[]>();
  for (const [t, batches] of snap.lotBatches) lotRemaining.set(t, batches.map((b) => ({ ...b })));
  const plannedCallContracts = new Map<string, number>();
  const plannedOpenByOptionId = new Map<string, string>(); // rhOptionId → externalId (new opens in this file)
  const claimed = new Map<string, number>(); // position id → contracts already rolled by earlier rows

  for (const row of rows) {
    if (row.status !== "new") continue;

    // Possible duplicate of a manually entered position (same terms, same ET day).
    const dup = snap.positions.find(
      (p) =>
        p.externalId == null &&
        p.externalSource == null &&
        p.ticker === row.ticker &&
        p.optionType === row.optionType &&
        sameStrike(p.strike, row.leg.strike) &&
        p.expiration === row.leg.expiration &&
        p.contracts === row.leg.contracts &&
        etDate(p.openedAtMs) === etDate(row.timeMs),
    );
    if (dup) row.flags.possibleDuplicateOfId = dup.id;

    if (row.kind === "open") {
      plannedOpenByOptionId.set(row.leg.rhOptionId, row.externalId);
      if (row.optionType === "CALL") planCoveredCall(row, snap, lotRemaining, plannedCallContracts);
    } else {
      matchRoll(row, snap, plannedOpenByOptionId, claimed);
    }
  }

  const counts = {
    created: rows.filter((r) => r.status === "new").length,
    alreadyImported: rows.filter((r) => r.status === "already_imported").length,
    possibleDuplicate: rows.filter((r) => r.status === "new" && r.flags.possibleDuplicateOfId).length,
    needsMatch: rows.filter((r) => r.status === "new" && r.flags.needsMatch).length,
    invalid: rows.filter((r) => r.status === "invalid").length,
    skipped: file.skipped.length,
  };
  return { rows, skipped: file.skipped, counts };
}

function toRow(e: ImportEvent, index: number, snap: ImportSnapshot): PlannedRow {
  const optionType = e.strategy === "covered_call" ? "CALL" : "PUT";
  const ticker = e.ticker.trim().toUpperCase();
  const errors: string[] = [];

  const when = e.kind === "open" ? e.openedAt : e.rolledAt;
  const timeMs = OFFSET_RE.test(when) ? Date.parse(when) : NaN;
  if (Number.isNaN(timeMs)) errors.push(`${e.kind === "open" ? "openedAt" : "rolledAt"} must be a timestamp with an offset`);

  const legSrc = e.kind === "open" ? e : e.open;
  const leg: PlannedRow["leg"] = {
    strike: legSrc.strike,
    expiration: legSrc.expiration,
    openedAt: when,
    contracts: e.contracts,
    premiumPerShare: legSrc.premiumPerShare,
    stockPriceAtOpen: legSrc.stockPriceAtOpen ?? null,
    deltaAtOpen: legSrc.deltaAtOpen ?? null,
    ivAtOpen: legSrc.ivAtOpen ?? null,
    feesOpen: legSrc.fees ?? null,
    notes: e.notes ?? "Imported from Robinhood",
    rhOrderId: e.robinhood.orderId,
    rhLegId: e.kind === "open" ? e.robinhood.legId : e.open.legId,
    rhOptionId: e.kind === "open" ? e.robinhood.optionId : e.open.optionId,
  };

  if (!/^[A-Z][A-Z.]{0,9}$/.test(ticker)) errors.push(`Invalid ticker "${e.ticker}"`);
  validateLeg(leg, timeMs, errors, "");
  if (leg.deltaAtOpen != null && Math.sign(leg.deltaAtOpen) === (optionType === "PUT" ? 1 : -1)) {
    errors.push(`deltaAtOpen must be ${optionType === "PUT" ? "negative for a put" : "positive for a call"}`);
  }

  let roll: PlannedRow["roll"] = null;
  const flags: ImportFlags = { kind: e.kind };
  if (e.kind === "roll") {
    if (!(e.close.strike > 0)) errors.push("close.strike must be > 0");
    if (!DATE_RE.test(e.close.expiration)) errors.push("close.expiration must be YYYY-MM-DD");
    if (!(e.close.buybackPerShare >= 0)) errors.push("close.buybackPerShare must be ≥ 0");
    roll = { buybackPerShare: e.close.buybackPerShare, feesClose: e.close.fees ?? null, from: null, allocations: null };
    flags.netCreditPerShare = round4(e.open.premiumPerShare - e.close.buybackPerShare);
    flags.closeLeg = { strike: e.close.strike, expiration: e.close.expiration, optionId: e.close.optionId };
  } else if (e.robinhoodAvgCost != null) {
    flags.robinhoodAvgCost = e.robinhoodAvgCost;
  }

  const status: PlannedRow["status"] = snap.knownExternalIds.has(e.externalId)
    ? "already_imported"
    : errors.length > 0
      ? "invalid"
      : "new";

  return { index, externalId: e.externalId, kind: e.kind, ticker, optionType, status, errors, timeMs, leg, lot: null, roll, flags };
}

function validateLeg(leg: PlannedRow["leg"], timeMs: number, errors: string[], prefix: string) {
  if (!(leg.strike > 0)) errors.push(`${prefix}strike must be > 0`);
  if (!Number.isInteger(leg.contracts) || leg.contracts <= 0) errors.push("contracts must be a positive integer");
  if (!(leg.premiumPerShare > 0)) errors.push(`${prefix}premiumPerShare must be > 0`);
  if (!DATE_RE.test(leg.expiration) || Number.isNaN(Date.parse(leg.expiration))) {
    errors.push(`${prefix}expiration must be YYYY-MM-DD`);
  } else if (!Number.isNaN(timeMs) && leg.expiration < etDate(timeMs)) {
    errors.push(`${prefix}expiration is before the fill date`);
  }
  if (leg.stockPriceAtOpen != null && !(leg.stockPriceAtOpen > 0)) errors.push("stockPriceAtOpen must be > 0");
}

function planCoveredCall(
  row: PlannedRow,
  snap: ImportSnapshot,
  lotRemaining: Map<string, SnapshotLotBatch[]>,
  plannedCallContracts: Map<string, number>,
) {
  const n = row.leg.contracts;

  // Lot matching: exactly one assignment batch with room → link it (its basis comes along).
  const batches = (lotRemaining.get(row.ticker) ?? []).filter((b) => b.contractsRemaining > 0);
  const fits = batches.filter((b) => b.contractsRemaining >= n);
  if (fits.length === 1) {
    const b = fits[0];
    row.lot = { strikePrice: b.strikePrice, expirationDate: b.expirationDate, weightedCostPerShare: b.weightedCostPerShare };
    b.contractsRemaining -= n;
  } else if (fits.length > 1) {
    row.flags.lotChoices = fits.map((b) => ({ ...b }));
  }

  // Uncovered? Shares in the account vs. calls already written against them.
  const openCalls = snap.positions
    .filter(
      (p) =>
        p.ticker === row.ticker &&
        p.optionType === "CALL" &&
        p.status === "OPEN" &&
        !p.isDraft &&
        (snap.accountId == null || p.investmentAccountId == null || p.investmentAccountId === snap.accountId),
    )
    .reduce((s, p) => s + p.contracts, 0);
  const planned = plannedCallContracts.get(row.ticker) ?? 0;
  const shares = snap.sharesHeld.get(row.ticker) ?? 0;
  if (shares - 100 * (openCalls + planned) < 100 * n) row.flags.uncovered = true;
  plannedCallContracts.set(row.ticker, planned + n);
}

function matchRoll(
  row: PlannedRow,
  snap: ImportSnapshot,
  plannedOpenByOptionId: Map<string, string>,
  claimed: Map<string, number>,
) {
  const close = row.flags.closeLeg!;
  const n = row.leg.contracts;
  const avail = (p: SnapshotPosition) => p.contracts - (claimed.get(p.id) ?? 0);
  const claim = (id: string, k: number) => claimed.set(id, (claimed.get(id) ?? 0) + k);
  let ambiguousCount = 0;

  // 1. An open earlier in this same file.
  const fileOpen = plannedOpenByOptionId.get(close.optionId);
  if (fileOpen) {
    row.roll!.from = { kind: "file", externalId: fileOpen };
    return;
  }

  // Resolve one tier of candidates: one position that holds enough, or —
  // when they add up to exactly the roll — all of them. Never guess between two.
  const resolve = (cands: SnapshotPosition[]): "matched" | "ambiguous" | "none" => {
    const open = cands.filter((p) => avail(p) > 0);
    if (open.length === 0) return "none";
    const total = open.reduce((s, p) => s + avail(p), 0);
    if (open.length > 1 && total === n) {
      const ordered = [...open].sort((a, b) => a.openedAtMs - b.openedAtMs || a.id.localeCompare(b.id));
      row.roll!.allocations = ordered.map((p) => ({ positionId: p.id, contracts: avail(p) }));
      row.flags.rollAllocations = row.roll!.allocations;
      for (const p of ordered) claim(p.id, avail(p));
      return "matched";
    }
    const fits = open.filter((p) => avail(p) >= n);
    if (fits.length === 1) {
      row.roll!.from = { kind: "position", id: fits[0].id };
      claim(fits[0].id, n);
      return "matched";
    }
    if (fits.length > 1) {
      ambiguousCount = fits.length;
      return "ambiguous";
    }
    return "none";
  };

  // 2. Positions carrying the closing contract's Robinhood id.
  const byOptionId = snap.positions.filter((p) => p.status === "OPEN" && p.rhOptionId === close.optionId);
  const idResult = resolve(byOptionId);
  if (idResult === "matched") return;

  // 3. Live open positions with the closing leg's terms.
  const live = snap.positions.filter(
    (p) => p.status === "OPEN" && !p.isDraft && p.ticker === row.ticker && p.optionType === row.optionType,
  );
  const byTerms = live.filter(
    (p) =>
      sameStrike(p.strike, close.strike) &&
      p.expiration === close.expiration &&
      (snap.accountId == null || p.investmentAccountId == null || p.investmentAccountId === snap.accountId),
  );
  const termsResult = idResult === "ambiguous" ? "ambiguous" : resolve(byTerms);
  if (termsResult === "matched") return;

  // 4. Leave it to review.
  const held = byTerms.reduce((s, p) => s + Math.max(avail(p), 0), 0);
  row.flags.needsMatch =
    termsResult === "ambiguous"
      ? `${ambiguousCount} open positions match the closing leg`
      : byTerms.length > 0
        ? `Open positions with the closing leg's terms hold ${held} contract${held === 1 ? "" : "s"}; the roll is ${n}`
        : "No open position matches the closing leg";
  row.flags.matchCandidateIds = live.map((p) => p.id);
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
