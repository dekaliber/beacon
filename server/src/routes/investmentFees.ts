import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";

// ── Investment fees ─────────────────────────────────────────────────────────────
// Advisory and account fees taken from an investment account's cash, stored as
// FEE InvestmentActivity rows. They're a cost against the investment return —
// not a budget expense and not a withdrawal — so Performance shows them as their
// own driver rather than leaving them in unreconciled cash.
//
// Like the other dated activity, a fee doesn't change Account.cashBalance: for a
// managed account that comes from the QFX position snapshot, and elsewhere it's
// set on the account page.

export const investmentFeeRoutes = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.number().positive().finite().refine((n) => n < 1e8, "out of range");
const feeBody = z.object({ date: day, amount, notes: z.string().trim().max(200).optional() });
const qfxBody = z.object({
  fees: z.array(z.object({ fitId: z.string().min(1), date: day, amount, memo: z.string().max(200).optional() })),
});

const dateColumn = (d: string) => new Date(`${d}T00:00:00.000Z`);
const DEFAULT_NOTE = "Advisory fee";

async function ownedAccount(userId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, userId, type: "INVESTMENT" }, select: { id: true } });
}

// ── POST /api/investments/fees/:accountId ───────────────────────────────────────
// A fee entered by hand.
investmentFeeRoutes.post("/:accountId", async (req, res) => {
  const parsed = feeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: "A date and a positive amount are required" } });
  try {
    if (!(await ownedAccount(getUserId(req), req.params.accountId))) {
      return res.status(404).json({ error: { message: "Account not found" } });
    }
    const { date, amount: fee, notes } = parsed.data;
    const activity = await prisma.investmentActivity.create({
      data: {
        accountId: req.params.accountId,
        ticker: "",
        type: "FEE",
        date: dateColumn(date),
        amount: fee,
        notes: notes || DEFAULT_NOTE,
      },
    });
    res.status(201).json({ id: activity.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to add fee" } });
  }
});

// ── POST /api/investments/fees/:accountId/qfx ───────────────────────────────────
// Fees from a QFX file's INVBANKTRAN FEE lines. The FITID is kept in notes
// ("QFX:{fitId} · {memo}") so an overlapping file never imports one twice.
investmentFeeRoutes.post("/:accountId/qfx", async (req, res) => {
  const parsed = qfxBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: "Invalid fee list" } });
  try {
    const { accountId } = req.params;
    if (!(await ownedAccount(getUserId(req), accountId))) {
      return res.status(404).json({ error: { message: "Account not found" } });
    }
    const existing = await prisma.investmentActivity.findMany({
      where: { accountId, type: "FEE", notes: { startsWith: "QFX:" } },
      select: { notes: true },
    });
    const seen = new Set(existing.map((e) => e.notes!.slice(4).split(" ")[0]));
    const fresh = parsed.data.fees.filter((f) => !seen.has(f.fitId));
    // A file can repeat a FITID only by mistake; keep the first
    const unique = [...new Map(fresh.map((f) => [f.fitId, f])).values()];
    if (unique.length) {
      await prisma.investmentActivity.createMany({
        data: unique.map((f) => ({
          accountId,
          ticker: "",
          type: "FEE" as const,
          date: dateColumn(f.date),
          amount: f.amount,
          notes: `QFX:${f.fitId} · ${f.memo?.trim() || DEFAULT_NOTE}`,
        })),
      });
    }
    res.json({ imported: unique.length, skipped: parsed.data.fees.length - unique.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to import fees" } });
  }
});

// ── DELETE /api/investments/fees/:activityId ────────────────────────────────────
investmentFeeRoutes.delete("/:activityId", async (req, res) => {
  try {
    const deleted = await prisma.investmentActivity.deleteMany({
      where: { id: req.params.activityId, type: "FEE", account: { userId: getUserId(req) } },
    });
    if (deleted.count === 0) return res.status(404).json({ error: { message: "Fee not found" } });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete fee" } });
  }
});
