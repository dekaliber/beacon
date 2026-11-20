// Acceptance cases from the "Robinhood options import" build brief, run against
// the pure planner. `npm test` in server/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImportFile, ImportFileError } from "./schema.js";
import { planImport, type ImportSnapshot, type SnapshotPosition } from "./plan.js";
import { splitCents } from "./allocate.js";

const ACCOUNT = "acct_rh";

function file(events: unknown[], skipped: unknown[] = []) {
  return parseImportFile({
    schemaVersion: 1,
    source: "robinhood-mcp",
    generatedAt: "2026-11-13T18:40:00-05:00",
    account: "Robinhood",
    events,
    skipped,
  });
}

function snap(over: Partial<ImportSnapshot> = {}): ImportSnapshot {
  return {
    knownExternalIds: new Set(),
    positions: [],
    accountId: ACCOUNT,
    lotBatches: new Map(),
    sharesHeld: new Map(),
    ...over,
  };
}

function pos(over: Partial<SnapshotPosition>): SnapshotPosition {
  return {
    id: "p1",
    externalId: null,
    externalSource: null,
    rhOptionId: null,
    ticker: "CEG",
    optionType: "CALL",
    strike: 280,
    expiration: "2026-11-13",
    contracts: 1,
    openedAtMs: Date.parse("2026-11-06T10:00:00-05:00"),
    status: "OPEN",
    isDraft: false,
    investmentAccountId: ACCOUNT,
    ...over,
  };
}

const nvdaOpen = {
  kind: "open",
  externalId: "rh:6af72417-2107-48be-88c3-bb08cb033db1:fc3874ff-97d8-4716-aaa6-1f5bd34e2293",
  robinhood: {
    orderId: "6af72417-2107-48be-88c3-bb08cb033db1",
    legId: "fc3874ff-97d8-4716-aaa6-1f5bd34e2293",
    optionId: "b4ef2ee1-5416-402c-953c-4e2770d99866",
  },
  ticker: "NVDA",
  strategy: "cash_secured_put",
  strike: 140.0,
  expiration: "2026-11-20",
  openedAt: "2026-11-13T09:55:36-05:00",
  contracts: 1,
  premiumPerShare: 1.6,
  stockPriceAtOpen: 161.47,
  stockPriceRange: [161.42, 162.8],
  deltaAtOpen: -0.13,
  ivAtOpen: 0.99,
  costBasisPerShare: null,
  fees: null,
  notes: "Imported from Robinhood",
};

function roll(
  id: string,
  ticker: string,
  strategy: "covered_call" | "cash_secured_put",
  at: string,
  close: [number, string, number],
  open: [number, string, number],
  closeOptionId = `opt-${id}-close`,
) {
  return {
    kind: "roll",
    externalId: `rh:${id}`,
    robinhood: { orderId: id },
    ticker,
    strategy,
    rolledAt: at,
    contracts: 1,
    netCreditPerShare: Math.round((open[2] - close[2]) * 100) / 100,
    close: { legId: `${id}-c`, optionId: closeOptionId, strike: close[0], expiration: close[1], buybackPerShare: close[2] },
    open: {
      legId: `${id}-o`,
      optionId: `opt-${id}-open`,
      strike: open[0],
      expiration: open[1],
      premiumPerShare: open[2],
      stockPriceAtOpen: null,
      deltaAtOpen: null,
      ivAtOpen: null,
      costBasisPerShare: null,
      fees: null,
    },
  };
}

const cegRoll = roll("6af71775-a90b-48db-854f-3127d3e851b0", "CEG", "covered_call", "2026-11-13T09:40:39-05:00", [280, "2026-11-13", 4.06], [290, "2026-11-20", 4.66]);

