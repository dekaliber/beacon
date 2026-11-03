import { Router, type Request } from "express";
import { prisma } from "../db/client.js";
import { takeNetWorthSnapshot } from "../jobs/netWorthSnapshot.js";
import { runDailyUpdate } from "../jobs/dailyUpdate.js";

const jobRoutes = Router();

function hasCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers["x-cron-secret"] === secret;
}

jobRoutes.post("/net-worth-snapshot", async (req, res) => {
  if (!hasCronSecret(req)) {
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

// Runs the daily update now, outside its schedule. It takes minutes, so this
// answers immediately and the run continues in the background; check its
// outcome with the GET below.
jobRoutes.post("/daily-update", (req, res) => {
  if (!hasCronSecret(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  runDailyUpdate("manual").catch((err) => console.error("[daily-update] manual run failed:", err));
  res.status(202).json({ ok: true });
});

jobRoutes.get("/daily-update", async (req, res) => {
  if (!hasCronSecret(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const runs = await prisma.jobRun.findMany({
    where: { job: "daily-update" },
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  res.json(runs);
});

export { jobRoutes };
