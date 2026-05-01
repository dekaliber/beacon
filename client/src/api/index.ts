import { api } from "./client";
import type {
  Account,
  AllocationSummary,
  StatementOverride,
  Transfer,
  TransferRule,
  AssetClass,
  BudgetOverview,
  CategoryOutliersData,
  CategoryTrendData,
  Category,
  DashboardData,
  Expense,
  GrowthPoint,
  Income,
  Instrument,
  InvestmentAccountSummary,
  InvestmentActivity,
  InvestmentHolding,
  InvestmentLot,
  ManualInvestment,
  RealizedGainSnapshot,
  RealizedGainSnapshotWithAccount,
  TickerSearchResult,
  PaginatedResponse,
  PendingDividend,
  TaxClassification,
  RecurrenceRule,
  RecurringHistoryMonth,
  Tag,
  TransactionGroup,
  UpcomingExpenseItem,
  CashFlowResponse,
  WithdrawalEvent,
  WithdrawalSummary,
  InvestmentSettings,
  TaxAssumptions,
  MonthlySpendingResponse,
  QfxTransactionInput,
  QfxDividendInput,
  OrphanedOffset,
} from "../types";

// Accounts
export const getAccounts = (params?: { includeHidden?: boolean }) => {
  const query = params?.includeHidden ? "?includeHidden=true" : "";
  return api.get<Account[]>(`/accounts${query}`);
};
export const createAccount = (data: Partial<Account>) => api.post<Account>("/accounts", data);
export const updateAccount = (id: string, data: Partial<Account>) => api.put<Account>(`/accounts/${id}`, data);
export const deleteAccount = (id: string) => api.delete(`/accounts/${id}`);

// Categories
const kindParam = (kind?: string) => (kind ? `?kind=${kind}` : "");
export const getCategories = (kind?: string) => api.get<Category[]>(`/categories${kindParam(kind)}`);
export const getFlatCategories = (kind?: string) => api.get<Category[]>(`/categories/flat${kindParam(kind)}`);
export const createCategory = (data: Partial<Category>) => api.post<Category>("/categories", data);
export const updateCategory = (id: string, data: Partial<Category>) => api.put<Category>(`/categories/${id}`, data);
export const deleteCategory = (id: string, reassignTo?: string) => {
  const query = reassignTo ? `?reassignTo=${reassignTo}` : "";
  return api.delete(`/categories/${id}${query}`);
};
export const getCategoryUsage = (id: string) =>
  api.get<{ count: number; categoryIds: string[] }>(`/categories/${id}/usage`);

// Expenses
export const getExpenses = (params?: Record<string, string>) => {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.get<PaginatedResponse<Expense>>(`/expenses${query}`);
};
export const createExpense = (data: Record<string, unknown>) => api.post<Expense>("/expenses", data);
export const updateExpense = (id: string, data: Record<string, unknown>, updateFuture?: boolean) =>
  api.put<Expense>(`/expenses/${id}${updateFuture ? "?updateFuture=true" : ""}`, data);
export const deleteExpense = (id: string, deleteFuture?: boolean) =>
  api.delete(`/expenses/${id}${deleteFuture ? "?deleteFuture=true" : ""}`);
export const getExpenseVendors = () => api.get<string[]>("/expenses/vendors");
export const getVendorCategory = (vendor: string) =>
  api.get<{ categoryId: string | null }>(`/expenses/vendor-category?vendor=${encodeURIComponent(vendor)}`);
export const getUncategorizedCount = () => api.get<{ count: number }>("/expenses/uncategorized-count");
export const importExpenses = (expenses: Record<string, unknown>[]) =>
  api.post<{ imported: number; errors: Array<{ row: number; message: string }> }>("/expenses/import", { expenses });
export const bulkUpdateExpenses = (ids: string[], patch: Record<string, unknown>) =>
  api.patch<{ updated: number }>("/expenses/bulk", { ids, ...patch });
export const bulkDeleteExpenses = (ids: string[]) =>
  api.delete<{ deleted: number }>("/expenses/bulk", { ids });
export const updateExpenseParent = (id: string, parentExpenseId: string | null) =>
  api.put<Expense>(`/expenses/${id}`, { parentExpenseId });