test("1: NVDA sell-to-open becomes a new CSP draft with its fill values", () => {
  const plan = planImport(file([nvdaOpen]), snap());
  const r = plan.rows[0];
  assert.equal(r.status, "new");
  assert.equal(r.kind, "open");
  assert.equal(r.optionType, "PUT");
  assert.equal(r.timeMs, Date.parse("2026-11-13T14:55:36Z"));
  assert.equal(r.leg.stockPriceAtOpen, 161.47);
  assert.equal(r.leg.deltaAtOpen, -0.13);
  assert.equal(r.leg.ivAtOpen, 0.99);
  assert.equal(r.lot, null); // CSPs carry no basis
  assert.equal(plan.counts.created, 1);
});

test("2: CEG roll matches the open $280 call by terms; net credit $0.60", () => {
  const plan = planImport(file([cegRoll]), snap({ positions: [pos({ id: "ceg280" })] }));
  const r = plan.rows[0];
  assert.equal(r.status, "new");
  assert.deepEqual(r.roll?.from, { kind: "position", id: "ceg280" });
  assert.equal(r.roll?.buybackPerShare, 4.06);
  assert.equal(r.flags.netCreditPerShare, 0.6);
  assert.equal(r.flags.needsMatch, undefined);
  assert.equal(r.leg.strike, 290);
});

test("2b: a stored Robinhood optionId match wins over terms", () => {
  const ev = { ...cegRoll, close: { ...cegRoll.close, optionId: "rh-opt-280" } };
  const plan = planImport(
    file([ev]),
    snap({ positions: [pos({ id: "byTerms" }), pos({ id: "byOptionId", rhOptionId: "rh-opt-280", strike: 999 })] }),
  );
  assert.deepEqual(plan.rows[0].roll?.from, { kind: "position", id: "byOptionId" });
});

test("3–5: NOW, AVGO and the even RKLB roll plan cleanly", () => {
  const events = [
    roll("6af7331c", "NOW", "cash_secured_put", "2026-11-13T11:31:59-05:00", [102, "2026-11-13", 1.37], [100, "2026-11-20", 2.37]),
    roll("6af47fb9", "AVGO", "covered_call", "2026-11-11T09:46:18-05:00", [340, "2026-11-13", 13.1], [370, "2026-12-11", 14.11]),
    roll("6af47e6c", "RKLB", "covered_call", "2026-11-11T09:41:06-05:00", [61, "2026-11-13", 5.32], [64, "2026-11-27", 5.32]),
  ];
  const positions = [
    pos({ id: "now102", ticker: "NOW", optionType: "PUT", strike: 102 }),
    pos({ id: "avgo340", ticker: "AVGO", strike: 340 }),
    pos({ id: "rklb61", ticker: "RKLB", strike: 61 }),
  ];
  const plan = planImport(file(events), snap({ positions }));
  const by = Object.fromEntries(plan.rows.map((r) => [r.ticker, r]));
  assert.equal(by.NOW.flags.netCreditPerShare, 1);
  assert.equal(by.AVGO.flags.netCreditPerShare, 1.01);
  assert.equal(by.RKLB.flags.netCreditPerShare, 0);
  for (const r of plan.rows) assert.equal(r.status, "new");
  // Fill-time order: RKLB 09:41 then AVGO 09:46 on 11/11, NOW on 11/13.
  assert.deepEqual(plan.rows.map((r) => r.ticker), ["RKLB", "AVGO", "NOW"]);
});

test("6: CRWV close-then-open is two orders — skipped close, new covered call, no roll", () => {
  const crwvSale = {
    ...nvdaOpen,
    externalId: "rh:6af755ac:leg",
    robinhood: { orderId: "6af755ac", legId: "leg", optionId: "crwv-60-1120" },
    ticker: "CRWV",
    strategy: "covered_call",
    strike: 60,
    expiration: "2026-11-20",
    openedAt: "2026-11-13T14:09:52-05:00",
    premiumPerShare: 1.0,
    deltaAtOpen: 0.2,
  };
  const plan = planImport(
    file([crwvSale], [{ robinhoodOrderId: "6af75560", reason: "standalone close (out of scope)", summary: "CRWV 11/13 $60 call bought to close at $0.01" }]),
    snap({ sharesHeld: new Map([["CRWV", 100]]) }),
  );
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].kind, "open");
  assert.equal(plan.rows[0].roll, null);
  assert.equal(plan.counts.skipped, 1);
});

