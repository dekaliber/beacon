import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Info, Pencil } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
  Cell,
  LabelList,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Card } from "@/components/Card";
import { SectionLabel } from "@/components/Typography";
import { InfoHint } from "@/components/Tooltip";
import { MonthEndBalancesModal } from "@/components/MonthEndBalancesModal";
import { useApi } from "@/hooks/useApi";
import { getInvestmentPerformance } from "@/api";
import { useDemo } from "@/context/DemoContext";
import { scalePerformance } from "@/lib/demo";
import { cn, localToday } from "@/lib/utils";
import type { PerformanceCadence, PerformanceData, PerformancePeriod } from "@/types";

// ── Portfolio performance ─────────────────────────────────────────────────────
// Total investment value at each week/month-end close since the start of 2026,
// and what moved it: market change per asset class (dividends included), money
// moved in or out, and cash changes the records don't explain ("unreconciled").
//
// Three layers, most to least summarized:
//   1. Total value line.
//   2. Gross vs. net columns: everything that rose, everything that fell, and
//      the net between them, with the period's biggest gainer and loser named.
//   3. For the selected period, a waterfall from open to close through each
//      driver, beside the holdings or transactions behind the clicked driver.

const CADENCES: { value: PerformanceCadence; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

// Classes wear the color saved on the asset class, as on the Asset Allocation
// card, so a class reads the same everywhere on the page. These tokens only
// stand in for a class with no saved color. Untracked is neutral, being "not
// classified" rather than a class of its own.
const CLASS_TOKENS = [
  "var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)",
  "var(--color-chart-4)", "var(--color-chart-7)", "var(--color-chart-6)",
  "var(--color-chart-9)", "var(--color-chart-10)", "var(--color-chart-5)",
];
const UNTRACKED_KEY = "untracked";
const UNTRACKED_COLOR = "var(--color-ink-4)";
const DEPOSITS_KEY = "__deposits";
const WITHDRAWALS_KEY = "__withdrawals";
// Dark slate: the one neutral that stays clear of every saved class color
// (nearest is Cash's gray) and of Untracked's light gray.
const FLOWS_COLOR = "var(--color-ink-2)";
const UNRECONCILED_KEY = "__unreconciled";
const UNRECONCILED_COLOR = "var(--color-ink-3)";
// Advisory and account fees: a cost against the return, kept apart from the
// asset classes (whose returns stay pure market numbers) and from the flows.
const FEES_KEY = "__fees";
// A muted brick: clear of the saved class colors, the slate flows, and the
// grays Untracked, Unreconciled, and Other already use.
const FEES_COLOR = "color-mix(in oklab, var(--color-down) 45%, var(--color-ink-3))";
// Options premium earned in a brokerage but not yet transferred to a bank: kept
// out of the return and the flows, so it gets its own neutral step.
const PREMIUM_KEY = "__options_premium";
const PREMIUM_COLOR = "color-mix(in oklab, var(--color-teal-deep) 45%, var(--color-ink-3))";
const OTHER_KEY = "__other";
const OTHER_COLOR = "color-mix(in oklab, var(--color-ink-5) 70%, transparent)";
const HATCH_ID = "perf-unreconciled-hatch";
const STRIPES = "repeating-linear-gradient(45deg, var(--color-ink-3) 0 1.5px, var(--color-ink-5) 1.5px 4px)";

// Drivers below this share of a period's total movement (the sum of every
// driver's size, up or down) fold into one "Other" step.
const MINOR_SHARE = 0.03;

/** One thing that moved a period's value: an asset class, deposits,
 *  withdrawals, unreconciled cash, or the "Other" group of small ones. */
type Driver = {
  key: string;
  name: string;
  color: string;
  amount: number;
  marketChange?: number;
  income?: number;
  members?: Driver[];
};

type Palette = Map<string, { name: string; color: string }>;

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money = (n: number) => usd0.format(Math.round(n) === 0 ? 0 : n);
const signed = (n: number) => (Math.round(n) === 0 ? "$0" : `${n > 0 ? "+" : "−"}${usd0.format(Math.abs(n))}`);
// To the cent, for the YTD figures that should tie out to statements and the Withdrawals page
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedCents = (n: number) => (Math.abs(n) < 0.005 ? "$0.00" : `${n > 0 ? "+" : "−"}${usd2.format(Math.abs(n))}`);
const toneOf = (n: number) => (Math.round(n) === 0 ? "text-muted-foreground" : n > 0 ? "text-up" : "text-down");
const fillOf = (n: number) => (n >= 0 ? "var(--color-up)" : "var(--color-down)");

function compact(v: number): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}

/** Chart-label money: $4.27M, $338k, $5.9k, $500. One decimal under $10k so
 *  small drivers don't all round to the same "$6k". */
