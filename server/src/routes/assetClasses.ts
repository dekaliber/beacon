import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";

export const assetClassRoutes = Router();

// ── GET /api/asset-classes ─────────────────────────────────────────────────
// Returns full two-level hierarchy with targets.

assetClassRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);
  try {
    const classes = await prisma.assetClass.findMany({
      where: { parentId: null, OR: [{ userId: null }, { userId }] },
      orderBy: { displayOrder: "asc" },
      include: {
        targets: { where: { userId } },
        children: {
          orderBy: { displayOrder: "asc" },
          include: { targets: { where: { userId } } },
        },
      },
    });
    // Reshape: expose user's target as `target` field
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaped = classes.map((c: any) => ({
      ...c,
      target: c.targets[0] ?? null,
      targets: undefined,
      children: c.children.map((ch: any) => ({ ...ch, target: ch.targets[0] ?? null, targets: undefined })),
    }));
    res.json(shaped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch asset classes" } });
  }
});

// ── GET /api/asset-classes/flat ────────────────────────────────────────────
// Flat list used for dropdowns (weights editor, etc.).

assetClassRoutes.get("/flat", async (req, res) => {
  const userId = getUserId(req);
  try {
    const classes = await prisma.assetClass.findMany({
      where: { OR: [{ userId: null }, { userId }] },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      include: { targets: { where: { userId } }, parent: { select: { id: true, name: true } } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaped = classes.map((c: any) => ({ ...c, target: c.targets[0] ?? null, targets: undefined }));
    res.json(shaped);
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
  const userId = getUserId(req);
  try {
    const body = createSchema.parse(req.body);

    // Validate parent exists if provided
    if (body.parentId) {
      const parent = await prisma.assetClass.findFirst({ where: { id: body.parentId, OR: [{ userId: null }, { userId }] } });
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
        userId,
        name: body.name,
        parentId: body.parentId ?? null,
        color: body.color ?? null,
        isSystem: false,
        displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
      },
      include: { targets: { where: { userId } }, children: { include: { targets: { where: { userId } } } } },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaped: any = { ...assetClass, target: assetClass.targets[0] ?? null, targets: undefined };
    res.status(201).json(shaped);
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
  const userId = getUserId(req);
  try {
    const { id } = req.params;
    const body = updateSchema.parse(req.body);

    const existing = await prisma.assetClass.findFirst({ where: { id, OR: [{ userId: null }, { userId }] } });
    if (!existing) return res.status(404).json({ error: { message: "Asset class not found" } });

    // System classes can only have their color changed; user-created classes require ownership
    const data: { color?: string | null; name?: string } = {};
    if (body.color !== undefined) data.color = body.color;
    if (body.name !== undefined) {
      if (existing.isSystem) return res.status(400).json({ error: { message: "Cannot rename a system asset class" } });
      if (existing.userId !== userId) return res.status(403).json({ error: { message: "Forbidden" } });
      data.name = body.name;
    }

    const updated = await prisma.assetClass.update({
      where: { id },
      data,
      include: { targets: { where: { userId } }, children: { include: { targets: { where: { userId } } } } },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaped: any = { ...updated, target: updated.targets[0] ?? null, targets: undefined };
    res.json(shaped);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update asset class" } });
  }
});

// ── DELETE /api/asset-classes/:id ─────────────────────────────────────────
// Only custom (non-system) classes can be deleted.

assetClassRoutes.delete("/:id", async (req, res) => {
  const userId = getUserId(req);
  try {
    const { id } = req.params;

    const existing = await prisma.assetClass.findFirst({
      where: { id, OR: [{ userId: null }, { userId }] },
      include: { children: { select: { id: true } } },
    });
    if (!existing) return res.status(404).json({ error: { message: "Asset class not found" } });
    if (existing.isSystem) return res.status(400).json({ error: { message: "Cannot delete a system asset class" } });
    if (existing.userId !== userId) return res.status(403).json({ error: { message: "Forbidden" } });
    if (existing.children.length > 0) {
      await prisma.assetClass.deleteMany({ where: { parentId: id, userId } });
    }

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
  const userId = getUserId(req);
  try {
    const { id } = req.params;
    const { targetPct } = targetSchema.parse(req.body);

    const existing = await prisma.assetClass.findFirst({ where: { id, OR: [{ userId: null }, { userId }] } });
    if (!existing) return res.status(404).json({ error: { message: "Asset class not found" } });

    const target = await prisma.assetClassTarget.upsert({
      where: { userId_assetClassId: { userId, assetClassId: id } },
      update: { targetPct },
      create: { userId, assetClassId: id, targetPct },
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
  const userId = getUserId(req);
  try {
    const { id } = req.params;
    await prisma.assetClassTarget.deleteMany({ where: { assetClassId: id, userId } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete target" } });
  }
});