test("7: re-uploading the same file marks every row already imported", () => {
  const f = file([nvdaOpen, cegRoll]);
  const plan = planImport(f, snap({ knownExternalIds: new Set(f.events.map((e) => e.externalId)) }));
  assert.deepEqual(plan.rows.map((r) => r.status), ["already_imported", "already_imported"]);
  assert.equal(plan.counts.created, 0);
});

test("8: a roll with no matching position needs a match and offers the ticker's open positions", () => {
  const other = pos({ id: "ceg300", strike: 300 });
  const plan = planImport(file([cegRoll]), snap({ positions: [other] }));
  const r = plan.rows[0];
  assert.equal(r.status, "new");
  assert.equal(r.roll?.from, null);
  assert.match(r.flags.needsMatch ?? "", /No open position/);
  assert.deepEqual(r.flags.matchCandidateIds, ["ceg300"]);
  assert.equal(plan.counts.needsMatch, 1);
});

test("8b: two positions with the closing leg's terms → never guess", () => {
  const plan = planImport(file([cegRoll]), snap({ positions: [pos({ id: "a" }), pos({ id: "b" })] }));
  assert.match(plan.rows[0].flags.needsMatch ?? "", /2 open positions/);
});

const ccOpen = {
  ...nvdaOpen,
  externalId: "rh:cc:1",
  robinhood: { orderId: "cc", legId: "1", optionId: "qxo-cc" },
  ticker: "QXO",
  strategy: "covered_call",
  strike: 18,
  deltaAtOpen: 0.25,
  robinhoodAvgCost: 15.5,
};

test("9: covered call with exactly one assignment lot links it and its basis", () => {
  const plan = planImport(
    file([ccOpen]),
    snap({
      lotBatches: new Map([["QXO", [{ strikePrice: 16, expirationDate: "2026-06-05", contractsRemaining: 3, weightedCostPerShare: 15.2 }]]]),
      sharesHeld: new Map([["QXO", 300]]),
    }),
  );
  const r = plan.rows[0];
  assert.deepEqual(r.lot, { strikePrice: 16, expirationDate: "2026-06-05", weightedCostPerShare: 15.2 });
  assert.equal(r.flags.lotChoices, undefined);
  assert.equal(r.flags.uncovered, undefined);
});

test("9b: two fitting lots are left to pick; no lot leaves the Robinhood hint", () => {
  const two = planImport(
    file([ccOpen]),
    snap({
      lotBatches: new Map([["QXO", [
        { strikePrice: 16, expirationDate: "2026-06-05", contractsRemaining: 1, weightedCostPerShare: 15.2 },
        { strikePrice: 17, expirationDate: "2026-07-02", contractsRemaining: 2, weightedCostPerShare: 16.1 },
      ]]]),
      sharesHeld: new Map([["QXO", 300]]),
    }),
  );
  assert.equal(two.rows[0].lot, null);
  assert.equal(two.rows[0].flags.lotChoices?.length, 2);

  const none = planImport(file([ccOpen]), snap({ sharesHeld: new Map([["QXO", 100]]) }));
  assert.equal(none.rows[0].lot, null);
  assert.equal(none.rows[0].flags.robinhoodAvgCost, 15.5);
});

