import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const accountRoutes = Router();

const accountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["CHECKING", "SAVINGS", "CREDIT_CARD", "INVESTMENT"]),
  balance: z.number().default(0),
  currency: z.string().default("USD"),
  color: z.string().optional(),
  isJoint: z.boolean().optional(),
});

// ── Account routes ──

// List all accounts
accountRoutes.get("/", async (_req, res) => {
  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(accounts);
});

// Get single account
accountRoutes.get("/:id", async (req, res) => {
  const account = await prisma.account.findUnique({
    where: { id: req.params.id },
  });
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json(account);
});

// Create account
accountRoutes.post("/", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await prisma.account.create({ data: parsed.data });
  res.status(201).json(account);
});

// Update account
accountRoutes.put("/:id", async (req, res) => {
  const parsed = accountSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await prisma.account.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(account);
});

// Delete (soft) account
accountRoutes.delete("/:id", async (req, res) => {
  await prisma.account.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  res.status(204).send();
});
