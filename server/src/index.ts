import express from "express";
import cors from "cors";
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

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

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
