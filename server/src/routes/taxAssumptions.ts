import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";

export const taxAssumptionsRoutes = Router();

type TaxAssumptionsWithPayments = Awaited<ReturnType<typeof getOrCreate>>;

async function getOrCreate(userId: string, year: number) {
  const existing = await prisma.taxAssumptions.findUnique({
    where: { userId_year: { userId, year } },
    include: { quarterlyPayments: { orderBy: { quarter: "asc" } } },
  });
  if (existing) return existing;
  return prisma.taxAssumptions.create({
    data: { userId, year },
    include: { quarterlyPayments: true },
  });
}

function serialize(row: TaxAssumptionsWithPayments) {
  return {
    filingStatus: row.filingStatus,
    otherOrdinary:   row.otherOrdinary   != null ? Number(row.otherOrdinary)   : null,
    federalWithheld: row.federalWithheld != null ? Number(row.federalWithheld) : null,
    otherLtcg:       row.otherLtcg       != null ? Number(row.otherLtcg)       : null,
    caWithheld:      row.caWithheld      != null ? Number(row.caWithheld)      : null,
    useTmt:   row.useTmt,
    useCaTmt: row.useCaTmt,
    quarterlyPayments: Array.from({ length: 4 }, (_, i) => {
      const p = row.quarterlyPayments.find((q) => q.quarter === i + 1);
      return {
        quarter:       i + 1,
        federalAmount: p?.federalAmount != null ? Number(p.federalAmount) : null,
        caAmount:      p?.caAmount      != null ? Number(p.caAmount)      : null,
      };
    }),
  };
}

// GET /api/tax-assumptions/:year
taxAssumptionsRoutes.get("/:year", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });
  const row = await getOrCreate(userId, year);
  res.json(serialize(row));
});

// PUT /api/tax-assumptions/:year  — upsert main fields
taxAssumptionsRoutes.put("/:year", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  const schema = z.object({
    filingStatus:    z.enum(["SINGLE", "MFJ", "HoH", "MFS"]).optional(),
    otherOrdinary:   z.number().nullable().optional(),
    federalWithheld: z.number().nonnegative().nullable().optional(),
    otherLtcg:       z.number().nullable().optional(),
    caWithheld:      z.number().nonnegative().nullable().optional(),
    useTmt:   z.boolean().optional(),
    useCaTmt: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const row = await prisma.taxAssumptions.upsert({
    where:  { userId_year: { userId, year } },
    update: parsed.data,
    create: { userId, year, ...parsed.data },
    include: { quarterlyPayments: { orderBy: { quarter: "asc" } } },
  });

  res.json(serialize(row));
});

// PUT /api/tax-assumptions/:year/quarterly  — upsert all 4 quarters (federal + CA)
taxAssumptionsRoutes.put("/:year/quarterly", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  const amt = z.number().nonnegative().nullable();
  const schema = z.object({
    federal: z.tuple([amt, amt, amt, amt]),
    ca:      z.tuple([amt, amt, amt, amt]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const parent = await getOrCreate(userId, year);

  await Promise.all(
    [0, 1, 2, 3].map((i) =>
      prisma.taxQuarterlyPayment.upsert({
        where:  { taxAssumptionsId_quarter: { taxAssumptionsId: parent.id, quarter: i + 1 } },
        update: { federalAmount: parsed.data.federal[i], caAmount: parsed.data.ca[i] },
        create: {
          taxAssumptionsId: parent.id,
          quarter:          i + 1,
          federalAmount:    parsed.data.federal[i],
          caAmount:         parsed.data.ca[i],
        },
      })
    )
  );

  const updated = await prisma.taxAssumptions.findUniqueOrThrow({
    where:   { id: parent.id },
    include: { quarterlyPayments: { orderBy: { quarter: "asc" } } },
  });

  res.json(serialize(updated));
});
