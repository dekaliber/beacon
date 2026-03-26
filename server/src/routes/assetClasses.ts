import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";

export const assetClassRoutes = Router();

// ── GET /api/asset-classes ─────────────────────────────────────────────────
// Returns full two-level hierarchy with targets.

assetClassRoutes.get("/", async (_req, res) => {
  try {
    const classes = await prisma.assetClass.findMany({
      where: { parentId: null },
      orderBy: { displayOrder: "asc" },
      include: {
        target: true,
        children: {
          orderBy: { displayOrder: "asc" },
          include: { target: true },
        },
      },
    });
    res.json(classes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch asset classes" } });
  }
});

// ── GET /api/asset-classes/flat ────────────────────────────────────────────
// Flat list used for dropdowns (weights editor, etc.).

assetClassRoutes.get("/flat", async (_req, res) => {
  try {
    const classes = await prisma.assetClass.findMany({
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      include: { target: true, parent: { select: { id: true, name: true } } },
    });
    res.json(classes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch asset classes" } });
  }
});

// ── POST /api/asset-classes ────────────────────────────────────────────────
// Create a custom (non-system) asset class.

const createSchema = z.object({
  name: z.string().min(1).max(100),
  parentId: z.string().nullable().optional(),
  color: z.string().max(20).nullable().optional(),
});

assetClassRoutes.post("/", async (req, res) => {
  try {
    const body = createSchema.parse(req.body);

    // Validate parent exists if provided
    if (body.parentId) {
      const parent = await prisma.assetClass.findUnique({ where: { id: body.parentId } });
      if (!parent) return res.status(404).json({ error: { message: "Parent asset class not found" } });
      if (parent.parentId) return res.status(400).json({ error: { message: "Cannot nest asset classes more than two levels deep" } });
    }

    // Place new custom class at end of its sibling group
    const maxOrder = await prisma.assetClass.aggregate({
      where: { parentId: body.parentId ?? null },
      _max: { displayOrder: true },
    });

    const assetClass = await prisma.assetClass.create({
      data: {
        name: body.name,
        parentId: body.parentId ?? null,
        color: body.color ?? null,
        isSystem: false,
        displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
      },
      include: { target: true, children: { include: { target: true } } },
    });

    res.status(201).json(assetClass);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create asset class" } });
  }
});

// ── PUT /api/asset-classes/:id ─────────────────────────────────────────────
// Update name (custom only) and/or color (any class).

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(20).nullable().optional(),
});

assetClassRoutes.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = updateSchema.parse(req.body);

    const existing = await prisma.assetClass.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: { message: "Asset class not found" } });

    // System classes can only have their color changed
    const data: { color?: string | null; name?: string } = {};
    if (body.color !== undefined) data.color = body.color;
    if (body.name !== undefined) {
      if (existing.isSystem) return res.status(400).json({ error: { message: "Cannot rename a system asset class" } });
      data.name = body.name;
    }

    const updated = await prisma.assetClass.update({
      where: { id },
      data,
      include: { target: true, children: { include: { target: true } } },
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update asset class" } });
  }
});

// ── DELETE /api/asset-classes/:id ─────────────────────────────────────────
// Only custom (non-system) classes can be deleted.

assetClassRoutes.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.assetClass.findUnique({
      where: { id },
      include: { children: { select: { id: true } } },
    });
    if (!existing) return res.status(404).json({ error: { message: "Asset class not found" } });
    if (existing.isSystem) return res.status(400).json({ error: { message: "Cannot delete a system asset class" } });
    if (existing.children.length > 0) return res.status(400).json({ error: { message: "Cannot delete an asset class that has sub-classes" } });

    await prisma.assetClass.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete asset class" } });
  }
});

// ── PUT /api/asset-classes/:id/target ─────────────────────────────────────
// Upsert the target allocation % for a given asset class.

const targetSchema = z.object({
  targetPct: z.number().min(0).max(100),
});

assetClassRoutes.put("/:id/target", async (req, res) => {
  try {
    const { id } = req.params;
    const { targetPct } = targetSchema.parse(req.body);

    const existing = await prisma.assetClass.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: { message: "Asset class not found" } });

    const target = await prisma.assetClassTarget.upsert({
      where: { assetClassId: id },
      update: { targetPct },
      create: { assetClassId: id, targetPct },
    });

    res.json(target);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to set target" } });
  }
});

// ── DELETE /api/asset-classes/:id/target ──────────────────────────────────
// Remove a target allocation (set back to unset).

assetClassRoutes.delete("/:id/target", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.assetClassTarget.deleteMany({ where: { assetClassId: id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete target" } });
  }
});