// Income
export const getIncome = (params?: Record<string, string>) => {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.get<PaginatedResponse<Income>>(`/income${query}`);
};
export const createIncome = (data: Record<string, unknown>) => api.post<Income>("/income", data);
export const updateIncome = (id: string, data: Record<string, unknown>) => api.put<Income>(`/income/${id}`, data);
export const deleteIncome = (id: string) => api.delete(`/income/${id}`);
export const importIncome = (incomes: Record<string, unknown>[]) =>
  api.post<{ imported: number; errors: Array<{ row: number; message: string }> }>("/income/import", { incomes });
export const bulkUpdateIncome = (ids: string[], patch: Record<string, unknown>) =>
  api.patch<{ updated: number }>("/income/bulk", { ids, ...patch });
export const bulkDeleteIncome = (ids: string[]) =>
  api.delete<{ deleted: number }>("/income/bulk", { ids });

// Tags
export const getTags = () => api.get<Tag[]>("/tags");
export const getTagOrphanedOffsets = (tagId: string) =>
  api.get<OrphanedOffset[]>(`/tags/${tagId}/orphaned-offsets`);
export const createTag = (data: { name: string; color?: string; group?: string | null }) => api.post<Tag>("/tags", data);
export const updateTag = (id: string, data: { name?: string; color?: string; group?: string | null }) => api.put<Tag>(`/tags/${id}`, data);
export const deleteTag = (id: string) => api.delete(`/tags/${id}`);

// Transaction Groups
export const getTransactionGroups = () => api.get<TransactionGroup[]>("/transaction-groups");
export const createTransactionGroup = (data: { expenseIds: string[] }) =>
  api.post<TransactionGroup>("/transaction-groups", data);
export const updateTransactionGroup = (
  id: string,
  data: { primaryExpenseId?: string; addExpenseIds?: string[]; removeExpenseIds?: string[] },
) => api.patch<TransactionGroup | null>(`/transaction-groups/${id}`, data);
export const deleteTransactionGroup = (id: string) => api.delete(`/transaction-groups/${id}`);

// Budgets
export const getBudgetOverview = (year: number) =>
  api.get<BudgetOverview>(`/budgets/${year}?today=${new Date().toLocaleDateString("en-CA")}`);

export const setAnnualBudget = (
  year: number,
  type: "personal" | "joint",
  annualAmount: number,
) => api.put(`/budgets/${year}/${type}`, { annualAmount });

export const setMonthlyBudgetOverride = (
  year: number,
  type: "personal" | "joint",
  month: number,
  amount: number,
) => api.put(`/budgets/${year}/${type}/monthly/${month}`, { amount });

export const deleteMonthlyBudgetOverride = (
  year: number,
  type: "personal" | "joint",
  month: number,
) => api.delete(`/budgets/${year}/${type}/monthly/${month}`);

export const getMonthlySpending = (year: number) =>
  api.get<MonthlySpendingResponse>(`/budgets/${year}/monthly-spending?today=${new Date().toLocaleDateString("en-CA")}`);

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Reference date for the category-outliers endpoint given a specific month:
 * - current month  → today (partial window matches live data)
 * - past month     → last day of that month (full window)
 * - future month   → first day (endpoint treats it as a future year boundary)
 */
