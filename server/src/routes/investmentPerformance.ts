import { Router } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { computePerformance } from "../services/performance.js";
import { benchmarkClosesAt } from "../services/benchmark.js";
import { cpiAt } from "../services/cpi.js";

export const investmentPerformanceRoutes = Router();

const querySchema = z.object({
  cadence: z.enum(["weekly", "monthly"]).default("weekly"),
  // Client's local date; bounds which dated records (transfers) have happened.
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ── GET /api/investments/performance?cadence=weekly|monthly&today=YYYY-MM-DD ──
// Portfolio value at each week/month-end close since the start of 2026, with each
// period's change broken down by asset class, flows, and unreconciled cash.
investmentPerformanceRoutes.get("/", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { message: "cadence must be weekly|monthly and today YYYY-MM-DD" } });
  }
  try {
    const result = await computePerformance(getUserId(req), parsed.data.cadence, parsed.data.today);
    // The S&P 500 TR close at the baseline and each period end, for the comparison
    // line. A failed fetch leaves it null rather than failing the whole chart.
    const days = [result.baseline, ...result.periods.map((p) => p.end)];
    // CPI is monthly, so the inflation line is only drawn on the monthly view.
    const [benchmark, inflation] = await Promise.all([
      benchmarkClosesAt(days).catch((err) => {
        console.warn("[performance] benchmark fetch failed —", err);
        return null;
      }),
      result.cadence === "monthly"
        ? cpiAt(days).catch((err) => {
            console.warn("[performance] CPI fetch failed —", err);
            return null;
          })
        : Promise.resolve(null),
    ]);
    res.json({ ...result, benchmark, inflation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to compute performance" } });
  }
});
