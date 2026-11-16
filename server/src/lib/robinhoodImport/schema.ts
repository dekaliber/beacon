import { z } from "zod";

// Robinhood options export, schemaVersion 1 — the file Claude builds from the
// Robinhood connector (see the "Robinhood options import" build brief).
//
// The schema is deliberately loose on values (any number, any string) and
// strict on shape: a file whose structure is wrong is rejected whole, while a
// well-formed event whose values break a rule (strike ≤ 0, bad timestamp…) is
// kept and reported as Invalid by the planner.

const num = z.number();
const optNum = z.number().nullable().optional();
const strategy = z.enum(["covered_call", "cash_secured_put"]);

export const openEventSchema = z.object({
  kind: z.literal("open"),
  externalId: z.string().min(1),
  robinhood: z.object({
    orderId: z.string().min(1),
    legId: z.string().min(1),
    optionId: z.string().min(1),
  }),
  ticker: z.string().min(1),
  strategy,
  strike: num,
  expiration: z.string(),
  openedAt: z.string(),
  contracts: num,
  premiumPerShare: num,
  stockPriceAtOpen: optNum,
  stockPriceRange: z.tuple([num, num]).nullable().optional(),
  deltaAtOpen: optNum,
  ivAtOpen: optNum,
  costBasisPerShare: optNum,
  robinhoodAvgCost: optNum,
  fees: optNum,
  notes: z.string().nullable().optional(),
});

export const rollEventSchema = z.object({
  kind: z.literal("roll"),
  externalId: z.string().min(1),
  robinhood: z.object({ orderId: z.string().min(1) }),
  ticker: z.string().min(1),
  strategy,
  rolledAt: z.string(),
  contracts: num,
  netCreditPerShare: optNum,
  close: z.object({
    legId: z.string().min(1),
    optionId: z.string().min(1),
    strike: num,
    expiration: z.string(),
    buybackPerShare: num,
    fees: optNum,
  }),
  open: z.object({
    legId: z.string().min(1),
    optionId: z.string().min(1),
    strike: num,
    expiration: z.string(),
    premiumPerShare: num,
    stockPriceAtOpen: optNum,
    stockPriceRange: z.tuple([num, num]).nullable().optional(),
    deltaAtOpen: optNum,
    ivAtOpen: optNum,
    costBasisPerShare: optNum,
    fees: optNum,
  }),
  notes: z.string().nullable().optional(),
});

export const importFileSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().optional(),
  generatedAt: z.string().optional(),
  account: z.string().min(1),
  window: z.object({ since: z.string().optional(), until: z.string().optional() }).partial().optional(),
  derivation: z.record(z.unknown()).optional(),
  events: z.array(z.discriminatedUnion("kind", [openEventSchema, rollEventSchema])),
  skipped: z
    .array(
      z.object({
        robinhoodOrderId: z.string().optional(),
        reason: z.string(),
        summary: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});

export type OpenEvent = z.infer<typeof openEventSchema>;
export type RollEvent = z.infer<typeof rollEventSchema>;
export type ImportEvent = OpenEvent | RollEvent;
export type ImportFile = z.infer<typeof importFileSchema>;

export class ImportFileError extends Error {}

/** Parse a whole file. Throws ImportFileError with a readable reason when the shape is wrong. */
export function parseImportFile(raw: unknown): ImportFile {
  const data = typeof raw === "string" ? safeJson(raw) : raw;
  const parsed = importFileSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? issue.path.join(".") : "file";
    throw new ImportFileError(`${where}: ${issue.message}`);
  }
  const seen = new Set<string>();
  for (const e of parsed.data.events) {
    if (seen.has(e.externalId)) throw new ImportFileError(`Duplicate externalId in file: ${e.externalId}`);
    seen.add(e.externalId);
  }
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportFileError("Not valid JSON");
  }
}
