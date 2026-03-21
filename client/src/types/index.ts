export interface Account {
  id: string;
  name: string;
  type: "CHECKING" | "SAVINGS" | "CREDIT_CARD" | "INVESTMENT";
  balance: string;
  currency: string;
  color: string | null;
  isJoint: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  kind: "EXPENSE" | "INCOME";
  isDefault: boolean;
  ignoreInBudget: boolean;
  parentId: string | null;
  parent?: Category | null;
  children?: Category[];
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseTag {
  expenseId: string;
  tagId: string;
  tag: Tag;
}

export interface IncomeTag {
  incomeId: string;
  tagId: string;
  tag: Tag;
}

export interface TransactionGroup {
  id: string;
  primaryExpenseId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id: string;
  amount: string;
  description: string;
  vendor: string;
  date: string;
  notes: string | null;
  categoryId: string | null;
  accountId: string;
  isReimbursementExpected: boolean;
  reimbursementNote: string | null;
  ignoreInBudget: boolean;
  transactionGroupId: string | null;
  parentExpenseId: string | null;
  category: Category | null;
  account: Account;
  tags: ExpenseTag[];
  transactionGroup: TransactionGroup | null;
  offsets?: Expense[];
  recurrenceRuleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Income {
  id: string;
  amount: string;
  categoryId: string | null;
  category: Category | null;
  source: string | null;
  date: string;
  notes: string | null;
  accountId: string;
  transactionGroupId: string | null;
  account: Account;
  tags: IncomeTag[];
  transactionGroup: TransactionGroup | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringHistoryMonth {
  month: string;    // "Jan" … "Dec"
  thisYear: number;
  lastYear: number;
}

export interface UpcomingExpenseItem {
  id: string;
  date: string;
  amount: string;
  vendor: string;
  description: string;
}

export interface RecurrenceRule {
  id: string;
  description: string;
  amount: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  startDate: string;
  endDate: string | null;
  nextOccurrence: string;
  // Earliest already-generated pending expense date. Present on active rules only.
  // Prefer this over nextOccurrence for display — nextOccurrence is advanced past
  // the generation window and would skip already-generated upcoming instances.
  nextExpenseDate?: string | null;
  categoryId: string;
  accountId: string;
  isActive: boolean;
}

// ── Budget types ──────────────────────────────────────────────────────────────

export interface MonthlyBudgetEntry {
  month: number;
  amount: number;
  isOverride: boolean;
}

export interface ChartDay {
  day: number;
  cumulative: number;
}

export interface BudgetChart {
  current: ChartDay[];
  previous: ChartDay[];
  priorYear: ChartDay[];
}

/** Metrics and display values for a single budget panel (Personal, Joint, or Total). */
export interface BudgetPanel {
  annualBudget: number | null;       // null for Total (always derived)
  effectiveAnnualBudget: number;     // sum of effective monthly amounts
  monthlyBudgets?: MonthlyBudgetEntry[]; // resolved monthly amounts (not on Total)
  ytdCompletedMonths: number;        // actual spend in months before current
  mtdTotal: number;                  // actual spend in current month incl. pending
  normalizedYTD: number;             // timing-adjusted figure for run-rate
  projectedAnnual: number;           // expected full-year spend
  remaining: number;                 // effectiveAnnual - projectedAnnual (can be negative)
  percentAboveBelow: number;         // run-rate ratio minus 1 (e.g. 0.032 = 3.2% over)
  chart: BudgetChart;
}

export interface CategoryOutlier {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  currentAmount: number;
  previousAmount: number;
  delta: number; // positive = more spending this month, negative = less
}

export interface CategoryOutliersData {
  outliers: CategoryOutlier[];
  currentMonthLabel: string;
  previousMonthLabel: string;
  comparisonNote: string;
  /** 20% of effective monthly total budget. Null if no budget is set — chart falls back to max value. */
  scaleCap: number | null;
}

/** Full budget overview response for a given year. */
export interface BudgetOverview {
  year: number;
  daysElapsed: number;
  daysInYear: number;
  pctElapsed: number;
  completedMonths: number;           // calendar months fully elapsed within the year
  settings: { jointSplitRatio: number };
  personal: BudgetPanel;
  joint: BudgetPanel;
  total: BudgetPanel;
}

// ── Investment types ──────────────────────────────────────────────────────────

export interface InvestmentLot {
  id: string;
  holdingId: string;
  quantity: string;
  costPerShare: string;
  acquiredDate: string;
}

export interface InvestmentHolding {
  id: string;
  accountId: string;
  ticker: string;
  name: string;
  type: string | null;
  currentPrice: number | null;
  priceDate: string | null;
  priceUpdatedAt: string | null;
  lots: InvestmentLot[];
  // computed
  totalQuantity: number;
  totalCost: number;
  marketValue: number | null;
  totalGain: number | null;
  totalGainPct: number | null;
  shortTermGain: number;
  longTermGain: number;
  lotCount?: number;
}

export interface InvestmentAccountSummary {
  id: string;
  name: string;
  type: "CHECKING" | "SAVINGS" | "CREDIT_CARD" | "INVESTMENT";
  balance: string;
  color: string | null;
  isJoint: boolean;
  holdings: InvestmentHolding[];
  manualCount: number;
  totalMarketValue: number;
  totalCost: number;
  totalGain: number;
  totalGainPct: number;
}

export interface ManualInvestment {
  id: string;
  accountId: string;
  name: string;
  totalCost: number | null;
  marketValue: number;
}

export interface TickerSearchResult {
  ticker: string;
  name: string;
  type: string; // "Equity", "ETF", "Mutual Fund"
  exchange: string;
}

// Legacy — kept for backwards compatibility during transition
export interface Budget {
  id: string;
  amount: string;
  month: number;
  year: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CategorySpending {
  categoryId: string;
  name: string;
  shortName: string;
  color: string;
  amount: string;
}

export interface MonthlyTrend {
  month: number;
  year: number;
  label: string;
  spent: string | number;
  budget: string | number | null;
}

export interface DashboardData {
  currentMonth: { month: number; year: number };
  totalSpent: string | number;
  transactionCount: number;
  budget: string | number | null;
  spendingByCategory: CategorySpending[];
  monthlyTrend: MonthlyTrend[];
  recentTransactions: Expense[];
  upcomingRecurring: RecurrenceRule[];
}

export interface CategoryTrendSeries {
  categoryId: string;
  name: string;
  color: string;
  hasChildren: boolean;
  values: number[];
}

export interface CategoryTrendData {
  months: string[];
  series: CategoryTrendSeries[];
}

export interface BudgetDetail {
  budget: Budget | null;
  totalSpent: string | number;
  categoryBreakdown: {
    categoryId: string;
    categoryName: string;
    parentCategoryName: string | null;
    color: string;
    total: string;
    count: number;
  }[];
}
