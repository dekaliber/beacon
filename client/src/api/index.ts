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
  PendingBuy,
  PendingSale,
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
export const getVendorCategory = (vendor: string, today: string) =>
  api.get<{ categoryId: string | null }>(`/expenses/vendor-category?vendor=${encodeURIComponent(vendor)}&today=${today}`);
export const getVendorAccount = (vendor: string, today: string) =>
  api.get<{ accountId: string | null }>(`/expenses/vendor-account?vendor=${encodeURIComponent(vendor)}&today=${today}`);
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

export const getCategoryAverages = (year: number, month: number) => {
  const today = outliersRefDate(year, month);
  return api.get<import("../types").CategoryAveragesData>(`/dashboard/category-averages?year=${year}&month=${month}&today=${today}`);
};

export const getSpendingVelocity = (year: number, month: number) => {
  const today = outliersRefDate(year, month);
  return api.get<import("../types").SpendingVelocityData>(`/dashboard/spending-velocity?year=${year}&month=${month}&today=${today}`);
};

export const getOutlierTransactions = (year: number, month: number) => {
  const today = outliersRefDate(year, month);
  return api.get<import("../types").OutlierTransactionsData>(`/dashboard/outlier-transactions?year=${year}&month=${month}&today=${today}`);
};

export const getMtdChart = (year: number, month: number) => {
  const today = outliersRefDate(year, month);
  return api.get<import("../types").MtdChartData>(
    `/budgets/${year}/monthly-chart?month=${month}&today=${today}`,
  );
};

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
  const today = (year !== undefined && month !== undefined) ? outliersRefDate(year, month) : localDateStr();
  params.set("today", today);
  return api.get<DashboardData>(`/dashboard?${params}`);
};

export const getNetWorth = () => {
  const today = new Date().toLocaleDateString("en-CA");
  return api.get<import("../types").NetWorthData>(`/dashboard/net-worth?today=${today}`);
};

