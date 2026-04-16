import express from "express";
import cors from "cors";
import { resolve } from "path";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { prisma } from "./db/client.js";
import { accountRoutes } from "./routes/accounts.js";
import { categoryRoutes } from "./routes/categories.js";
import { expenseRoutes } from "./routes/expenses.js";
import { budgetRoutes } from "./routes/budgets.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { recurrenceRoutes } from "./routes/recurrence.js";
import { incomeRoutes } from "./routes/income.js";
import { tagRoutes } from "./routes/tags.js";
import { transactionGroupRoutes } from "./routes/transactionGroups.js";
import { investmentRoutes } from "./routes/investments.js";
import { pendingDividendRoutes } from "./routes/pendingDividends.js";
import { notificationRoutes } from "./routes/notifications.js";
import { assetClassRoutes } from "./routes/assetClasses.js";
import { instrumentRoutes } from "./routes/instruments.js";
import { transferRoutes } from "./routes/transfers.js";
import { statementOverrideRoutes } from "./routes/statementOverrides.js";
import { cashFlowRoutes } from "./routes/cashFlow.js";
import { withdrawalRoutes } from "./routes/withdrawals.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(clerkMiddleware());

// All /api routes require authentication (except /api/health)
app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  return next();
});

// Routes
app.use("/api/accounts", accountRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/recurrence-rules", recurrenceRoutes);
app.use("/api/income", incomeRoutes);
app.use("/api/tags", tagRoutes);
app.use("/api/transaction-groups", transactionGroupRoutes);
app.use("/api/investments", investmentRoutes);
app.use("/api/pending-dividends", pendingDividendRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/asset-classes", assetClassRoutes);
app.use("/api/instruments", instrumentRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/statement-overrides", statementOverrideRoutes);
app.use("/api/cash-flow", cashFlowRoutes);
app.use("/api/withdrawals", withdrawalRoutes);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Serve static frontend in production
if (process.env.NODE_ENV === "production") {
  const publicPath = resolve("public");
  app.use(express.static(publicPath));
  app.get("*", (_req, res) => {
    res.sendFile(resolve("public", "index.html"));
  });
}

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const shutdown = async () => {
  server.closeAllConnections();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