function short(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`;
  if (a >= 9999.5) return `$${Math.round(a / 1e3)}k`;
  if (a >= 999.5) return `$${(a / 1e3).toFixed(1)}k`;
  return `$${Math.round(a)}`;
}
const signedShort = (n: number) => (Math.round(n) === 0 ? "$0" : `${n > 0 ? "+" : "−"}${short(n)}`);

/** Evenly spaced axis ticks at a round step (1, 2.5 or 5 × 10ⁿ) covering
 *  [min, max] in about `target` intervals. 2.5 rather than 2 keeps a ~$1M
 *  range to five lines ($250k apart) instead of six. */
function niceTicks(min: number, max: number, target = 5): { ticks: number[]; step: number } {
  const raw = (max - min) / target || Math.abs(max) / target || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, step };
}

/** Money axis label with the decimals the step needs, so every tick reads the
 *  same: $4.00M / $4.25M at a $250k step, $4.5M / $5.0M at $500k, $850k at $50k. */
function axisMoney(v: number, step: number): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  const unit = a >= 1e6 ? 1e6 : a >= 1e3 ? 1e3 : 1;
  const suffix = unit === 1e6 ? "M" : unit === 1e3 ? "k" : "";
  let decimals = 0;
  while (decimals < 2 && Math.abs(Math.round((step / unit) * 10 ** decimals) - (step / unit) * 10 ** decimals) > 1e-9) decimals++;
  // A whole-million step still reads better as $4.0M than $4M beside other $…M axes
  if (unit === 1e6 && decimals === 0) decimals = 1;
  return `${sign}$${(a / unit).toFixed(unit === 1 ? 0 : decimals)}${suffix}`;
}

/** Grid lines at exactly the given ticks: left to itself the grid picks its
 *  own tick count, leaving labels with no line beside them. */
const gridAt = (ticks: number[]) => ({ offset }: { offset: { top?: number; height?: number } }) => {
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const top = offset.top ?? 0;
  const h = offset.height ?? 0;
  return ticks.map((v) => top + ((hi - v) / (hi - lo || 1)) * h);
};

/** "YYYY-MM-DD" → e.g. "Oct 30" (or "Oct 30, 2026"); read as a calendar date. */
function fmtDay(day: string, withYear = false): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(withYear && { year: "numeric" }), timeZone: "UTC",
  });
}
/** "YYYY-MM-DD" → "10/30". */
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const monthShort = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

function periodTitle(p: PerformancePeriod, cadence: PerformanceCadence): string {
  if (cadence === "monthly") {
    const month = new Date(`${p.end}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return p.partial ? `${month} to date` : month;
  }
  return p.partial ? `Week to date, ${fmtDay(p.end)}` : `Week ending ${fmtDay(p.end, true)}`;
}

/** Shorter class names for chart labels, where a column is ~80px wide. */
const chartName = (name: string) => name.replace(/\bInternational\b/g, "Intl");

// ── Drivers ───────────────────────────────────────────────────────────────────

/** Every driver that moved the period by at least a dollar, unsorted. */
function periodDrivers(p: PerformancePeriod, palette: Palette): Driver[] {
  const out: Driver[] = [];
  for (const c of p.classes) {
    const amount = c.marketChange + c.income;
    if (Math.round(amount) === 0) continue;
    const info = palette.get(c.key);
    out.push({
      key: c.key,
      name: info?.name ?? (c.key === UNTRACKED_KEY ? "Untracked" : c.key),
      color: info?.color ?? UNTRACKED_COLOR,
      amount,
      marketChange: c.marketChange,
      income: c.income,
    });
  }
  if (Math.round(p.deposits) !== 0) out.push({ key: DEPOSITS_KEY, name: "Deposits", color: FLOWS_COLOR, amount: p.deposits });
  if (Math.round(p.withdrawals) !== 0) out.push({ key: WITHDRAWALS_KEY, name: "Withdrawals", color: FLOWS_COLOR, amount: -p.withdrawals });
  if (Math.round(p.fees) !== 0) out.push({ key: FEES_KEY, name: "Fees", color: FEES_COLOR, amount: -p.fees });
  if (Math.round(p.optionsPremiumHeld) !== 0) {
    out.push({ key: PREMIUM_KEY, name: "Options premium not yet transferred", color: PREMIUM_COLOR, amount: p.optionsPremiumHeld });
  }
  if (Math.round(p.unreconciled) !== 0) {
    out.push({ key: UNRECONCILED_KEY, name: "Unreconciled cash", color: UNRECONCILED_COLOR, amount: p.unreconciled });
  }
  return out;
}

/** Gains largest first, then losses largest first, with the small ones folded
 *  into a trailing "Other". A lone small driver keeps its own step: an
 *  "Other (1)" would only hide its name. */
function groupMinor(drivers: Driver[]): Driver[] {
  const total = drivers.reduce((s, d) => s + Math.abs(d.amount), 0);
  const minor = drivers.filter((d) => Math.abs(d.amount) < total * MINOR_SHARE);
  const grouped = minor.length >= 2;
  const major = grouped ? drivers.filter((d) => !minor.includes(d)) : drivers;
  const out = [
    ...major.filter((d) => d.amount > 0).sort((a, b) => b.amount - a.amount),
    ...major.filter((d) => d.amount < 0).sort((a, b) => a.amount - b.amount),
  ];
  if (grouped) {
    out.push({
      key: OTHER_KEY,
      name: `Other (${minor.length})`,
      color: OTHER_COLOR,
      amount: minor.reduce((s, d) => s + d.amount, 0),
      members: [...minor].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    });
  }
  return out;
}

