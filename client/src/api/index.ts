import { api } from "./client";
import type {
  Account,
  Budget,
  BudgetDetail,
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
export const getCategories = () => api.get<Category[]>("/categories");
export const getFlatCategories = () => api.get<Category[]>("/categories/flat");
export const createCategory = (data: Partial<Category>) => api.post<Category>("/categories", data);
export const updateCategory = (id: string, data: Partial<Category>) => api.put<Category>(`/categories/${id}`, data);
export const deleteCategory = (id: string) => api.delete(`/categories/${id}`);

// Expenses
export const getExpenses = (params?: Record<string, string>) => {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.get<PaginatedResponse<Expense>>(`/expenses${query}`);
};
export const createExpense = (data: Record<string, unknown>) => api.post<Expense>("/expenses", data);
export const updateExpense = (id: string, data: Record<string, unknown>) => api.put<Expense>(`/expenses/${id}`, data);
export const deleteExpense = (id: string) => api.delete(`/expenses/${id}`);

// Income
export const getIncome = (params?: Record<string, string>) => {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.get<PaginatedResponse<Income>>(`/income${query}`);
};
export const createIncome = (data: Record<string, unknown>) => api.post<Income>("/income", data);
export const updateIncome = (id: string, data: Record<string, unknown>) => api.put<Income>(`/income/${id}`, data);
export const deleteIncome = (id: string) => api.delete(`/income/${id}`);

// Tags
export const getTags = () => api.get<Tag[]>("/tags");
export const createTag = (data: { name: string; color?: string }) => api.post<Tag>("/tags", data);
export const updateTag = (id: string, data: { name?: string; color?: string }) => api.put<Tag>(`/tags/${id}`, data);
export const deleteTag = (id: string) => api.delete(`/tags/${id}`);

// Transaction Groups
export const getTransactionGroups = () => api.get<TransactionGroup[]>("/transaction-groups");
export const getTransactionGroup = (id: string) => api.get<TransactionGroup>(`/transaction-groups/${id}`);
export const createTransactionGroup = (data: Record<string, unknown>) =>
  api.post<TransactionGroup>("/transaction-groups", data);
export const updateTransactionGroup = (id: string, data: Record<string, unknown>) =>
  api.put<TransactionGroup>(`/transaction-groups/${id}`, data);
export const updateTransactionGroupMembers = (id: string, data: Record<string, unknown>) =>
  api.patch<TransactionGroup>(`/transaction-groups/${id}/members`, data);
export const deleteTransactionGroup = (id: string) => api.delete(`/transaction-groups/${id}`);

// Budgets
export const getBudgets = (year?: number) => {
  const query = year ? `?year=${year}` : "";
  return api.get<Budget[]>(`/budgets${query}`);
};
export const getBudgetDetail = (year: number, month: number) =>
  api.get<BudgetDetail>(`/budgets/${year}/${month}`);
export const saveBudget = (data: { amount: number; month: number; year: number }) =>
  api.post<Budget>("/budgets", data);
export const deleteBudget = (id: string) => api.delete(`/budgets/${id}`);

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
