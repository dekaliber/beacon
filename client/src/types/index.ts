export type DividendElection = "REINVEST" | "CASH";
export type TaxAdvantageType = "TRADITIONAL" | "ROTH" | "HSA" | "PLAN_529";

export interface Account {
  id: string;
  name: string;
  type: "CHECKING" | "SAVINGS" | "CREDIT_CARD" | "INVESTMENT";
  balance: string;
  currency: string;
  color: string | null;
  isJoint: boolean;
  isManaged: boolean;
  isTaxAdvantaged: boolean;
  taxAdvantageType: TaxAdvantageType | null;
  isActive: boolean;
  isHidden: boolean;
  // Balance tracking
  balanceUpdatedAt: string | null;
  // Settlement cash (investment accounts only)
  cashBalance: string | null;
  cashBalanceUpdatedAt: string | null;
  // Credit card settings
  closingDay: number | null;
  dueDay: number | null;
  linkedBankAccountId: string | null;
  // Investment dividend settings
  dividendElection: DividendElection | null;
  defaultCashAccountId: string | null;
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
  group: string | null;
  personalTotal: number;
  jointTotal: number;
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

export type IncomeSubtype = "REGULAR" | "DIVIDEND" | "CAPITAL_GAIN" | "RETURN_OF_CAPITAL";
export type TaxClassification = "QUALIFIED" | "ORDINARY" | "TAX_EXEMPT" | "RETURN_OF_CAPITAL" | "CAPITAL_GAIN";
export type PendingDividendStatus = "PENDING" | "CONFIRMED" | "DISMISSED";
export type InvestmentActivityType = "DIVIDEND" | "SALE" | "PURCHASE";

export interface InvestmentActivity {
  id: string;
  accountId: string;
  holdingId: string | null;
  lotId: string | null;
  ticker: string;
  type: InvestmentActivityType;
  date: string;
  shares: number | null;
  pricePerShare: number | null;
  amount: number;
  fees: number | null;
  costBasis: number | null;
  shortTermGain: number | null;
  longTermGain: number | null;
  notes: string | null;
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
  subtype: IncomeSubtype;
  taxClassification: TaxClassification | null;
  taxableAmount: string | null;
  isCashReceived: boolean;
  activityId: string | null;
  account: Account;
  tags: IncomeTag[];
  transactionGroup: TransactionGroup | null;
  activity?: InvestmentActivity | null;
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
  group: string | null;
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
  remaining: number;                 // budget - recurring annual costs - discretionary spent (can be negative)
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

// ── Monthly spending heatmap types ───────────────────────────────────────────

export interface MonthlySpendingDay {
  id: string;
  vendor: string;
  amount: number;
  isJoint: boolean;
  parentExpenseId: string | null;
  transactionGroupId: string | null;
}

export interface MonthlySpendingMonth {
  month: number;
  days: Record<number, MonthlySpendingDay[]>;
  personalTotal: number;
  jointTotal: number;
  combinedTotal: number;
  personalBudget: number;
  jointBudget: number;
  combinedBudget: number;
}

export interface MonthlySpendingResponse {
  year: number;
  splitRatio: number;
  months: MonthlySpendingMonth[];
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
  // Null for managed/robo-advisor holdings where acquisition date is unavailable
  acquiredDate: string | null;
}

export interface InvestmentHolding {
  id: string;
  accountId: string;
  ticker: string;
  name: string;
  type: string | null;
  /** Optional grouping label e.g. "US Stocks", "Commodities" */
  group: string | null;
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
  /** True when all lots have no acquiredDate (robo-advisor / managed account) */
  isManaged: boolean;
  lotCount?: number;
}

export interface RealizedGainSnapshot {
  id: string;
  accountId: string;
  year: number;
  longTermGain: number | null;
  shortTermGain: number | null;
  longTermLoss: number | null;
  shortTermLoss: number | null;
  snapshotDate: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestmentAccountSummary {
  id: string;
  name: string;
  type: "CHECKING" | "SAVINGS" | "CREDIT_CARD" | "INVESTMENT";
  balance: string;
  balanceUpdatedAt: string | null;
  color: string | null;
  isJoint: boolean;
  holdings: InvestmentHolding[];
  manualCount: number;
  totalMarketValue: number;
  totalCost: number;
  totalGain: number;
  totalGainPct: number;
  totalDayGain: number | null;
  totalDayGainPct: number | null;
  cashBalance: number | null;
  cashBalanceUpdatedAt: string | null;
  isTaxAdvantaged: boolean;
  taxAdvantageType: TaxAdvantageType | null;
  // Composition helpers: cash-classified holding value and untracked (no instrument weights) value
  classifiedCashValue: number;
  untrackedValue: number;
}

export interface GrowthEvent {
  type: "BUY" | "SELL";
  ticker: string;
  shares: number;
  pricePerShare: number | null;
  netAmount: number;
}

export interface GrowthPoint {
  date: string;
  marketValue: number;
  costBasis: number;
  unrealizedGain: number;
  unrealizedGainPct: number;
  events?: GrowthEvent[];
}

export interface PendingDividend {
  id: string;
  holdingId: string;
  accountId: string;
  ticker: string;
  /** Ex-date in ISO date string format */
  exDate: string;
  /** Estimated payment date: ex-date + 4 calendar days (tentative, Tiingo doesn't provide this) */
  paymentDate: string | null;
  perShareAmount: string;
  sharesAtExDate: string;
  estimatedTotal: string;
  status: PendingDividendStatus;
  dismissedAt: string | null;
  confirmedAt: string | null;
  activityId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Most recently used taxClassification for this ticker, if any */
  lastTaxClassification: TaxClassification | null;
}

export interface ManualInvestment {
  id: string;
  accountId: string;
  name: string;
  group: string | null;
  totalCost: number | null;
  marketValue: number;
}

export interface TickerSearchResult {
  ticker: string;
  name: string;
  type: string; // "Equity", "ETF", "Mutual Fund"
  exchange: string;
}

// ── Asset allocation types ────────────────────────────────────────────────────

export interface AssetClassTarget {
  id: string;
  assetClassId: string;
  targetPct: string; // Decimal serialized as string
}

export interface AssetClass {
  id: string;
  name: string;
  slug: string | null;
  isSystem: boolean;
  parentId: string | null;
  parent?: { id: string; name: string } | null;
  displayOrder: number;
  color: string | null;
  target: AssetClassTarget | null;
  children?: AssetClass[];
}

export interface AllocationItem {
  id: string;
  name: string;
  color: string | null;
  targetPct: number | null;
  actualPct: number;
  actualValue: number;
}

export interface AllocationSummary {
  items: AllocationItem[];
  topLevelItems: AllocationItem[];
  unclassifiedValue: number;
  unclassifiedPct: number;
  totalValue: number;
  classifiedValue: number;
  hasAnyTargets: boolean;
}

export interface InstrumentWeight {
  id: string;
  instrumentId: string;
  assetClassId: string;
  assetClass: { id: string; name: string; slug: string | null; color: string | null; parentId: string | null };
  weight: string; // Decimal serialized as string
}

export interface InstrumentTicker {
  id: string;
  instrumentId: string;
  ticker: string;
}

export interface InstrumentHoldingRef {
  id: string;
  ticker: string;
  accountId: string;
  account: { id: string; name: string; color: string | null };
}

export interface InstrumentManualRef {
  id: string;
  accountId: string;
  name: string;
  account: { id: string; name: string; color: string | null };
}

export interface Instrument {
  id: string;
  primaryTicker: string;
  name: string | null;
  isManual: boolean;
  tickers: InstrumentTicker[];
  weights: InstrumentWeight[];
  holdings: InstrumentHoldingRef[];
  manualInvestments: InstrumentManualRef[];
  createdAt: string;
  updatedAt: string;
}

// ── Cash flow types ───────────────────────────────────────────────────────────

export type TransferFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface TransferAccountRef {
  id: string;
  name: string;
  color: string | null;
  type: "CHECKING" | "SAVINGS" | "CREDIT_CARD" | "INVESTMENT";
}

export interface TransferRuleRef {
  id: string;
  description: string;
  frequency: TransferFrequency;
  interval: number;
}

export interface TransferRule {
  id: string;
  description: string;
  amount: string;
  frequency: TransferFrequency;
  interval: number;
  startDate: string;
  endDate: string | null;
  nextOccurrence: string;
  fromAccountId: string;
  toAccountId: string;
  fromAccount: TransferAccountRef;
  toAccount: TransferAccountRef;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Transfer {
  id: string;
  description: string;
  amount: string;
  date: string;
  notes: string | null;
  fromAccountId: string;
  toAccountId: string;
  fromAccount: TransferAccountRef;
  toAccount: TransferAccountRef;
  transferRuleId: string | null;
  transferRule: TransferRuleRef | null;
  isConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StatementOverride {
  id: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Withdrawal types ──────────────────────────────────────────────────────────

export type WithdrawalType =
  | "dividend"
  | "interest"
  | "cap_gains_dist"
  | "sale_proceeds"
  | "return_of_capital"
  | "transfer"
  | "reinvestment";

export interface WithdrawalAccountRef {
  id: string;
  name: string;
  color: string | null;
  type: string;
}

export interface WithdrawalEvent {
  id: string;
  date: string;
  type: WithdrawalType;
  description: string;
  account: WithdrawalAccountRef;
  toAccount?: WithdrawalAccountRef;
  amount: string;
  isEditable: boolean;
  incomeId?: string;
  transferId?: string;
}

export interface WithdrawalMonthlySummary {
  month: string; // "YYYY-MM"
  total: number;
}

export interface WithdrawalSummary {
  year: number;
  ytdTotal: number;
  ytdMonths: number;
  monthlySummaries: WithdrawalMonthlySummary[];
}

export interface InvestmentSettings {
  withdrawalRateDenominator: number | null;
  withdrawalRateTarget: number | null;
}

// ── Cash flow projection types ────────────────────────────────────────────────

export type CashFlowEventType =
  | "EXPENSE"
  | "CC_CHARGE"
  | "CC_PAYMENT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "DIVIDEND"
  | "INCOME"
  | "BALANCE_ADJUSTMENT";

export type CashFlowConfidence = "KNOWN" | "PROJECTED";

export interface CashFlowEvent {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: CashFlowEventType;
  confidence: CashFlowConfidence;
  relatedAccountId?: string;
  relatedAccountName?: string;
  periodStart?: string;
  periodEnd?: string;
  /** First day of expenses included in this billing period (day after previous close) */
  statementPeriodStart?: string;
  overrideId?: string;
  adjustmentId?: string;
  /** Present on TRANSFER_IN/TRANSFER_OUT events backed by a real Transfer record so the UI can confirm them */
  transferId?: string;
  runningBalance: number;
}

export interface DailyBalance {
  date: string;
  balance: number;
}

export interface CashFlowProjection {
  accountId: string;
  accountName: string;
  accountType: "CHECKING";
  color: string | null;
  isJoint: boolean;
  startBalance: number;
  endBalance: number;
  minBalance: number;
  events: CashFlowEvent[];
  dailyBalances: DailyBalance[];
}

export interface CashFlowResponse {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  projections: CashFlowProjection[];
}

// ── Notification types ────────────────────────────────────────────────────────

export interface NotificationAccountGroup {
  accountId: string;
  accountName: string;
  count: number;
}

export interface NotificationData {
  pendingDividends: NotificationAccountGroup[];
  totalCount: number;
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