function Swatch({ driver, size = "h-2.5 w-2.5" }: { driver: Driver; size?: string }) {
  return (
    <span
      className={cn("inline-block shrink-0 rounded-sm", size)}
      style={driver.key === UNRECONCILED_KEY ? { backgroundImage: STRIPES } : { backgroundColor: driver.color }}
    />
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function PortfolioPerformanceCard() {
  const [cadence, setCadence] = useState<PerformanceCadence>("monthly");
  const [selectedEnd, setSelectedEnd] = useState<string | null>(null);
  const { data: raw, loading, refetch } = useApi(() => getInvestmentPerformance(cadence), [cadence]);
  const { isDemoMode, demoFactor } = useDemo();
  const data = useMemo(
    () => (raw && isDemoMode ? scalePerformance(raw, demoFactor) : raw),
    [raw, isDemoMode, demoFactor],
  );

  const cadenceButtons = (
    <div className="flex gap-1">
      {CADENCES.map((c) => (
        <button
          key={c.value}
          onClick={() => {
            setCadence(c.value);
            setSelectedEnd(null);
          }}
          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
            c.value === cadence
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );

  // Header sits outside the cards, like Asset Allocation's
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between py-1">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <SectionLabel as="span">Performance</SectionLabel>
        </div>
        {cadenceButtons}
      </div>
      {!data || data.cadence !== cadence ? (
        <Card className="p-6">
          <p className="tp-caption py-16 text-center">{loading ? "Rebuilding history…" : "No history yet."}</p>
        </Card>
      ) : data.periods.length === 0 ? (
        <Card className="p-6">
          <p className="tp-caption py-16 text-center">No history yet.</p>
        </Card>
      ) : (
        <PerformanceBody
          data={data}
          // The latest period by default, even when it is still in progress.
          selectedEnd={selectedEnd ?? data.periods[data.periods.length - 1].end}
          onSelect={setSelectedEnd}
          onBalancesSaved={refetch}
        />
      )}
    </div>
  );
}

type Row = {
  end: string;
  label: string;
  value: number;
  period: PerformancePeriod | null;
  gains: number | null;
  losses: number | null;
  net: number | null;
  topGain: Driver | null;
  topLoss: Driver | null;
  all: Driver[];
  drivers: Driver[];
};

function PerformanceBody({
  data,
  selectedEnd,
  onSelect,
  onBalancesSaved,
}: {
  data: PerformanceData;
  selectedEnd: string;
  onSelect: (end: string) => void;
  onBalancesSaved: () => void;
}) {
  const { periods, cadence } = data;
  const monthly = cadence === "monthly";
  const last = periods[periods.length - 1];
  const totalChange = last.endValue - data.baselineValue;
  const totals = periods.reduce(
    (t, p) => ({
      // Net of fees: what the investments earned after the cost of managing them
      market: t.market + p.classes.reduce((s, c) => s + c.marketChange + c.income, 0) - p.fees,
      flows: t.flows + p.deposits - p.withdrawals,
      unreconciled: t.unreconciled + p.unreconciled,
    }),
    { market: 0, flows: 0, unreconciled: 0 },
  );

  // Colors are bound to the class, not its position in any one period.
  const palette = useMemo<Palette>(() => {
    const m: Palette = new Map();
    let slot = 0;
    for (const c of data.classes) {
      const color = c.key === UNTRACKED_KEY ? UNTRACKED_COLOR : c.color ?? CLASS_TOKENS[slot++ % CLASS_TOKENS.length];
      m.set(c.key, { name: c.name, color });
    }
    return m;
  }, [data.classes]);

  const rows = useMemo<Row[]>(() => {
    const label = (end: string) => (!monthly ? md(end) : end !== data.baseline ? monthShort(end) : fmtDay(end));
    return [
      // The opening close: a point on the value line, an empty column below.
      {
        end: data.baseline, label: label(data.baseline), value: data.baselineValue, period: null,
        gains: null, losses: null, net: null, topGain: null, topLoss: null, all: [], drivers: [],
      },
      ...periods.map((p): Row => {
        const all = periodDrivers(p, palette);
        const ups = all.filter((d) => d.amount > 0);
        const downs = all.filter((d) => d.amount < 0);
        return {
          end: p.end,
          label: label(p.end),
          value: p.endValue,
          period: p,
          gains: ups.reduce((s, d) => s + d.amount, 0),
          losses: downs.reduce((s, d) => s + d.amount, 0),
          net: p.endValue - p.startValue,
          topGain: ups.reduce<Driver | null>((best, d) => (!best || d.amount > best.amount ? d : best), null),
          topLoss: downs.reduce<Driver | null>((worst, d) => (!worst || d.amount < worst.amount ? d : worst), null),
          all,
          drivers: groupMinor(all),
        };
      }),
    ];
  }, [periods, palette, monthly, data.baseline, data.baselineValue]);
  const rowByEnd = useMemo(() => new Map(rows.map((r) => [r.end, r])), [rows]);

  const values = rows.map((r) => r.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const vPad = Math.max((vMax - vMin) * 0.08, vMax * 0.005);
  const valueAxis = niceTicks(vMin - vPad, vMax + vPad);

  // Room above the tallest gains column and below the deepest losses column
  // for the driver labels, which only the monthly view has space for.
  const gMax = Math.max(0, ...rows.map((r) => r.gains ?? 0));
  const gMin = Math.min(0, ...rows.map((r) => r.losses ?? 0));
  const gPad = (gMax - gMin) * (monthly ? 0.24 : 0.04);
  const grossAxis = niceTicks(gMin - (gMin < 0 ? gPad : 0), gMax + (gMax > 0 ? gPad : 0));

  const selected = periods.find((p) => p.end === selectedEnd) ?? last;
  const selectedRow = rowByEnd.get(selected.end)!;

  const yAxisProps = {
    axisLine: false,
    tickLine: false,
    width: 64,
    tick: { fontSize: 11, fill: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)" },
    tickFormatter: compact,
  } as const;
  const margin = { top: 8, right: 8, left: 0, bottom: 0 };

  type ChartState = { activeTooltipIndex?: number | string | null } | null;
  const endAt = (state: ChartState): string | null => {
    const i = Number(state?.activeTooltipIndex);
    return Number.isInteger(i) && rows[i] ? rows[i].end : null;
  };
  const handleClick = (state: ChartState) => {
    const end = endAt(state);
    if (end && end !== data.baseline) onSelect(end);
  };
  // Recharts places the line chart's hover position at its column's left edge
  // rather than its center, which threw off both its own cursor and the bars'
  // synced highlight. So both cursors are drawn here from the hovered period:
  // a line through the column's center above, the column's band below.
  const [hoverEnd, setHoverEnd] = useState<string | null>(null);
  const handleMove = (state: ChartState) => {
    const end = endAt(state);
    if (end !== hoverEnd) setHoverEnd(end);
  };
  const handleLeave = () => setHoverEnd(null);

  // Driver names on the columns: the biggest gainer above, the biggest loser below.
  type LabelProps = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown };
  const geometry = (props: LabelProps) => {
    const x = Number(props.x), y = Number(props.y), w = Number(props.width), h = Number(props.height);
    return { cx: x + w / 2, top: Math.min(y, y + h), bottom: Math.max(y, y + h) };
  };
  const gainLabel = (props: LabelProps) => {
    const d = rowByEnd.get(String(props.value))?.topGain;
    if (!d) return null;
    const { cx, top } = geometry(props);
    return (
      <g style={{ pointerEvents: "none" }}>
        <text x={cx} y={top - 16} textAnchor="middle" fontSize={10} fill="var(--color-muted-foreground)">{chartName(d.name)}</text>
        <text x={cx} y={top - 4} textAnchor="middle" fontSize={11} fontWeight={500} fill="var(--color-up)">{signedShort(d.amount)}</text>
      </g>
    );
  };
  const lossLabel = (props: LabelProps) => {
    const d = rowByEnd.get(String(props.value))?.topLoss;
    if (!d) return null;
    const { cx, bottom } = geometry(props);
    return (
      <g style={{ pointerEvents: "none" }}>
        <text x={cx} y={bottom + 12} textAnchor="middle" fontSize={11} fontWeight={500} fill="var(--color-down)">{signedShort(d.amount)}</text>
        <text x={cx} y={bottom + 24} textAnchor="middle" fontSize={10} fill="var(--color-muted-foreground)">{chartName(d.name)}</text>
      </g>
    );
  };
  // Monthly ticks carry the month's net beneath its name, so no column needs a hover.
  const monthTick = ({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value?: unknown } }) => {
    const row = rowByEnd.get(String(payload?.value));
    if (!row) return <g />;
    const on = row.end === selected.end;
    return (
      <g transform={`translate(${Number(x)},${Number(y)})`}>
        <text dy={10} textAnchor="middle" fontSize={11} fontWeight={on ? 600 : 400} fill={on ? "var(--color-foreground)" : "var(--color-muted-foreground)"}>
          {row.label}
        </text>
        {row.net != null && (
          <text dy={24} textAnchor="middle" fontSize={11} fontWeight={500} fill={Math.round(row.net) === 0 ? "var(--color-muted-foreground)" : fillOf(row.net)}>
            {signedShort(row.net)}
          </text>
        )}
      </g>
    );
  };

  return (
    <div className="space-y-4">
      {/* Year-to-date figures, one card each like the Options page's stat row */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Change", caption: "YTD", value: totalChange },
          { label: "Investment Return", caption: "YTD, net of fees", value: totals.market },
          { label: "Deposits/Withdrawals", caption: "YTD", value: totals.flows },
          { label: "Unreconciled Cash", caption: "YTD", value: totals.unreconciled },
        ].map((s) => (
          <Card key={s.label} className="p-6">
            <SectionLabel as="span">{s.label}</SectionLabel>
            <div className="mt-1 min-w-0">
              <p className={cn("tp-stat truncate", toneOf(s.value))}>{signedCents(s.value)}</p>
              <p className="tp-caption mt-0.5 truncate">{s.caption}</p>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6">
        {/* Top: total value at each close. z-10 keeps its tooltip above the bars.
            The x-axis is a band axis like the bars' below, so each point sits at the
            center of its period's column instead of the line running edge to edge. */}
        <div className="relative z-10">
          <p className="tp-caption pl-16 mb-1">Total value</p>
          <ResponsiveContainer width="100%" height={150}>
            {/* Bottom room so the lowest tick's label fits; Recharts drops a label that would spill out */}
            <ComposedChart
              data={rows}
              margin={{ ...margin, bottom: 8 }}
              syncId="portfolio-performance"
              onClick={handleClick}
              onMouseMove={handleMove}
              onMouseLeave={handleLeave}
            >
              <defs>
                <linearGradient id="perf-value-wash" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.12} />
                  <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-chart-grid)" vertical={false} horizontalCoordinatesGenerator={gridAt(valueAxis.ticks)} />
              <XAxis dataKey="end" hide scale="band" />
              <YAxis
                {...yAxisProps}
                domain={[valueAxis.ticks[0], valueAxis.ticks[valueAxis.ticks.length - 1]]}
                ticks={valueAxis.ticks}
                tickFormatter={(v: number) => axisMoney(v, valueAxis.step)}
                interval={0}
                allowDataOverflow
              />
              <ReferenceLine x={selected.end} stroke="var(--color-chart-cursor)" strokeWidth={1} />
              {hoverEnd && hoverEnd !== selected.end && (
                <ReferenceLine x={hoverEnd} stroke="var(--color-chart-cursor)" strokeWidth={1} />
              )}
              <RechartsTooltip content={<ValueTooltip />} cursor={false} />
              <Area
                type="linear"
                dataKey="value"
                stroke="var(--color-chart-1)"
                strokeWidth={2}
                fill="url(#perf-value-wash)"
                dot={false}
                activeDot={{ r: 4, fill: "var(--color-chart-1)", stroke: "var(--color-background)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Middle: each period's gross gains and losses as light columns, with the
            net between them as a solid bar on its own (hidden) axis so it overlays
            the same column. Click a column to break it down below. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 mt-4 mb-1">
          <p className="tp-caption">Change each {monthly ? "month" : "week"}</p>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-up-soft" />All gains
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-down-soft" />All losses
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-flex h-2.5 w-2.5 overflow-hidden rounded-sm">
              <span className="w-1/2 bg-up" />
              <span className="w-1/2 bg-down" />
            </span>
            Net change
          </span>
        </div>
        <ResponsiveContainer width="100%" height={monthly ? 250 : 200}>
          <ComposedChart
            data={rows}
            margin={margin}
            syncId="portfolio-performance"
            stackOffset="sign"
            onClick={handleClick}
            onMouseMove={handleMove}
            onMouseLeave={handleLeave}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid stroke="var(--color-chart-grid)" vertical={false} horizontalCoordinatesGenerator={gridAt(grossAxis.ticks)} />
            {monthly ? (
              <XAxis dataKey="end" tick={monthTick} axisLine={false} tickLine={false} interval={0} height={34} />
            ) : (
              <XAxis
                dataKey="end"
                tickFormatter={(end: string) => rowByEnd.get(end)?.label ?? ""}
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
              />
            )}
            <XAxis xAxisId="net" dataKey="end" hide />
            <YAxis
              {...yAxisProps}
              domain={[grossAxis.ticks[0], grossAxis.ticks[grossAxis.ticks.length - 1]]}
              ticks={grossAxis.ticks}
              tickFormatter={(v: number) => axisMoney(v, grossAxis.step)}
              interval={0}
              allowDataOverflow
            />
            <ReferenceArea x1={selected.end} x2={selected.end} fill="var(--color-primary)" fillOpacity={0.07} strokeWidth={0} />
            {hoverEnd && hoverEnd !== data.baseline && hoverEnd !== selected.end && (
              <ReferenceArea x1={hoverEnd} x2={hoverEnd} fill="var(--color-muted)" fillOpacity={1} strokeWidth={0} />
            )}
            <ReferenceLine y={0} stroke="var(--color-chart-axis)" strokeWidth={1} />
            <RechartsTooltip content={<GrossTooltip cadence={cadence} />} cursor={false} />
            <Bar dataKey="gains" stackId="gross" fill="var(--color-up-soft)" maxBarSize={44} radius={2} isAnimationActive={false}>
              {monthly && <LabelList dataKey="end" content={gainLabel} />}
            </Bar>
            <Bar dataKey="losses" stackId="gross" fill="var(--color-down-soft)" maxBarSize={44} radius={2} isAnimationActive={false}>
              {monthly && <LabelList dataKey="end" content={lossLabel} />}
            </Bar>
            <Bar dataKey="net" xAxisId="net" maxBarSize={monthly ? 12 : 6} isAnimationActive={false}>
              {rows.map((r) => <Cell key={r.end} fill={fillOf(r.net ?? 0)} />)}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>

        <PeriodDetail period={selected} drivers={selectedRow.drivers} cadence={cadence} onBalancesSaved={onBalancesSaved} />
        <DataNotes data={data} />
      </Card>
    </div>
  );
}

// ── Tooltips ──────────────────────────────────────────────────────────────────

function ValueTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as { end: string; value: number; period: PerformancePeriod | null };
  const change = row.period ? row.period.endValue - row.period.startValue : null;
  return (
    <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-foreground">{fmtDay(row.end, true)} close</p>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Total value</span>
        <span className="font-medium tabular-nums">{money(row.value)}</span>
      </div>
      {change != null && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Change</span>
          <span className={cn("tabular-nums", toneOf(change))}>{signed(change)}</span>
        </div>
      )}
    </div>
  );
}

/** One side of a period's change: its drivers largest first, the small ones
 *  (by the same share as the waterfall's "Other") folded into an "Other" line. */
function side(all: Driver[], sign: 1 | -1): Driver[] {
  const total = all.reduce((s, d) => s + Math.abs(d.amount), 0);
  const ds = all.filter((d) => d.amount * sign > 0);
  const minor = ds.filter((d) => Math.abs(d.amount) < total * MINOR_SHARE);
  const grouped = minor.length >= 2;
  const out = (grouped ? ds.filter((d) => !minor.includes(d)) : ds).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  if (grouped) {
    out.push({ key: OTHER_KEY, name: `Other (${minor.length})`, color: OTHER_COLOR, amount: minor.reduce((s, d) => s + d.amount, 0) });
  }
  return out;
}

function TooltipSection({ title, drivers, total }: { title: string; drivers: Driver[]; total: number }) {
  return (
    <div className="space-y-1">
      {drivers.map((d) => (
        <div key={d.key} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Swatch driver={d} size="h-2 w-2" />
            {d.name}
          </span>
          <span className={cn("tabular-nums", toneOf(d.amount))}>{signed(d.amount)}</span>
        </div>
      ))}
      <div className="flex justify-between gap-4 pt-1 border-t border-border text-foreground">
        <span>{title}</span>
        <span className={cn("tabular-nums", toneOf(total))}>{signed(total)}</span>
      </div>
    </div>
  );
}

/** Gains, then losses, each with its total, then the net between them. */
function GrossTooltip({ active, payload, cadence }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as Row;
  const p = row.period;
  if (!p) return null;
  const gains = side(row.all, 1);
  const losses = side(row.all, -1);
  return (
    <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs min-w-[220px]">
      <p className="mb-1.5 font-semibold text-foreground">{periodTitle(p, cadence)}</p>
      <div className="space-y-2.5">
        {gains.length > 0 && <TooltipSection title="Total gains" drivers={gains} total={row.gains ?? 0} />}
        {losses.length > 0 && <TooltipSection title="Total losses" drivers={losses} total={row.losses ?? 0} />}
      </div>
      <div className="mt-2.5 flex justify-between gap-4 border-t border-border pt-1.5 font-medium text-foreground">
        <span>Net change</span>
        <span className={cn("tabular-nums", toneOf(row.net ?? 0))}>{signed(row.net ?? 0)}</span>
      </div>
    </div>
  );
}

// ── Period detail: waterfall + the selected driver's holdings ────────────────

function PeriodDetail({
  period: p,
  drivers,
  cadence,
  onBalancesSaved,
}: {
  period: PerformancePeriod;
  drivers: Driver[];
  cadence: PerformanceCadence;
  onBalancesSaved: () => void;
}) {
  const { isDemoMode } = useDemo();
  const [editingBalances, setEditingBalances] = useState(false);
  // Month-end balances are edited for finished months only: the open month's
  // are set on the account pages. Demo mode scales every value shown, so there's
  // nothing real to edit.
  const balancesEditable = cadence === "monthly" && !isDemoMode && p.end.slice(0, 7) < localToday().slice(0, 7);

  // The pick belongs to one period; a new period opens on its largest driver.
  const [pick, setPick] = useState<{ end: string; key: string } | null>(null);
  const largest = [...drivers]
    .filter((d) => d.key !== OTHER_KEY)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0] ?? drivers[0];
  const selectedKey = pick?.end === p.end ? pick.key : largest?.key ?? null;
  const select = (key: string) => setPick({ end: p.end, key });

  const other = drivers.find((d) => d.key === OTHER_KEY);
  const member = other?.members?.find((d) => d.key === selectedKey);
  const driver = member ?? drivers.find((d) => d.key === selectedKey) ?? null;

  const change = p.endValue - p.startValue;
  const changePct = p.startValue > 0 ? (change / p.startValue) * 100 : null;

  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 min-w-0">
          {/* Heading over the waterfall, its totals flush with the chart's right edge */}
          <div className="flex min-h-7 items-center justify-between gap-4 mb-4">
            <div className="flex items-baseline gap-2 min-w-0">
              <h4 className="tp-row-label">{periodTitle(p, cadence)}</h4>
              <span className="tp-caption">{fmtDay(p.start)} close → {fmtDay(p.end)} close</span>
            </div>
            <div className="flex shrink-0 items-baseline gap-2 text-sm">
              <span className="tabular-nums text-muted-foreground">{money(p.startValue)} → {money(p.endValue)}</span>
              <span className={cn("font-semibold tabular-nums", toneOf(change))}>
                {signed(change)}{changePct != null && ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`}
              </span>
            </div>
          </div>
          <Waterfall
            period={p}
            drivers={drivers}
            cadence={cadence}
            selectedKey={member ? OTHER_KEY : selectedKey}
            onSelect={select}
          />
        </div>
        <div className="col-span-1 min-w-0 border-l border-border pl-6">
          <div className="flex min-h-7 items-center justify-end mb-4">
            {balancesEditable && (
              <button
                onClick={() => setEditingBalances(true)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
              >
                <Pencil className="h-3 w-3" />
                Edit manual balances
              </button>
            )}
          </div>
          {driver ? (
            <DriverDetail
              driver={driver}
              parent={member ? other : undefined}
              period={p}
              cadence={cadence}
              onSelect={select}
            />
          ) : (
            <p className="tp-caption py-8 text-center">Nothing moved this {cadence === "monthly" ? "month" : "week"}.</p>
          )}
        </div>
      </div>
      {balancesEditable && (
        <MonthEndBalancesModal
          open={editingBalances}
          month={p.end}
          onClose={() => setEditingBalances(false)}
          onSaved={onBalancesSaved}
        />
      )}
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A name split onto at most two lines to fit a column `maxChars` wide. */
function splitLabel(name: string, maxChars: number): string[] {
  if (name.length <= maxChars || !name.includes(" ")) return [name];
  const mid = name.length / 2;
  let at = -1;
  for (let i = 0; i < name.length; i++) {
    if (name[i] === " " && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i;
  }
  return [name.slice(0, at), name.slice(at + 1)];
}

const WF_HEIGHT = 300;
const WF_TOP = 28;    // room for the labels above the highest bar
const WF_BOTTOM = 44; // room for two-line column names
const WF_GUTTER = 56;  // left of the columns: the axis-start label

/** Open → each driver → close. The value axis starts just below the lowest
 *  level reached, not at zero, so a 2% month isn't a sliver on two tall bars. */
function Waterfall({
  period: p,
  drivers,
  cadence,
  selectedKey,
  onSelect,
}: {
  period: PerformancePeriod;
  drivers: Driver[];
  cadence: PerformanceCadence;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);

  let level = p.startValue;
  const steps = drivers.map((d) => {
    const from = level;
    level += d.amount;
    return { d, from, to: level };
  });
  const levels = [p.startValue, p.endValue, ...steps.map((s) => s.to)];
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  const unit = 10 ** Math.floor(Math.log10(span)) / 10;
  let base = Math.floor((lo - span * 0.4) / unit) * unit;
  if (lo >= 0 && base < 0) base = 0;
  const plotH = WF_HEIGHT - WF_TOP - WF_BOTTOM;
  const y = (v: number) => WF_TOP + ((hi - v) / (hi - base || 1)) * plotH;

  const n = drivers.length + 2;
  const colW = Math.max(width - WF_GUTTER, 0) / n;
  const barW = Math.min(colW * 0.62, 56);
  const colX = (i: number) => WF_GUTTER + colW * i;
  const cx = (i: number) => colX(i) + colW / 2;
  const maxChars = Math.max(5, Math.floor((colW - 6) / 6));
  const closeName = (day: string) => `${cadence === "monthly" ? monthShort(day) : md(day)} close`;

  const totalBar = (i: number, value: number, fill: string, name: string) => (
    <g key={name}>
      <rect x={cx(i) - barW / 2} y={y(value)} width={barW} height={Math.max(y(base) - y(value), 1)} rx={2} fill={fill} />
      <text x={cx(i)} y={y(value) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-foreground)">
        {short(value)}
      </text>
    </g>
  );
  const columnName = (i: number, name: string, on = false) => (
    <text x={cx(i)} y={WF_HEIGHT - WF_BOTTOM + 16} textAnchor="middle" fontSize={11} fontWeight={on ? 600 : 400} fill={on ? "var(--color-foreground)" : "var(--color-muted-foreground)"}>
      {splitLabel(name, maxChars).map((line, k) => (
        <tspan key={k} x={cx(i)} dy={k === 0 ? 0 : 13}>{line}</tspan>
      ))}
    </text>
  );

  return (
    <div ref={ref}>
      {width > 0 && (
        <svg width={width} height={WF_HEIGHT} className="block select-none">
          <defs>
            <pattern id={HATCH_ID} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--color-ink-5)" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--color-ink-3)" strokeWidth={2} />
            </pattern>
          </defs>

          {/* Column bands: the selected driver, then the hovered one */}
          {steps.map(({ d }, k) => {
            const on = d.key === selectedKey;
            if (!on && d.key !== hover) return null;
            return (
              <rect
                key={`band-${d.key}`}
                x={colX(k + 1) + 2}
                y={2}
                width={colW - 4}
                height={WF_HEIGHT - 4}
                rx={6}
                fill={on ? "var(--color-primary)" : "var(--color-muted)"}
                fillOpacity={on ? 0.07 : 1}
              />
            );
          })}
          {/* The axis doesn't start at zero, so say where it does, level with its line */}
          <line x1={WF_GUTTER} x2={width} y1={y(base)} y2={y(base)} stroke="var(--color-chart-axis)" strokeWidth={1} />
          <text
            x={WF_GUTTER - 8}
            y={y(base)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={11}
            fontFamily="var(--font-mono)"
            fill="var(--color-muted-foreground)"
          >
            {short(base)}
          </text>

          {totalBar(0, p.startValue, "var(--color-ink-5)", "start")}
          {columnName(0, closeName(p.start))}
          {steps.length > 0 && (
            <line
              x1={cx(0) + barW / 2}
              x2={cx(1) - barW / 2}
              y1={y(p.startValue)}
              y2={y(p.startValue)}
              stroke="var(--color-ink-4)"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
          )}

          {steps.map(({ d, from, to }, k) => {
            const i = k + 1;
            const top = y(Math.max(from, to));
            const h = Math.max(Math.abs(y(from) - y(to)), 2);
            const up = d.amount >= 0;
            return (
              <g key={d.key}>
                {/* Connector at the level this step leaves off, to the next bar */}
                <line
                  x1={cx(i) + barW / 2}
                  x2={cx(i + 1) - barW / 2}
                  y1={y(to)}
                  y2={y(to)}
                  stroke="var(--color-ink-4)"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
                <rect
                  x={cx(i) - barW / 2}
                  y={top}
                  width={barW}
                  height={h}
                  rx={2}
                  fill={d.key === UNRECONCILED_KEY ? `url(#${HATCH_ID})` : d.color}
                />
                <text
                  x={cx(i)}
                  y={up ? top - 6 : top + h + 14}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={500}
                  fill={Math.round(d.amount) === 0 ? "var(--color-muted-foreground)" : fillOf(d.amount)}
                >
                  {signedShort(d.amount)}
                </text>
                {columnName(i, chartName(d.name), d.key === selectedKey)}
              </g>
            );
          })}

          {totalBar(n - 1, p.endValue, "var(--color-primary)", "close")}
          {columnName(n - 1, closeName(p.end))}

          {/* Hit areas on top: a whole column, not just its (possibly 2px) bar */}
          {steps.map(({ d }, k) => (
            <rect
              key={`hit-${d.key}`}
              x={colX(k + 1)}
              y={0}
              width={colW}
              height={WF_HEIGHT}
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setHover(d.key)}
              onMouseLeave={() => setHover((h) => (h === d.key ? null : h))}
              onClick={() => onSelect(d.key)}
            />
          ))}
        </svg>
      )}
    </div>
  );
}