test("9c: two calls in one file can't both claim a one-contract lot", () => {
  const second = { ...ccOpen, externalId: "rh:cc:2", openedAt: "2026-11-13T10:30:00-05:00", robinhood: { orderId: "cc2", legId: "2", optionId: "qxo-cc-2" } };
  const plan = planImport(
    file([ccOpen, second]),
    snap({
      lotBatches: new Map([["QXO", [{ strikePrice: 16, expirationDate: "2026-06-05", contractsRemaining: 1, weightedCostPerShare: 15.2 }]]]),
      sharesHeld: new Map([["QXO", 100]]),
    }),
  );
  assert.notEqual(plan.rows[0].lot, null);
  assert.equal(plan.rows[1].lot, null);
  assert.equal(plan.rows[1].flags.uncovered, true);
});

test("10: an externalId the app has seen — even on a deleted draft — is not recreated", () => {
  const plan = planImport(file([nvdaOpen]), snap({ knownExternalIds: new Set([nvdaOpen.externalId]) }));
  assert.equal(plan.rows[0].status, "already_imported");
});

test("possible duplicate: a manual position with the same terms opened the same ET day", () => {
  const manual = pos({
    id: "manual",
    ticker: "NVDA",
    optionType: "PUT",
    strike: 140,
    expiration: "2026-11-20",
    openedAtMs: Date.parse("2026-11-13T15:30:00-05:00"),
  });
  const plan = planImport(file([nvdaOpen]), snap({ positions: [manual] }));
  assert.equal(plan.rows[0].flags.possibleDuplicateOfId, "manual");
  assert.equal(plan.counts.possibleDuplicate, 1);
});

test("open and roll of it in one file: the roll points at the open from the file", () => {
  const open = { ...ccOpen, robinhood: { ...ccOpen.robinhood, optionId: "qxo-18" }, openedAt: "2026-11-10T10:00:00-05:00" };
  const r = roll("r1", "QXO", "covered_call", "2026-11-12T10:00:00-05:00", [18, "2026-11-20", 0.5], [19, "2026-11-27", 0.9], "qxo-18");
  // Listed roll-first to prove fill-time ordering.
  const plan = planImport(file([r, open]), snap({ sharesHeld: new Map([["QXO", 100]]) }));
  assert.deepEqual(plan.rows.map((x) => x.kind), ["open", "roll"]);
  assert.deepEqual(plan.rows[1].roll?.from, { kind: "file", externalId: open.externalId });
});

test("validation: bad values make a row Invalid; a bad shape rejects the file", () => {
  const bad = { ...nvdaOpen, externalId: "rh:bad", strike: 0, contracts: 1.5, openedAt: "2026-11-13T09:55:36", deltaAtOpen: 0.13 };
  const plan = planImport(file([bad]), snap());
  const r = plan.rows[0];
  assert.equal(r.status, "invalid");
  assert.ok(r.errors.some((e) => e.includes("strike")));
  assert.ok(r.errors.some((e) => e.includes("contracts")));
  assert.ok(r.errors.some((e) => e.includes("offset")));
  assert.ok(r.errors.some((e) => e.includes("negative for a put")));

  assert.throws(() => parseImportFile({ schemaVersion: 2, account: "Robinhood", events: [] }), ImportFileError);
  assert.throws(() => file([nvdaOpen, nvdaOpen]), /Duplicate externalId/);
  assert.throws(() => parseImportFile("{not json"), /Not valid JSON/);
});

// ── A roll spread over several positions ─────────────────────────────────────

const vcxPut = (id: string, contracts: number, openedAt: string, over: Partial<SnapshotPosition> = {}) =>
  pos({ id, ticker: "VCX", optionType: "PUT", strike: 20, expiration: "2026-11-20", contracts, openedAtMs: Date.parse(openedAt), ...over });

const vcxRoll = (contracts: number, id = "vcx1") => ({
  ...roll(id, "VCX", "cash_secured_put", "2026-11-20T10:05:00-05:00", [20, "2026-11-20", 0.05], [20, "2026-11-28", 0.62], "vcx-20p-1120"),
  contracts,
});

