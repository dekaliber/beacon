import { api } from "./client";
import type {
  Account,
  Budget,
  BudgetDetail,
  BudgetOverview,
  Category,
  DashboardData,
  Expense,
  Income,
  PaginatedResponse,
  RecurrenceRule,
  Tag,
  TransactionGroup,
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

// Recurrence Rules
export const getRecurrenceRules = () => api.get<RecurrenceRule[]>("/recurrence-rules");
export const createRecurrenceRule = (data: Record<string, unknown>) =>
  api.post<RecurrenceRule>("/recurrence-rules", data);
export const deleteRecurrenceRule = (id: string) => api.delete(`/recurrence-rules/${id}`);
export const processRecurringExpenses = () => api.post<{ processed: number }>("/recurrence-rules/process", {});
