import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";

export const instrumentRoutes = Router();

// Shared include for full instrument detail
const instrumentInclude = {
  tickers: { orderBy: { ticker: "asc" as const } },
  weights: {
    include: { assetClass: { select: { id: true, name: true, slug: true, color: true, parentId: true } } },
    orderBy: { weight: "desc" as const },
  },
  holdings: {
    select: {
      id: true,
      ticker: true,
      accountId: true,
      account: { select: { id: true, name: true, color: true } },
    },
  },
};

// ── Backfill helper ────────────────────────────────────────────────────────
// Creates Instrument records for any holdings that pre-date this feature.
// Safe to call repeatedly — upserts on primaryTicker and skips linked holdings.

async function backfillUnlinkedHoldings() {
  const unlinked = await prisma.investmentHolding.findMany({
    where: { instrumentId: null },
    select: { id: true, ticker: true, name: true },
  });
  if (unlinked.length === 0) return;

  // Group by ticker so we upsert once per unique ticker
  const byTicker = new Map<string, { ids: string[]; name: string }>();
  for (const h of unlinked) {
    const existing = byTicker.get(h.ticker);
    if (existing) {
      existing.ids.push(h.id);
    } else {
      byTicker.set(h.ticker, { ids: [h.id], name: h.name });
    }
  }

  for (const [ticker, { ids, name }] of byTicker) {
    // Check if an alias ticker already points to an existing instrument
    const alias = await prisma.instrumentTicker.findUnique({
      where: { ticker },
      select: { instrumentId: true },
    });
    const instrumentId = alias
      ? alias.instrumentId
      : (
          await prisma.instrument.upsert({
            where: { primaryTicker: ticker },
            update: {},
            create: { primaryTicker: ticker, name },
            select: { id: true },
          })
        ).id;

    await prisma.investmentHolding.updateMany({
      where: { id: { in: ids } },
      data: { instrumentId },
    });
  }
}

// ── GET /api/instruments ───────────────────────────────────────────────────
// Returns all instruments. Lazily backfills any holdings that pre-date this
// feature so the list is always complete without a separate migration step.

instrumentRoutes.get("/", async (_req, res) => {
  try {
    await backfillUnlinkedHoldings();
    const instruments = await prisma.instrument.findMany({
      include: instrumentInclude,
      orderBy: { primaryTicker: "asc" },
    });
    res.json(instruments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch instruments" } });
  }
});

// ── GET /api/instruments/:id ───────────────────────────────────────────────

instrumentRoutes.get("/:id", async (req, res) => {
  try {
    const instrument = await prisma.instrument.findUnique({
      where: { id: req.params.id },
      include: instrumentInclude,
    });
    if (!instrument) return res.status(404).json({ error: { message: "Instrument not found" } });
    res.json(instrument);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch instrument" } });
  }
});

// ── POST /api/instruments ──────────────────────────────────────────────────
// Manually create an instrument (rare; usually auto-created on holding add).

const createSchema = z.object({
  primaryTicker: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
  name: z.string().max(200).nullable().optional(),
});

instrumentRoutes.post("/", async (req, res) => {
  try {
    const body = createSchema.parse(req.body);
    const instrument = await prisma.instrument.create({
      data: body,
      include: instrumentInclude,
    });
    res.status(201).json(instrument);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2002") return res.status(409).json({ error: { message: "An instrument with this ticker already exists" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create instrument" } });
  }
});

// ── PATCH /api/instruments/:id ─────────────────────────────────────────────
// Update instrument name.

const patchSchema = z.object({
  name: z.string().max(200).nullable().optional(),
});

instrumentRoutes.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = patchSchema.parse(req.body);
    const instrument = await prisma.$transaction(async (tx) => {
      if (body.name !== undefined) {
        await tx.investmentHolding.updateMany({
          where: { instrumentId: id },
          data: { name: body.name },
        });
      }
      return tx.instrument.update({ where: { id }, data: body, include: instrumentInclude });
    });
    res.json(instrument);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update instrument" } });
  }
});

// ── PUT /api/instruments/:id/weights ──────────────────────────────────────
// Replace all asset class weights for an instrument.
// Accepts an array of { assetClassId, weight } — weights should sum to ≤ 100.

const weightsSchema = z.object({
  weights: z.array(
    z.object({
      assetClassId: z.string(),
      weight: z.number().min(0).max(100),
    })
  ),
});