function outliersRefDate(year: number, month: number): string {
  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const isFuture  = year >  now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  if (isCurrent) return localDateStr();
  if (isFuture)  return `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

export const getCategoryOutliers = (year: number, month?: number, comparison: "mom" | "yoy" = "mom") => {
  const today = month !== undefined ? outliersRefDate(year, month) : localDateStr();
  const compParam = comparison === "yoy" ? "&comparison=yoy" : "";
  return api.get<CategoryOutliersData>(`/budgets/${year}/category-outliers?today=${today}${compParam}`);
};

export const getCategoryOutliersYtd = (year: number) =>
  api.get<CategoryOutliersData>(`/budgets/${year}/category-outliers-ytd?today=${localDateStr()}`);

export const getCategoryAverages = (year: number, month: number) =>
  api.get<import("../types").CategoryAveragesData>(`/dashboard/category-averages?year=${year}&month=${month}`);

export const getSpendingVelocity = (year: number, month: number) => {
  const today = outliersRefDate(year, month);
  return api.get<import("../types").SpendingVelocityData>(`/dashboard/spending-velocity?year=${year}&month=${month}&today=${today}`);
};

export const getOutlierTransactions = (year: number, month: number) =>
  api.get<import("../types").OutlierTransactionsData>(`/dashboard/outlier-transactions?year=${year}&month=${month}`);

export const getBudgetSettings = () =>
  api.get<{ jointSplitRatio: number }>("/budgets/settings");

export const updateBudgetSettings = (jointSplitRatio: number) =>
  api.put<{ jointSplitRatio: number }>("/budgets/settings", { jointSplitRatio });

// Dashboard
export const getDataRange = () =>
  api.get<{ minYear: number; minMonth: number; maxYear: number; maxMonth: number }>("/dashboard/data-range");

export const getDashboard = (year?: number, month?: number) => {
  const params = new URLSearchParams();
  if (year) params.set("year", year.toString());
  if (month) params.set("month", month.toString());
  const query = params.toString() ? `?${params}` : "";
  return api.get<DashboardData>(`/dashboard${query}`);
};

export const getCategoryTrend = (year?: number, month?: number, parentCategoryId?: string) => {
  const params = new URLSearchParams();
  if (year) params.set("year", year.toString());
  if (month) params.set("month", month.toString());
  if (parentCategoryId) params.set("parentCategoryId", parentCategoryId);
  const query = params.toString() ? `?${params}` : "";
  return api.get<CategoryTrendData>(`/dashboard/category-trend${query}`);
};

// Recurrence Rules
export interface LinkedExpense {
  id: string;
  date: string;
  amount: string;
  description: string;
  account: { id: string; name: string };
}

export const getUpcomingRecurring = (days = 14) =>
  api.get<UpcomingExpenseItem[]>(`/recurrence-rules/upcoming?days=${days}`);
export const getRecurringHistory = (months = 6) =>
  api.get<RecurringHistoryMonth[]>(`/recurrence-rules/history?months=${months}`);

export const getRecurrenceRules = (params?: { includeInactive?: boolean }) => {
  const query = params?.includeInactive ? "?includeInactive=true" : "";
  return api.get<RecurrenceRule[]>(`/recurrence-rules${query}`);
};
export const getRecurrenceRuleExpenses = (id: string) =>
  api.get<LinkedExpense[]>(`/recurrence-rules/${id}/expenses`);
export const createRecurrenceRule = (data: Record<string, unknown>) =>
  api.post<RecurrenceRule>("/recurrence-rules", data);
export const updateRecurrenceRule = (id: string, data: Record<string, unknown>) =>
  api.put<RecurrenceRule>(`/recurrence-rules/${id}`, data);
export const archiveRecurrenceRule = (id: string) => api.post(`/recurrence-rules/${id}/archive`, {});
export const deleteRecurrenceRule = (id: string) => api.delete(`/recurrence-rules/${id}`);
export const processRecurringExpenses = () => api.post<{ processed: number }>("/recurrence-rules/process", {});

// Investments
export const getInvestmentAccounts = () =>
  api.get<InvestmentAccountSummary[]>("/investments/accounts");
export const getAllocationSummary = (filter?: "all" | "taxable" | "tax-advantaged") =>
  api.get<AllocationSummary>(
    `/investments/allocation${filter && filter !== "all" ? `?filter=${filter}` : ""}`
  );
export const getInvestmentHoldings = (accountId: string) =>
  api.get<InvestmentHolding[]>(`/investments/holdings/${accountId}`);
export const createHolding = (data: { accountId: string; ticker: string; name: string; type?: string | null; group?: string | null }) =>
  api.post<InvestmentHolding>("/investments/holdings", data);
export const patchHolding = (id: string, data: { group?: string | null; name?: string }) =>
  api.patch<InvestmentHolding>(`/investments/holdings/${id}`, data);
export const deleteHolding = (id: string, force = false) =>
  api.delete(`/investments/holdings/${id}${force ? "?force=true" : ""}`);
export const createLot = (data: { holdingId: string; quantity: number; costPerShare: number; acquiredDate?: string | null }) =>
  api.post<InvestmentLot>("/investments/lots", data);
export const updateLot = (id: string, data: { quantity?: number; costPerShare?: number; acquiredDate?: string | null }) =>
  api.put<InvestmentLot>(`/investments/lots/${id}`, data);
export const deleteLot = (id: string, force = false) =>
  api.delete(`/investments/lots/${id}${force ? "?force=true" : ""}`);
export const searchTickers = (q: string) =>
  api.get<TickerSearchResult[]>(`/investments/search?q=${encodeURIComponent(q)}`);
export const resolveTicker = (q: string) =>
  api.get<TickerSearchResult>(`/investments/search/resolve?q=${encodeURIComponent(q)}`);
export const refreshPrices = (source: string) => api.post<{ updated: number; tickers: string[] }>("/investments/prices/refresh", { source });
export const getTickerPrice = (ticker: string, date?: string) => {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return api.get<{ ticker: string; price: number; priceDate: string }>(
    `/investments/prices/${encodeURIComponent(ticker)}${query}`,
  );
};
export const importInvestments = (
  accountId: string,
  rows: Array<{ symbol: string; purchaseDate: string; price: number; quantity: number }>
) =>
  api.post<{ imported: number; errors: Array<{ row: number; message: string }> }>(
    "/investments/import",
    { accountId, rows }
  );
export const getManualInvestments = (accountId: string) =>
  api.get<ManualInvestment[]>(`/investments/manual/${accountId}`);
export const createManualInvestment = (data: {
  accountId: string; name: string; group?: string | null; totalCost?: number | null; marketValue: number;
}) => api.post<ManualInvestment>("/investments/manual", data);
export const updateManualInvestment = (id: string, data: {
  name?: string; group?: string | null; totalCost?: number | null; marketValue?: number;
}) => api.put<ManualInvestment>(`/investments/manual/${id}`, data);
export const deleteManualInvestment = (id: string) => api.delete(`/investments/manual/${id}`);

export const getInvestmentActivity = (accountId: string) =>
  api.get<InvestmentActivity[]>(`/investments/activity/${accountId}`);

export const updateSaleActivity = (id: string, data: { pricePerShare: number; fees?: number }) =>
  api.patch<InvestmentActivity>(`/investments/activity/${id}`, data);

export interface SellPreviewLot {
  lotId: string;
  acquiredDate: string;
  shares: number;
  costPerShare: number;
  termType: "SHORT" | "LONG";
  proceeds: number;
  costBasis: number;
  gain: number;
}

export interface SellPreviewResult {
  lotBreakdown: SellPreviewLot[];
  grossProceeds: number;
  fees: number;
  netProceeds: number;
  stShares: number;
  ltShares: number;
  stGain: number;
  ltGain: number;
  totalGain: number;
}

export interface LotAllocationInput {
  lotId: string;
  shares: number;
}

export interface SellPreviewRequest {
  holdingId: string;
  sharesToSell: number;
  pricePerShare: number;
  saleDate: string;
  fees: number;
  costBasisMethod?: "FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN";
  lotAllocations?: LotAllocationInput[];
}

export interface SellRequest extends SellPreviewRequest {
  destinationAccountId: string;
  notes?: string;
}

export interface SellResponse {
  activity: InvestmentActivity;
  income: Income;
  holding: InvestmentHolding | null;
}

export const previewSell = (data: SellPreviewRequest) =>
  api.post<SellPreviewResult>("/investments/sell/preview", data);

export const executeSell = (data: SellRequest) =>
  api.post<SellResponse>("/investments/sell", data);

export const getInvestmentGrowth = (accountId: string) =>
  api.get<{ points: GrowthPoint[] }>(`/investments/growth/${accountId}`);

export const importQfx = (
  accountId: string,
  transactions: QfxTransactionInput[],
  cashBalance?: number | null,
) => api.post<{ imported: number; total: number }>(
  `/investments/qfx-import/${accountId}`,
  { transactions, cashBalance },
);

export const importQfxDividends = (
  accountId: string,
  dividends: QfxDividendInput[],
) => api.post<{ imported: number; skipped: number }>(
  `/investments/qfx-dividends/${accountId}`,
  { dividends },
);

// ── Realized Gain Snapshots ───────────────────────────────────────────────
export const getAllGainSnapshots = (year: number) =>
  api.get<RealizedGainSnapshotWithAccount[]>(`/investments/gain-snapshots?year=${year}`);
export const getGainSnapshot = (accountId: string, year?: number) =>
  api.get<RealizedGainSnapshot | null>(
    `/investments/gain-snapshot/${accountId}${year != null ? `?year=${year}` : ""}`
  );
export const upsertGainSnapshot = (data: {
  accountId: string;
  year: number;
  longTermGain?: number | null;
  shortTermGain?: number | null;
  longTermLoss?: number | null;
  shortTermLoss?: number | null;
  snapshotDate: string;
  notes?: string | null;
}) => api.put<RealizedGainSnapshot>("/investments/gain-snapshot", data);
export const deleteGainSnapshot = (accountId: string, year: number) =>
  api.delete(`/investments/gain-snapshot/${accountId}/${year}`);

// Pending Dividends
export const getPendingDividends = (accountId: string) =>
  api.get<PendingDividend[]>(`/pending-dividends/${accountId}`);
export const confirmPendingDividend = (id: string, data: {
  date: string;
  perShareAmount: number;
  shares: number;
  totalAmount: number;
  categoryId?: string | null;
  taxClassification?: TaxClassification | null;
  notes?: string | null;
  source?: string | null;
}) => api.post<{ activity: InvestmentActivity; income: Income; pendingDividend: PendingDividend }>(
  `/pending-dividends/${id}/confirm`,
  data,
);
export const dismissPendingDividend = (id: string) =>
  api.post<PendingDividend>(`/pending-dividends/${id}/dismiss`, {});

export const getConfirmedDividend = (activityId: string) =>
  api.get<import("../types").ConfirmedDividendInfo>(`/pending-dividends/confirmed/${activityId}`);

export const updateConfirmedDividend = (pendingDividendId: string, data: {
  paymentDate?: string;
  amount?: number;
}) => api.patch<{ pendingDividend: PendingDividend; activity: InvestmentActivity; income: Income | null }>(
  `/pending-dividends/${pendingDividendId}`,
  data,
);

export const confirmReinvestDividend = (id: string, data: {
  exDate: string;
  reinvestDate: string;
  perShareAmount: number;
  shares: number;
  totalAmount: number;
  reinvestPrice: number;
  reinvestQuantity: number;
  taxClassification?: TaxClassification | null;
  notes?: string | null;
}) => api.post<{ dividendActivity: InvestmentActivity; purchaseActivity: InvestmentActivity; pendingDividend: PendingDividend }>(
  `/pending-dividends/${id}/confirm-reinvest`,
  data,
);

// Notifications
export const getNotifications = () =>
  api.get<import("../types").NotificationData>("/notifications");

// Asset Classes
export const getAssetClasses = () => api.get<AssetClass[]>("/asset-classes");
export const getFlatAssetClasses = () => api.get<AssetClass[]>("/asset-classes/flat");
export const createAssetClass = (data: { name: string; parentId?: string | null; color?: string | null }) =>
  api.post<AssetClass>("/asset-classes", data);
export const updateAssetClass = (id: string, data: { name?: string; color?: string | null }) =>
  api.put<AssetClass>(`/asset-classes/${id}`, data);
export const deleteAssetClass = (id: string) => api.delete(`/asset-classes/${id}`);
export const setAssetClassTarget = (id: string, targetPct: number) =>
  api.put(`/asset-classes/${id}/target`, { targetPct });
export const deleteAssetClassTarget = (id: string) =>
  api.delete(`/asset-classes/${id}/target`);

// Instruments (Securities)
export const getInstruments = () => api.get<Instrument[]>("/instruments");
export const getInstrument = (id: string) => api.get<Instrument>(`/instruments/${id}`);
export const createInstrument = (data: { primaryTicker: string; name?: string | null }) =>
  api.post<Instrument>("/instruments", data);
export const patchInstrument = (id: string, data: { name?: string | null; isCollectible?: boolean }) =>
  api.patch<Instrument>(`/instruments/${id}`, data);
export const setInstrumentWeights = (
  id: string,
  weights: { assetClassId: string; weight: number }[]
) => api.put<Instrument>(`/instruments/${id}/weights`, { weights });
export const addInstrumentTicker = (id: string, ticker: string) =>
  api.post<Instrument>(`/instruments/${id}/tickers`, { ticker });
export const removeInstrumentTicker = (id: string, ticker: string) =>
  api.delete<Instrument>(`/instruments/${id}/tickers/${encodeURIComponent(ticker)}`);
export const mergeInstrument = (id: string, otherId: string) =>
  api.post<Instrument>(`/instruments/${id}/merge`, { otherId });
export const deleteInstrument = (id: string) => api.delete(`/instruments/${id}`);

// Transfers
export const getTransfers = (params?: {
  accountId?: string;
  from?: string;
  to?: string;
  confirmed?: boolean;
}) => {
  const query = params ? "?" + new URLSearchParams(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )
  ).toString() : "";
  return api.get<Transfer[]>(`/transfers${query}`);
};

export const createTransfer = (data: {
  description: string;
  amount: number;
  date: string;
  notes?: string | null;
  fromAccountId: string;
  toAccountId: string;
  isConfirmed?: boolean;
  recurrence?: {
    frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    interval?: number;
    endDate?: string | null;
  } | null;
}) => api.post<Transfer>("/transfers", data);

export const updateTransfer = (id: string, data: Partial<{
  description: string;
  amount: number;
  date: string;
  notes: string | null;
  fromAccountId: string;
  toAccountId: string;
  isConfirmed: boolean;
}>) => api.put<Transfer>(`/transfers/${id}`, data);

export const confirmTransfer = (id: string) =>
  api.post<Transfer>(`/transfers/${id}/confirm`, {});

export const deleteTransfer = (id: string, deleteFuture?: boolean) =>
  api.delete(`/transfers/${id}${deleteFuture ? "?deleteFuture=true" : ""}`);

// Transfer Rules
export const getTransferRules = () => api.get<TransferRule[]>("/transfers/rules");

export const updateTransferRule = (id: string, data: Partial<{
  description: string;
  amount: number;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  startDate: string;
  endDate: string | null;
  fromAccountId: string;
  toAccountId: string;
}>) => api.put<TransferRule>(`/transfers/rules/${id}`, data);

export const archiveTransferRule = (id: string) =>
  api.post(`/transfers/rules/${id}/archive`, {});

// Statement Overrides
export const getStatementOverrides = (accountId: string) =>
  api.get<StatementOverride[]>(`/statement-overrides/${accountId}`);

export const upsertStatementOverride = (data: {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  notes?: string | null;
}) => api.post<StatementOverride>("/statement-overrides", data);

export const updateStatementOverride = (id: string, data: Partial<{
  periodStart: string;
  periodEnd: string;
  amount: number;
  notes: string | null;
}>) => api.put<StatementOverride>(`/statement-overrides/${id}`, data);

export const deleteStatementOverride = (id: string) =>
  api.delete(`/statement-overrides/${id}`);

// Cash flow
export const getCashFlow = (windowDays = 45) => {
  // Pass the client's local date so the server anchors the window to "today"
  // in the user's timezone rather than UTC.
  const localDate = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  return api.get<CashFlowResponse>(`/cash-flow?windowDays=${windowDays}&date=${localDate}`);
};

export const createBalanceAdjustment = (data: {
  accountId: string;
  date: string;
  amount: number;
  description?: string;
  notes?: string;
}) => api.post<{ id: string }>("/cash-flow/adjustments", data);

export const updateBalanceAdjustment = (id: string, data: {
  date?: string;
  amount?: number;
  description?: string;
}) => api.patch<{ id: string }>(`/cash-flow/adjustments/${id}`, data);

export const deleteBalanceAdjustment = (id: string) =>
  api.delete(`/cash-flow/adjustments/${id}`);

// Withdrawals
export const getWithdrawals = (year?: number) =>
  api.get<WithdrawalEvent[]>(`/withdrawals${year != null ? `?year=${year}` : ""}`);

export const getWithdrawalSummary = (year?: number) => {
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
  const params = new URLSearchParams({ today });
  if (year != null) params.set("year", String(year));
  return api.get<WithdrawalSummary>(`/withdrawals/summary?${params}`);
};

export const getInvestmentSettings = () =>
  api.get<InvestmentSettings>("/withdrawals/settings");

export const updateInvestmentSettings = (data: Partial<InvestmentSettings>) =>
  api.patch<InvestmentSettings>("/withdrawals/settings", data);

// Tax Assumptions
export const getTaxAssumptions = (year: number) =>
  api.get<TaxAssumptions>(`/tax-assumptions/${year}`);

export const updateTaxAssumptions = (
  year: number,
  data: Partial<Omit<TaxAssumptions, "quarterlyPayments">>,
) => api.put<TaxAssumptions>(`/tax-assumptions/${year}`, data);

export const updateTaxQuarterlyPayments = (
  year: number,
  data: { federal: (number | null)[]; ca: (number | null)[] },
) => api.put<TaxAssumptions>(`/tax-assumptions/${year}/quarterly`, data);
