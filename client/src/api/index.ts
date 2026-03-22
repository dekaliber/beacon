import { api } from "./client";
import type {
  Account,
  Budget,
  BudgetDetail,
  BudgetOverview,
  CategoryOutliersData,
  CategoryTrendData,
  Category,
  DashboardData,
  Expense,
  Income,
  InvestmentAccountSummary,
  InvestmentActivity,
  InvestmentHolding,
  InvestmentLot,
  ManualInvestment,
  RealizedGainSnapshot,
  TickerSearchResult,
  PaginatedResponse,
  RecurrenceRule,
  RecurringHistoryMonth,
  Tag,
  TransactionGroup,
  UpcomingExpenseItem,
} from "../types";

// Accounts
export const getAccounts = () => api.get<Account[]>("/accounts");
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

// Tags
export const getTags = () => api.get<Tag[]>("/tags");
export const createTag = (data: { name: string; color?: string }) => api.post<Tag>("/tags", data);
export const updateTag = (id: string, data: { name?: string; color?: string }) => api.put<Tag>(`/tags/${id}`, data);
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
  api.get<BudgetOverview>(`/budgets/${year}`);

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

export const getCategoryOutliers = (year: number) =>
  api.get<CategoryOutliersData>(`/budgets/${year}/category-outliers`);

export const getBudgetSettings = () =>
  api.get<{ jointSplitRatio: number }>("/budgets/settings");

export const updateBudgetSettings = (jointSplitRatio: number) =>
  api.put<{ jointSplitRatio: number }>("/budgets/settings", { jointSplitRatio });

// Dashboard
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
export const getInvestmentHoldings = (accountId: string) =>
  api.get<InvestmentHolding[]>(`/investments/holdings/${accountId}`);
export const createHolding = (data: { accountId: string; ticker: string; name: string; type?: string | null; assetClass?: string | null }) =>
  api.post<InvestmentHolding>("/investments/holdings", data);
export const patchHolding = (id: string, data: { assetClass?: string | null; name?: string }) =>
  api.patch<InvestmentHolding>(`/investments/holdings/${id}`, data);
export const deleteHolding = (id: string) => api.delete(`/investments/holdings/${id}`);
export const createLot = (data: { holdingId: string; quantity: number; costPerShare: number; acquiredDate?: string | null }) =>
  api.post<InvestmentLot>("/investments/lots", data);
export const updateLot = (id: string, data: { quantity?: number; costPerShare?: number; acquiredDate?: string | null }) =>
  api.put<InvestmentLot>(`/investments/lots/${id}`, data);
export const deleteLot = (id: string) => api.delete(`/investments/lots/${id}`);
export const searchTickers = (q: string) =>
  api.get<TickerSearchResult[]>(`/investments/search?q=${encodeURIComponent(q)}`);
export const refreshPrices = () => api.post<{ updated: number; tickers: string[] }>("/investments/prices/refresh", {});
export const getTickerPrice = (ticker: string) =>
  api.get<{ ticker: string; price: number; priceDate: string }>(`/investments/prices/${encodeURIComponent(ticker)}`);
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
  accountId: string; name: string; assetClass?: string | null; totalCost?: number | null; marketValue: number;
}) => api.post<ManualInvestment>("/investments/manual", data);
export const updateManualInvestment = (id: string, data: {
  name?: string; assetClass?: string | null; totalCost?: number | null; marketValue?: number;
}) => api.put<ManualInvestment>(`/investments/manual/${id}`, data);
export const deleteManualInvestment = (id: string) => api.delete(`/investments/manual/${id}`);

export const getInvestmentActivity = (accountId: string) =>
  api.get<InvestmentActivity[]>(`/investments/activity/${accountId}`);

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

export interface SellPreviewRequest {
  holdingId: string;
  sharesToSell: number;
  pricePerShare: number;
  saleDate: string;
  fees: number;
  costBasisMethod: "FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN";
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

// ── Realized Gain Snapshots ───────────────────────────────────────────────
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
