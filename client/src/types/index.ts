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
  isHidden?: boolean;
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

export interface OrphanedOffset {
  id: string;
  amount: string;
  vendor: string;
  description: string;
  date: string;
  parentExpenseId: string;
  account: { isJoint: boolean };
  parentExpense: { id: string; vendor: string; description: string } | null;
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
export type InvestmentActivityType = "DIVIDEND" | "SALE" | "PURCHASE" | "TRANSFER";

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
  transferAccountId: string | null;
  notes: string | null;
  isCollectible?: boolean; // resolved at query time from the linked Instrument
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
  optionsPositionId: string | null;
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
  mtdActual: number;                 // already-occurred MTD spend (date ≤ today)
  mtdFuture: number;                 // known future MTD spend (date > today, within month)
  normalizedYTD: number;             // timing-adjusted figure for run-rate
  projectedAnnual: number;           // expected full-year spend
  remaining: number;                 // budget - recurring annual costs - discretionary spent (can be negative)
  remainingFull: number;             // budget - total actual spend to date (can be negative)
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
  isRecurring: boolean;
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

export interface MonthlyTotal {
  month: number;
  label: string;        // "Jan" … "Dec"
  personalSpent: number;
  jointSpent: number;   // already scaled by the user's joint split ratio
}

/** Full budget overview response for a given year. */
export interface BudgetOverview {
  year: number;
  daysElapsed: number;
  daysInYear: number;
  pctElapsed: number;
  completedMonths: number;           // calendar months fully elapsed within the year
  monthlyTotals: MonthlyTotal[];
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
  fromOptionsPositionId: string | null;
}

export interface InvestmentHolding {
  id: string;
  accountId: string;
  ticker: string;
  name: string;
  type: string | null;
  /** Optional grouping label e.g. "US Stocks", "Commodities" */
  group: string | null;
  /** CoinGecko coin ID for crypto holdings (e.g. "bitcoin"), null for stocks/funds */
  coinGeckoId?: string | null;
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

export interface RealizedGainSnapshotWithAccount extends RealizedGainSnapshot {
  account: { id: string; name: string; color: string | null };
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
  isManaged: boolean;
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
  // null for managed accounts where cost basis cannot be reliably reconstructed
  costBasis: number | null;
  unrealizedGain: number | null;
  unrealizedGainPct: number | null;
  events?: GrowthEvent[];
}

export interface QfxTransactionInput {
  fitId: string;
  ticker: string;
  type: "BUY" | "SELL" | "REINVEST";
  date: string; // YYYY-MM-DD
  shares: number;
  pricePerShare: number;
  total: number;
}

export interface QfxDividendInput {
  fitId: string;
  ticker: string;
  date: string; // YYYY-MM-DD (actual payment date from QFX)
  total: number;
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

export interface ConfirmedDividendInfo {
  pendingDividendId: string;
  isDrip: boolean;
  paymentDate: string;
  amount: number;
  notes: string | null;
  exDate: string;
  ticker: string;
  perShareAmount: number;
  sharesAtExDate: number;
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
  type: string; // "Equity", "ETF", "Mutual Fund", "Money Market", "Crypto"
  exchange: string;
  /** CoinGecko coin ID — only present for Crypto results (e.g. "bitcoin") */
  coinGeckoId?: string | null;
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
  isCollectible: boolean;
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
  /** Earliest pending unconfirmed transfer date ≥ today. Prefer over nextOccurrence for display. */
  nextTransferDate: string | null;
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

export interface TaxAssumptions {
  filingStatus: "SINGLE" | "MFJ" | "HoH" | "MFS";
  otherOrdinary:   number | null;
  federalWithheld: number | null;
  otherLtcg:       number | null;
  caWithheld:      number | null;
  useTmt:   boolean;
  useCaTmt: boolean;
  quarterlyPayments: {
    quarter:       number;
    federalAmount: number | null;
    caAmount:      number | null;
  }[];
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
  pendingBuys: NotificationAccountGroup[];
  pendingSales: NotificationAccountGroup[];
  totalCount: number;
}

export type PendingBuyStatus = "PENDING" | "CONFIRMED" | "DISMISSED";

export interface PendingBuy {
  id: string;
  userId: string;
  accountId: string;
  optionsPositionId: string;
  ticker: string;
  status: PendingBuyStatus;
  quantity: string;       // Decimal serialized as string
  costPerShare: string;   // Decimal serialized as string
  acquiredDate: string;   // ISO date
  confirmedAt: string | null;
  dismissedAt: string | null;
  lotId: string | null;
  createdAt: string;
  updatedAt: string;
  optionsPosition: {
    id: string;
    ticker: { symbol: string; id: string };
    strikePrice: string;
    contracts: number;
    contractsAssigned: number | null;
    expirationDate: string;
    premiumPerShare: string;
    feesOpen: string | null;
    feesClose: string | null;
    optionType: string;
  };
}

export type PendingSaleStatus = "PENDING" | "CONFIRMED" | "DISMISSED";

export interface PendingSale {
  id: string;
  userId: string;
  accountId: string;
  optionsPositionId: string;
  ticker: string;
  status: PendingSaleStatus;
  quantity: string;       // Decimal serialized as string
  pricePerShare: string;  // Decimal serialized as string (strike + premium − fees/share)
  saleDate: string;       // ISO date
  confirmedAt: string | null;
  dismissedAt: string | null;
  activityId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Lot IDs pre-selected from the assigned CSP batch (empty if no batch linked). */
  suggestedLotIds: string[];
  optionsPosition: {
    id: string;
    ticker: { symbol: string; id: string };
    strikePrice: string;
    contracts: number;
    contractsAssigned: number | null;
    expirationDate: string;
    premiumPerShare: string;
    feesOpen: string | null;
    feesClose: string | null;
    optionType: string;
    assignedFromStrikePrice: string | null;
    assignedFromExpirationDate: string | null; // YYYY-MM-DD
  };
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
  personalSpent?: string | number;
  jointSpent?: string | number;
}

export interface DashboardData {
  currentMonth: { month: number; year: number };
  totalSpent: string | number;
  personalSpent: string | number;
  jointSpent: string | number;
  transactionCount: number;
  budget: string | number | null;
  personalBudget: string | number | null;
  jointBudget: string | number | null;
  prevMonthMtd: number;
  spendingByCategory: CategorySpending[];
  monthlyTrend: MonthlyTrend[];
  recentTransactions: Expense[];
  upcomingRecurring: RecurrenceRule[];
}

export interface CategoryAverage {
  categoryId: string | null;
  categoryName: string;
  color: string;
  currentAmount: number;
  avgAmount: number;
  delta: number;
  deltaPercent: number | null;
  pendingAmount?: number;
}

export interface CategoryAveragesData {
  categories: CategoryAverage[];
  earliestYear: number;
}

export interface SpendingVelocityDay {
  day: number;
  spend: number | null;
  cumulative: number | null;
}

export interface SpendingVelocityData {
  days: SpendingVelocityDay[];
  totalBudget: number | null;
  daysInMonth: number;
  lastKnownDay: number;
}

export interface OutlierCategoryTransaction {
  id: string;
  description: string;
  vendor: string;
  date: string;
  amount: number;
  isJoint: boolean;
  isPending?: boolean;
}

export interface OutlierCategoryGroup {
  categoryId: string | null;
  categoryName: string;
  categoryColor: string;
  currentMonthTotal: number;
  historicalAvgMonthly: number;
  excess: number;
  transactions: OutlierCategoryTransaction[];
}

export interface OutlierTransactionsData {
  categories: OutlierCategoryGroup[];
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

export interface CategoryYearTrendsData {
  years: number[];
  series: {
    categoryId: string;
    name: string;
    color: string;
    avgByYear: number[];
  }[];
}

export interface MtdChartData {
  personal: BudgetChart;
  joint: BudgetChart;
  total: BudgetChart;
  monthlyBudget: { personal: number; joint: number; total: number };
  monthNames: { current: string; previous: string; priorYear: string };
  todayDay: number | null;
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

export interface NetWorthData {
  total: number;
  investments: number;
  investmentCash: number;
  bankingCash: number;
  creditCardDebt: number;
}