type DetailRow = { key: string; label: string; sub?: string; amount: number; driver?: Driver };

/** What sits behind one waterfall step: holdings for a class, transfers for
 *  deposits or withdrawals, accounts for unreconciled cash, members for Other. */
function DriverDetail({
  driver: d,
  parent,
  period: p,
  cadence,
  onSelect,
}: {
  driver: Driver;
  parent?: Driver;
  period: PerformancePeriod;
  cadence: PerformanceCadence;
  onSelect: (key: string) => void;
}) {
  let subtitle: string;
  let rows: DetailRow[];
  const unit = cadence === "monthly" ? "month" : "week";
  const flowRows = (sign: 1 | -1): DetailRow[] =>
    p.flows
      .filter((f) => f.amount * sign > 0)
      .map((f) => ({
        key: `${f.date}${f.account}${f.amount}${f.description}`,
        label: f.description || (sign > 0 ? "Deposit" : "Withdrawal"),
        sub: `${fmtDay(f.date)} · ${f.account}`,
        amount: f.amount,
      }));

  if (d.key === OTHER_KEY) {
    subtitle = `Changes each under ${MINOR_SHARE * 100}% of the ${unit}'s total movement`;
    rows = (d.members ?? []).map((m) => ({ key: m.key, label: m.name, amount: m.amount, driver: m }));
  } else if (d.key === DEPOSITS_KEY || d.key === WITHDRAWALS_KEY) {
    rows = flowRows(d.key === DEPOSITS_KEY ? 1 : -1);
    subtitle = `${rows.length} transfer${rows.length === 1 ? "" : "s"} ${d.key === DEPOSITS_KEY ? "in" : "out"}`;
  } else if (d.key === FEES_KEY) {
    rows = p.feeItems.map((f) => ({
      key: `${f.date}${f.account}${f.amount}${f.description}`,
      label: f.description,
      sub: `${fmtDay(f.date)} · ${f.account}`,
      amount: -f.amount,
    }));
    subtitle = `${rows.length} fee${rows.length === 1 ? "" : "s"} taken from account cash`;
  } else if (d.key === PREMIUM_KEY) {
    subtitle = "Earned in the brokerage, held until transferred to a bank. Not counted as return or withdrawals.";
    rows = p.optionsPremiumItems.map((x) => ({
      key: `${x.date}${x.account}${x.amount}${x.description}`,
      label: x.description,
      sub: `${fmtDay(x.date)} · ${x.account} · ${x.amount > 0 ? "closed" : "transferred"}`,
      amount: x.amount,
    }));
  } else if (d.key === UNRECONCILED_KEY) {
    subtitle = "Recorded cash balances vs. what the records predict";
    rows = p.unreconciledByAccount
      .filter((u) => Math.round(u.amount) !== 0)
      .map((u) => ({ key: u.account, label: u.account, amount: u.amount }));
  } else {
    const parts = [`Price change ${signed(d.marketChange ?? 0)}`];
    if (Math.round(d.income ?? 0) !== 0) parts.push(`Dividends & interest ${signed(d.income ?? 0)}`);
    subtitle = parts.join(" · ");
    const cls = p.classes.find((c) => c.key === d.key);
    rows = (cls?.holdings ?? [])
      .map((h) => ({
        key: h.label,
        label: h.label,
        sub: Math.round(h.income) !== 0 ? `incl. ${signed(h.income)} dividends & interest` : undefined,
        amount: h.marketChange + h.income,
      }))
      .filter((r) => Math.round(r.amount) !== 0);
  }
  rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return (
    <div>
      {parent && (
        <button
          onClick={() => onSelect(parent.key)}
          className="mb-2 -ml-1 flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {parent.name}
        </button>
      )}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Swatch driver={d} />
          <h5 className="tp-row-label truncate">{d.name}</h5>
          {d.key === UNRECONCILED_KEY && (
            <InfoHint>
              Where a recorded cash balance differs from what trades, dividends, and transfers since the previous one
              predict. It lands in the period of that balance, so it usually points to a transfer or fee that isn't recorded.
            </InfoHint>
          )}
        </div>
        <span className={cn("shrink-0 tp-numeric", toneOf(d.amount))}>{signed(d.amount)}</span>
      </div>
      <p className="tp-caption mt-0.5">{subtitle}</p>

      {rows.length === 0 ? (
        <p className="tp-caption mt-4">No detail recorded.</p>
      ) : (
        <div className="mt-3 max-h-[236px] overflow-y-auto divide-y divide-border border-y border-border">
          {rows.map((r) => {
            const body = (
              <>
                <span className="flex items-center gap-2 min-w-0">
                  {r.driver && <Swatch driver={r.driver} />}
                  <span className="min-w-0">
                    <span className="block truncate text-13">{r.label}</span>
                    {r.sub && <span className="block truncate text-xs text-muted-foreground">{r.sub}</span>}
                  </span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <span className={cn("tp-numeric", toneOf(r.amount))}>{signed(r.amount)}</span>
                  {r.driver && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                </span>
              </>
            );
            return r.driver ? (
              <button
                key={r.key}
                onClick={() => onSelect(r.driver!.key)}
                className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-muted"
              >
                {body}
              </button>
            ) : (
              <div key={r.key} className="flex items-center justify-between gap-3 py-2">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── What this first pass can't see yet ────────────────────────────────────────

function DataNotes({ data }: { data: PerformanceData }) {
  const { estimatedPrices, inconsistentPositions, negativeCash, managedDataThrough, cashObservations } = data.notes;
  const thinCash = cashObservations.filter((c) => c.count <= 1);
  return (
    <div className="mt-5 flex items-start gap-2 rounded-md bg-blue-soft px-3 py-2.5 text-xs text-blue-deep">
      <Info className="h-3.5 w-3.5 mt-px shrink-0" />
      <div className="space-y-1">
        {thinCash.length > 0 && (
          <p>
            Cash is rolled forward from each recorded balance through trades, dividends, and transfers.{" "}
            {thinCash.length} of {cashObservations.length} accounts have one balance at most, so earlier cash there is worked back from it.
          </p>
        )}
        {negativeCash.length > 0 && (
          <p>
            Cash worked back from the records goes negative, so a transfer is likely missing or on the wrong account:{" "}
            {negativeCash.map((n) => `${n.account} (${money(n.amount)} on ${fmtDay(n.date)})`).join(", ")}.
          </p>
        )}
        {managedDataThrough.some((m) => m.date) && (
          <p>
            Managed account trades come from QFX imports:{" "}
            {managedDataThrough.map((m) => `${m.account} through ${m.date ? fmtDay(m.date, true) : "—"}`).join(", ")}.
          </p>
        )}
        {estimatedPrices.length > 0 && (
          <p>Valued from the nearest available close (no earlier price history): {estimatedPrices.join(", ")}.</p>
        )}
        {inconsistentPositions.length > 0 && (
          <p>Sales or transfers with no matching purchase, so held as zero shares where they'd go negative: {inconsistentPositions.join(", ")}.</p>
        )}
      </div>
    </div>
  );
}
