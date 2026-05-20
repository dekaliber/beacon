import { Router } from "express";
import { takeNetWorthSnapshot } from "../jobs/netWorthSnapshot.js";

const jobRoutes = Router();

jobRoutes.post("/net-worth-snapshot", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["x-cron-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await takeNetWorthSnapshot();
    res.json({ ok: true });
  } catch (err) {
    console.error("net-worth-snapshot job failed:", err);
    res.status(500).json({ error: "Snapshot failed" });
  }
});

export { jobRoutes };