test("multi: a 5-contract roll maps onto four positions that add up to 5, oldest first", () => {
  const positions = [
    vcxPut("d", 1, "2026-11-19T09:41:27-05:00", { rhOptionId: "vcx-20p-1120" }),
    vcxPut("a", 1, "2026-11-04T09:30:00-05:00"),
    vcxPut("c", 2, "2026-11-09T14:13:00-05:00"),
    vcxPut("b", 1, "2026-11-05T09:30:00-05:00"),
  ];
  const r = planImport(file([vcxRoll(5)]), snap({ positions })).rows[0];
  assert.equal(r.flags.needsMatch, undefined);
  assert.equal(r.roll?.from, null);
  assert.deepEqual(r.roll?.allocations, [
    { positionId: "a", contracts: 1 },
    { positionId: "b", contracts: 1 },
    { positionId: "c", contracts: 2 },
    { positionId: "d", contracts: 1 },
  ]);
  assert.deepEqual(r.flags.rollAllocations, r.roll?.allocations);
});

test("multi: an option-id match that holds too few contracts is not taken", () => {
  // Only the 1-contract position carries the Robinhood id; the others make up the rest.
  const positions = [vcxPut("d", 1, "2026-11-19T09:41:27-05:00", { rhOptionId: "vcx-20p-1120" }), vcxPut("a", 1, "2026-11-04T09:30:00-05:00")];
  const r = planImport(file([vcxRoll(2)]), snap({ positions })).rows[0];
  assert.equal(r.roll?.allocations?.length, 2);

  const short = planImport(file([vcxRoll(3)]), snap({ positions })).rows[0];
  assert.equal(short.roll?.from, null);
  assert.equal(short.roll?.allocations, null);
  assert.match(short.flags.needsMatch ?? "", /hold 2 contracts; the roll is 3/);
});

test("multi: two rolls in one file don't claim the same contracts", () => {
  const positions = [
    vcxPut("a", 1, "2026-11-04T09:30:00-05:00"),
    vcxPut("b", 1, "2026-11-05T09:30:00-05:00"),
    vcxPut("c", 2, "2026-11-09T14:13:00-05:00"),
    vcxPut("d", 1, "2026-11-19T09:41:27-05:00"),
  ];
  const second = { ...vcxRoll(3, "vcx2"), rolledAt: "2026-11-20T10:06:00-05:00" };
  const [first, next] = planImport(file([vcxRoll(2), second]), snap({ positions })).rows;
  assert.deepEqual(first.roll?.from, { kind: "position", id: "c" });
  assert.deepEqual(next.roll?.allocations?.map((a) => a.positionId), ["a", "b", "d"]);
});

test("multi: one position big enough still wins as a single match", () => {
  const positions = [vcxPut("big", 5, "2026-11-04T09:30:00-05:00"), vcxPut("small", 1, "2026-11-05T09:30:00-05:00")];
  const r = planImport(file([vcxRoll(5)]), snap({ positions })).rows[0];
  assert.deepEqual(r.roll?.from, { kind: "position", id: "big" });
  assert.equal(r.roll?.allocations, null);
});

test("splitCents: proportional, whole cents, sums to the total", () => {
  assert.deepEqual(splitCents(0.21, [1, 1, 2, 1]), [0.04, 0.04, 0.09, 0.04]);
  assert.deepEqual(splitCents(0.1, [1, 1, 1]), [0.04, 0.03, 0.03]);
  assert.deepEqual(splitCents(0.05, [1]), [0.05]);
  assert.deepEqual(splitCents(null, [1, 2]), [null, null]);
  assert.deepEqual(splitCents(0, [1, 2]), [0, 0]);
  for (const [t, w] of [[1.37, [3, 1, 2]], [0.07, [2, 2, 1, 1, 1]], [12.34, [1, 4]]] as const) {
    const parts = splitCents(t, [...w]) as number[];
    assert.equal(Math.round(parts.reduce((s, x) => s + x, 0) * 100), Math.round(t * 100));
  }
});