export const getCategoryYearTrends = () => {
  const today = new Date().toLocaleDateString("en-CA");
  return api.get<import("../types").CategoryYearTrendsData>(`/dashboard/category-year-trends?today=${today}`);
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
export const createHolding = (data: { accountId: string; ticker: string; name: string; type?: string | null; group?: string | null; coinGeckoId?: string | null }) =>
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
export const searchCryptoTickers = (q: string) =>
  api.get<TickerSearchResult[]>(`/investments/search/crypto?q=${encodeURIComponent(q)}`);
export const resolveTicker = (q: string) =>
  api.get<TickerSearchResult>(`/investments/search/resolve?q=${encodeURIComponent(q)}`);
export const refreshPrices = (source: string) => api.post<{ updated: number; tickers: string[] }>("/investments/prices/refresh", { source });
export const getTickerPrice = (ticker: string, date?: string, coinGeckoId?: string | null) => {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (coinGeckoId) params.set("coinGeckoId", coinGeckoId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
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

export interface TransferRequest {
  holdingId: string;
  destinationAccountId: string;
  sharesToTransfer?: number;
  costBasisMethod?: "FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN";
  lotAllocations?: LotAllocationInput[];
  transferDate: string;
  notes?: string;
}

export interface TransferResponse {
  sourceActivity: InvestmentActivity;
  destActivity: InvestmentActivity;
  sourceHolding: InvestmentHolding | null;
  destHolding: InvestmentHolding;
}

export const executeTransfer = (data: TransferRequest) =>
  api.post<TransferResponse>("/investments/transfer", data);

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

export const getQfxLastDate = (accountId: string) =>
  api.get<{ lastDate: string | null }>(`/investments/qfx-last-date/${accountId}`);

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
  notes?: string | null;
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

// ── Options Trading ────────────────────────────────────────────────────────────

export type OptionType = "CALL" | "PUT";
export type OptionSide = "BUY" | "SELL";
export type OptionStatus = "OPEN" | "CLOSED" | "EXPIRED" | "ASSIGNED";
export type OptionOutcome = "EXPIRED_WORTHLESS" | "CLOSED_EARLY" | "ROLLED" | "ASSIGNED";

export interface OptionsSettings {
  id: string;
  startingBasis: number;
  targetReturn: number;
  startingWeek: string | null; // ISO date of Monday of starting week, e.g. "2026-04-20"
  defaultCashAccountId: string | null; // optional default banking account for premium income
  createdAt: string;
  updatedAt: string;
}

export interface OptionsTicker {
  id: string;
  userId: string;
  symbol: string;
  opportunityCostStartDate: string | null;
  opportunityCostStartPrice: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OptionsPosition {
  id: string;
  userId: string;
  tickerId: string;
  groupId: string | null;
  sequenceInGroup: number | null;
  optionType: OptionType;
  side: OptionSide;
  strikePrice: number;
  expirationDate: string; // YYYY-MM-DD
  openedAt: string;       // ISO UTC datetime
  contracts: number;
  premiumPerShare: number;
  feesOpen: number | null;
  shareCostBasis: number | null;
  stockPriceAtOpen: number | null;
  currentPremiumPerShare: number | null;
  currentDelta: number | null;
  currentDeltaAsOf: string | null; // ISO UTC — Tradier greek time for currentDelta
  excludeFromLivePnl: boolean;
  deltaAtOpen: number | null;
  deltaAtOpenCapturedAt: string | null; // ISO UTC datetime
  notes: string | null;
  status: OptionStatus;
  outcome: OptionOutcome | null;
  closedAt: string | null;
  closePremiumPerShare: number | null;
  feesClose: number | null;
  contractsAssigned: number | null;
  stockPriceAtClose: number | null;
  assignedFromStrikePrice: number | null;
  assignedFromExpirationDate: string | null;
  investmentAccountId: string | null;
  bankingAccountId: string | null;
  splitGroupId: string | null;
  isDraft: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  ticker: OptionsTicker;
  group: OptionsPositionGroup | null;
}

export interface OptionsPositionGroup {
  id: string;
  userId: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  positions?: OptionsPosition[];
}

export type OptionsPositionInput = {
  tickerId: string;
  groupId?: string | null;
  sequenceInGroup?: number | null;
  optionType: OptionType;
  side?: OptionSide;
  strikePrice: number;
  expirationDate: string;
  openedAt: string;
  contracts: number;
  premiumPerShare: number;
  feesOpen?: number | null;
  shareCostBasis?: number | null;
  stockPriceAtOpen?: number | null;
  currentPremiumPerShare?: number | null;
  currentDelta?: number | null;
  currentDeltaAsOf?: string | null;
  excludeFromLivePnl?: boolean;
  deltaAtOpen?: number | null;
  deltaAtOpenCapturedAt?: string | null;
  notes?: string | null;
  assignedFromStrikePrice?: number | null;
  assignedFromExpirationDate?: string | null;
  investmentAccountId?: string | null;
  isDraft?: boolean;
};

export type OptionsCloseInput = {
  status: Exclude<OptionStatus, "OPEN">;
  outcome: OptionOutcome;
  closedAt?: string | null;
  closePremiumPerShare?: number | null;
  feesClose?: number | null;
  contractsAssigned?: number | null;
  stockPriceAtClose?: number | null;
  investmentAccountId?: string | null;
  bankingAccountId?: string | null;
};

export type OptionsRollInput = {
  closedAt?: string | null;
  closePremiumPerShare?: number | null;
  feesClose?: number | null;
  newPremiumPerShare: number;
  newStrikePrice: number;
  newExpirationDate: string;
  newStockPriceAtOpen?: number | null;
  newFeesOpen?: number | null;
  // Partial roll: roll only N of the position's contracts (omit to roll all).
  contracts?: number;
};

export type OptionsPartialCloseInput = {
  contracts: number;
  outcome: Exclude<OptionOutcome, "ROLLED">;
  closedAt?: string | null;
  closePremiumPerShare?: number | null;
  feesClose?: number | null;
  stockPriceAtClose?: number | null;
  investmentAccountId?: string | null;
  bankingAccountId?: string | null;
};

// Settings
export const getOptionsSettings = () =>
  api.get<OptionsSettings | null>("/options/settings");

export const updateOptionsSettings = (data: Partial<OptionsSettings>) =>
  api.put<OptionsSettings>("/options/settings", data);

// Capital Changes
export interface OptionsCapitalChange {
  id: string;
  userId: string;
  effectiveDate: string; // YYYY-MM-DD
  delta: number; // positive = deposit, negative = withdrawal
  note: string | null;
  // NAV mark-to-market captured at this boundary; null when not captured (older
  // rows / market data unavailable), in which case Return on basis falls back.
  unrealizedSnapshot: number | null;
  snapshotCapturedAt: string | null;
  snapshotExcludesOptions: boolean;
  snapshotDetail: OptionsBasisSnapshotDetail | null;
  createdAt: string;
  updatedAt: string;
}

// Audit breakdown behind unrealizedSnapshot (per-ticker / per-position marks).
export interface OptionsBasisSnapshotDetail {
  capturedVia: "tradier-live" | "yahoo-historical";
  effectiveDate: string;
  isLive: boolean;
  assignedLots: {
    ticker: string;
    shares: number;
    costBasis: number;
    price: number;
    source: string;
    unrealized: number;
    ccStrike: number | null; // covered-call strike the gain was capped at (ITM), else null
    coveredShares: number; // shares capped at the CC strike, else 0
  }[];
  openOptions: {
    positionId: string;
    symbol: string;
    optionType: string;
    strike: number;
    expiration: string;
    contracts: number;
    premiumReceived: number;
    currentMark: number;
    source: string;
    mark: number;
  }[];
  totals: { assignedUnrealized: number; openOptionMark: number; unrealizedSnapshot: number };
}

export const getOptionsCapitalChanges = () =>
  api.get<OptionsCapitalChange[]>("/options/capital-changes");

export const createOptionsCapitalChange = (data: { effectiveDate: string; delta: number; note?: string | null; today?: string }) =>
  api.post<OptionsCapitalChange>("/options/capital-changes", data);

export const deleteOptionsCapitalChange = (id: string) =>
  api.delete(`/options/capital-changes/${id}`);

// Tickers
export const getOptionsTickers = () =>
  api.get<OptionsTicker[]>("/options/tickers");

export const createOptionsTicker = (data: { symbol: string; opportunityCostStartDate?: string | null; opportunityCostStartPrice?: number | null }) =>
  api.post<OptionsTicker>("/options/tickers", data);

export const updateOptionsTicker = (id: string, data: Partial<OptionsTicker>) =>
  api.put<OptionsTicker>(`/options/tickers/${id}`, data);

// Position Groups
export const getOptionsGroups = () =>
  api.get<OptionsPositionGroup[]>("/options/groups");

export const createOptionsGroup = (data: { label?: string | null }) =>
  api.post<OptionsPositionGroup>("/options/groups", data);

export const updateOptionsGroup = (id: string, data: { label?: string | null }) =>
  api.put<OptionsPositionGroup>(`/options/groups/${id}`, data);

// Positions
export const getOptionsPositions = (status?: "open" | "closed") =>
  api.get<OptionsPosition[]>(`/options/positions${status ? `?status=${status}` : ""}`);

export const createOptionsPosition = (data: OptionsPositionInput) =>
  api.post<OptionsPosition>("/options/positions", data);

export const updateOptionsPosition = (id: string, data: Partial<OptionsPositionInput>) =>
  api.put<OptionsPosition>(`/options/positions/${id}`, data);

export const closeOptionsPosition = (id: string, data: OptionsCloseInput) =>
  api.put<OptionsPosition>(`/options/positions/${id}`, data);

export const rollOptionsPosition = (id: string, data: OptionsRollInput) =>
  api.post<{ closed: OptionsPosition; opened: OptionsPosition }>(`/options/positions/${id}/roll`, data);

export const partialCloseOptionsPosition = (id: string, data: OptionsPartialCloseInput) =>
  api.post<OptionsPosition>(`/options/positions/${id}/partial-close`, data);

export type OptionsCloseEditInput = {
  outcome?: OptionOutcome;
  status?: Exclude<OptionStatus, "OPEN">;
  closedAt?: string | null;
  closePremiumPerShare?: number | null;
  feesClose?: number | null;
  contractsAssigned?: number | null;
  stockPriceAtClose?: number | null;
  investmentAccountId?: string | null;
  bankingAccountId?: string | null;
};

export const editClosedPosition = (id: string, data: OptionsCloseEditInput) =>
  api.put<OptionsPosition>(`/options/positions/${id}`, data);

export const deleteOptionsPosition = (id: string) =>
  api.delete(`/options/positions/${id}`);

export const importOptionsPositions = (positions: Record<string, unknown>[]) =>
  api.post<{ imported: number; errors: Array<{ row: number; message: string }> }>(
    "/options/positions/import", { positions }
  );

export type OptionQuote = {
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  mark: number | null;
  impliedVolatility: number | null;
  volume: number | null;
  openInterest: number | null;
  inTheMoney: boolean | null;
  delta: number | null;
  deltaUpdatedAt: string | null; // ISO UTC — Tradier greeks.updated_at (delta computation time)
  capturedAt: string | null; // ISO UTC timestamp
};

export const getOptionQuote = (params: {
  symbol: string;
  type: "CALL" | "PUT";
  strike: number;
  expiration: string; // YYYY-MM-DD
}) => {
  const qs = new URLSearchParams({
    symbol: params.symbol,
    type: params.type,
    strike: String(params.strike),
    expiration: params.expiration,
  });
  return api.get<OptionQuote>(`/options/option-quote?${qs}`);
};

export const getUnderlyingQuote = (symbol: string) =>
  api.get<{ price: number; priceDate: string }>(`/options/stock-quote/${encodeURIComponent(symbol)}`);

export const getUnderlyingQuotes = (symbols: string[]) =>
  api.get<Record<string, { price: number; priceDate: string }>>(
    `/options/stock-quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`
  );

export interface OptionsBenchmark {
  symbol: string;
  label: string;
  pctChange: number | null;
  asOf: string | null;
}

export const getOptionsBenchmark = (start: string) =>
  api.get<{ benchmarks: OptionsBenchmark[] }>(
    `/options/benchmark?start=${encodeURIComponent(start)}`
  );

export const getStockPriceAtOpen = (symbol: string, openedAt: string) =>
  api.get<{ price: number; timeLabel: string }>(
    `/options/stock-price-at-open?symbol=${encodeURIComponent(symbol)}&openedAt=${encodeURIComponent(openedAt)}`
  );

// ── Pending Buys ──────────────────────────────────────────────────────────────

export const getPendingBuys = (accountId: string) =>
  api.get<PendingBuy[]>(`/pending-buys/${accountId}`);

export const confirmPendingBuy = (
  id: string,
  data: { acquiredDate: string; quantity: number; costPerShare: number; notes?: string | null }
) => api.post<{ pendingBuy: PendingBuy }>(`/pending-buys/${id}/confirm`, data);

export const dismissPendingBuy = (id: string) =>
  api.post<PendingBuy>(`/pending-buys/${id}/dismiss`, {});

// ── Pending Sales ─────────────────────────────────────────────────────────────

export const getPendingSales = (accountId: string) =>
  api.get<PendingSale[]>(`/pending-sales/${accountId}`);

export const confirmPendingSale = (
  id: string,
  data: {
    saleDate: string;
    pricePerShare: number;
    fees?: number;
    costBasisMethod?: string;
    lotAllocations?: { lotId: string; shares: number }[];
    destinationAccountId: string;
    notes?: string | null;
  }
) => api.post<{ pendingSale: PendingSale }>(`/pending-sales/${id}/confirm`, data);

export const dismissPendingSale = (id: string) =>
  api.post<PendingSale>(`/pending-sales/${id}/dismiss`, {});

export type AssignmentBatch = {
  strikePrice: string;
  expirationDate: string; // YYYY-MM-DD
  totalContracts: number;
  totalShares: number;
  contractsCovered: number;
  contractsRemaining: number;
  weightedCostPerShare: number | null;
};

export const getOptionAssignedBatches = (ticker: string, accountId: string) =>
  api.get<AssignmentBatch[]>(
    `/pending-buys/lots/by-assignment?ticker=${encodeURIComponent(ticker)}&accountId=${encodeURIComponent(accountId)}`
  );

// ── Upcoming Earnings ─────────────────────────────────────────────────────────
// Tradier has no corporate-events feed, so these are resolved server-side
// (Finnhub, falling back to Yahoo in local development).

/** Before market open, after market close, or during market hours. */
export type EarningsTiming = "BMO" | "AMC" | "DMH";

export interface EarningsInfo {
  /** Earnings date in ET, as YYYY-MM-DD. */
  date: string;
  timing: EarningsTiming;
  /** True when the provider is projecting the date rather than confirming it. */
  isEstimate: boolean;
}

export const getOptionsEarnings = (symbols: string[], today: string) =>
  api.get<Record<string, EarningsInfo | null>>(
    `/options/earnings?symbols=${encodeURIComponent(symbols.join(","))}&today=${today}`
  );

// ── Option Screener ───────────────────────────────────────────────────────────

export interface ScreenerResult {
  ticker: string;
  expiration: string;
  dte: number;
  strike: number;
  optionType: "CALL" | "PUT";
  underlyingPrice: number | null;
  delta: number | null;
  iv: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  openInterest: number | null;
  volume: number | null;
  inTheMoney: boolean | null;
}

export interface ScreenerParams {
  tickers: string[];
  optionType: "CALL" | "PUT" | "BOTH";
  minDTE?: number;
  maxDTE?: number;
  minDelta?: number;
  maxDelta?: number;
  minOI?: number;
  minVolume?: number;
  strikeMin?: number;
  strikeMax?: number;
}

export const runOptionsScreener = (params: ScreenerParams) => {
  const qs = new URLSearchParams({
    tickers: params.tickers.join(","),
    optionType: params.optionType,
    ...(params.minDTE != null && { minDTE: String(params.minDTE) }),
    ...(params.maxDTE != null && { maxDTE: String(params.maxDTE) }),
    ...(params.minDelta != null && { minDelta: String(params.minDelta) }),
    ...(params.maxDelta != null && { maxDelta: String(params.maxDelta) }),
    ...(params.minOI != null && { minOI: String(params.minOI) }),
    ...(params.minVolume != null && { minVolume: String(params.minVolume) }),
    ...(params.strikeMin != null && { strikeMin: String(params.strikeMin) }),
    ...(params.strikeMax != null && { strikeMax: String(params.strikeMax) }),
  });
  return api.get<ScreenerResult[]>(`/options/screener?${qs}`);
};

// ── Assigned shares (stock acquired via assigned CSPs) ──────────────────────

export interface ActiveAssignedHolding {
  lotId: string;
  ticker: string;
  accountId: string;
  accountName: string | null;
  accountColor: string | null;
  shares: number;
  assignmentStrike: number;
  assignmentExpiration: string; // YYYY-MM-DD
  acquiredDate: string | null;
  openCallContracts: number; // outstanding CC contracts against this batch
  openCallAvgStrike: number | null; // contracts-weighted avg strike of those CCs
  stockPriceAtAssignment: number | null; // underlying price at close on assignment date
  fromOptionsPositionId: string | null;
  cspPremium: number; // this lot's originating CSP (+ any pre-assignment roll chain) net premium
  ccPremiumSinceAssignment: number; // batch-level: realized (closed/expired/assigned) CC premium against this lot; still-open CCs excluded
}

export interface RealizedDisposition {
  id: string;
  ticker: string;
  accountId: string;
  shares: number;
  assignmentStrike: number;
  assignmentExpiration: string; // YYYY-MM-DD
  salePricePerShare: number;
  realizedPnl: number;
  saleDate: string; // YYYY-MM-DD
  viaCoveredCall: boolean;
  cspPremium: number; // batch-level: originating CSP (+ roll chain) net premium
  ccPremiumSinceAssignment: number; // batch-level: realized (closed/expired/assigned) CC premium against this batch; still-open CCs excluded
}

export const getActiveAssignedHoldings = () =>
  api.get<ActiveAssignedHolding[]>("/assigned-shares/active");

export const getRealizedDispositions = () =>
  api.get<{ rows: RealizedDisposition[]; netRealizedPnl: number }>(
    "/assigned-shares/realized"
  );