instrumentRoutes.put("/:id/weights", async (req, res) => {
  try {
    const { id } = req.params;
    const { weights } = weightsSchema.parse(req.body);

    const instrument = await prisma.instrument.findUnique({ where: { id } });
    if (!instrument) return res.status(404).json({ error: { message: "Instrument not found" } });

    // Validate total ≤ 100
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    if (total > 100.01) {
      return res.status(400).json({ error: { message: `Weights sum to ${total.toFixed(1)}% — must be ≤ 100%` } });
    }

    // Replace all weights in a transaction
    await prisma.$transaction([
      prisma.instrumentAssetClassWeight.deleteMany({ where: { instrumentId: id } }),
      ...weights
        .filter((w) => w.weight > 0)
        .map((w) =>
          prisma.instrumentAssetClassWeight.create({
            data: { instrumentId: id, assetClassId: w.assetClassId, weight: w.weight },
          })
        ),
    ]);

    const updated = await prisma.instrument.findUnique({
      where: { id },
      include: instrumentInclude,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update weights" } });
  }
});

// ── POST /api/instruments/:id/tickers ─────────────────────────────────────
// Add an equivalent ticker alias to an instrument.

const addTickerSchema = z.object({
  ticker: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
});

instrumentRoutes.post("/:id/tickers", async (req, res) => {
  try {
    const { id } = req.params;
    const { ticker } = addTickerSchema.parse(req.body);

    const instrument = await prisma.instrument.findUnique({ where: { id } });
    if (!instrument) return res.status(404).json({ error: { message: "Instrument not found" } });

    // Can't alias a ticker that is itself a primary ticker
    if (ticker === instrument.primaryTicker) {
      return res.status(400).json({ error: { message: "Cannot add an instrument's own primary ticker as an alias" } });
    }
    const clash = await prisma.instrument.findUnique({ where: { primaryTicker: ticker } });
    if (clash) {
      return res.status(409).json({ error: { message: `${ticker} is already the primary ticker of another instrument. Merge the instruments instead.` } });
    }

    await prisma.instrumentTicker.create({ data: { instrumentId: id, ticker } });

    // Re-link any holdings using this ticker to point to this instrument
    await prisma.investmentHolding.updateMany({
      where: { ticker, instrumentId: null },
      data: { instrumentId: id },
    });

    const updated = await prisma.instrument.findUnique({ where: { id }, include: instrumentInclude });
    res.status(201).json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2002") return res.status(409).json({ error: { message: "This ticker is already an alias for another instrument" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to add ticker alias" } });
  }
});

// ── DELETE /api/instruments/:id/tickers/:ticker ────────────────────────────
// Remove an equivalent ticker alias.

instrumentRoutes.delete("/:id/tickers/:ticker", async (req, res) => {
  try {
    const { id, ticker } = req.params;
    await prisma.instrumentTicker.deleteMany({
      where: { instrumentId: id, ticker: ticker.toUpperCase() },
    });
    const updated = await prisma.instrument.findUnique({ where: { id }, include: instrumentInclude });
    if (!updated) return res.status(404).json({ error: { message: "Instrument not found" } });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to remove ticker alias" } });
  }
});

// ── POST /api/instruments/:id/merge ────────────────────────────────────────
// Merge another instrument into this one. The other instrument's primaryTicker
// becomes an alias, its holdings are re-linked here, and it is deleted.

const mergeSchema = z.object({ otherId: z.string().min(1) });

instrumentRoutes.post("/:id/merge", async (req, res) => {
  try {
    const { id } = req.params;
    const { otherId } = mergeSchema.parse(req.body);

    if (id === otherId) {
      return res.status(400).json({ error: { message: "Cannot merge an instrument with itself" } });
    }

    const [target, other] = await Promise.all([
      prisma.instrument.findUnique({ where: { id } }),
      prisma.instrument.findUnique({ where: { id: otherId }, include: { tickers: true } }),
    ]);
    if (!target) return res.status(404).json({ error: { message: "Target instrument not found" } });
    if (!other)  return res.status(404).json({ error: { message: "Source instrument not found" } });

    await prisma.$transaction(async (tx) => {
      // 1. Re-link all of the other instrument's holdings to the target
      await tx.investmentHolding.updateMany({
        where: { instrumentId: otherId },
        data: { instrumentId: id },
      });

      // 2. Move the other instrument's existing alias tickers to the target
      //    (skip any that already exist on target to avoid unique constraint violations)
      const existingAliases = await tx.instrumentTicker.findMany({
        where: { instrumentId: id },
        select: { ticker: true },
      });
      const existingSet = new Set(existingAliases.map((a) => a.ticker));
      existingSet.add(target.primaryTicker); // don't re-add the target's own ticker

      for (const t of other.tickers) {
        if (!existingSet.has(t.ticker)) {
          await tx.instrumentTicker.update({
            where: { id: t.id },
            data: { instrumentId: id },
          });
        } else {
          await tx.instrumentTicker.delete({ where: { id: t.id } });
        }
      }

      // 3. Add the other instrument's primaryTicker as an alias on the target
      if (!existingSet.has(other.primaryTicker)) {
        await tx.instrumentTicker.create({
          data: { instrumentId: id, ticker: other.primaryTicker },
        });
      }

      // 4. Delete the other instrument (holdings already re-linked above)
      await tx.instrument.delete({ where: { id: otherId } });
    });

    const updated = await prisma.instrument.findUnique({ where: { id }, include: instrumentInclude });
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to merge instruments" } });
  }
});

// ── DELETE /api/instruments/:id ────────────────────────────────────────────
// Delete an instrument. Holdings are unlinked (instrumentId set to null).

instrumentRoutes.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.instrument.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    const e = err as any;
    if (e?.code === "P2025") return res.status(404).json({ error: { message: "Instrument not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete instrument" } });
  }
});
