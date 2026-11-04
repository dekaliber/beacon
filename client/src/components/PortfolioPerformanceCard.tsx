import { useMemo, useState } from "react";
import { BarChart3, ChevronRight, Info } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
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
import { useApi } from "@/hooks/useApi";
import { getInvestmentPerformance } from "@/api";
import { useDemo } from "@/context/DemoContext";
import { scalePerformance } from "@/lib/demo";
import { cn } from "@/lib/utils";
import type { PerformanceCadence, PerformanceData, PerformancePeriod } from "@/types";

// ── Portfolio performance ─────────────────────────────────────────────────────
// Total investment value at each week/month-end close since the start of 2026,
// and what moved it: market change per asset class (dividends included), money
// moved in or out, and cash changes the records don't explain ("unreconciled").

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
const FLOWS_KEY = "__flows";
// Dark slate: the one neutral that stays clear of every saved class color
// (nearest is Cash's gray) and of Untracked's light gray beside it in the stack.
const FLOWS_COLOR = "var(--color-ink-2)";
const UNRECONCILED_KEY = "__unreconciled";
const HATCH_ID = "perf-unreconciled-hatch";

type Series = { key: string; name: string; color: string; fill: string };

// Series hidden from the contribution bars, remembered per browser. A viewer
// convenience only: hiding never changes the totals or the breakdown.
const HIDDEN_KEY = "beacon_perf_hidden_series";
function loadHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveHidden(keys: Set<string>) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...keys]));
  } catch {
    // storage unavailable (private window); the toggle still works for this visit
  }
}

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money = (n: number) => usd0.format(Math.round(n) === 0 ? 0 : n);
const signed = (n: number) => (Math.round(n) === 0 ? "$0" : `${n > 0 ? "+" : "−"}${usd0.format(Math.abs(n))}`);
const toneOf = (n: number) => (Math.round(n) === 0 ? "text-muted-foreground" : n > 0 ? "text-up" : "text-down");

function compact(v: number): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}

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

/** "YYYY-MM-DD" → e.g. "Oct 30" (or "Oct 30, 2026"); read as a calendar date. */
function fmtDay(day: string, withYear = false): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(withYear && { year: "numeric" }), timeZone: "UTC",
  });
}

function periodTitle(p: PerformancePeriod, cadence: PerformanceCadence): string {
  if (cadence === "monthly") {
    const month = new Date(`${p.end}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return p.partial ? `${month} to date` : month;
  }
  return p.partial ? `Week to date, ${fmtDay(p.end)}` : `Week ending ${fmtDay(p.end, true)}`;
}

const contribution = (p: PerformancePeriod, key: string): number => {
  if (key === FLOWS_KEY) return p.deposits - p.withdrawals;
  if (key === UNRECONCILED_KEY) return p.unreconciled;
  const c = p.classes.find((x) => x.key === key);
  return c ? c.marketChange + c.income : 0;
};

export function PortfolioPerformanceCard() {
  const [cadence, setCadence] = useState<PerformanceCadence>("monthly");
  const [selectedEnd, setSelectedEnd] = useState<string | null>(null);
  const { data: raw, loading } = useApi(() => getInvestmentPerformance(cadence), [cadence]);
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

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <SectionLabel as="span">Performance</SectionLabel>
        </div>
        {cadenceButtons}
      </div>
      {!data || data.cadence !== cadence ? (
        <p className="tp-caption py-16 text-center">{loading ? "Rebuilding history…" : "No history yet."}</p>
      ) : data.periods.length === 0 ? (
        <p className="tp-caption py-16 text-center">No history yet.</p>
      ) : (
        <PerformanceBody
          data={data}
          // The latest full period by default; a just-started one is mostly empty.
          selectedEnd={selectedEnd ?? [...data.periods].reverse().find((p) => !p.partial)?.end ?? data.periods[data.periods.length - 1].end}
          onSelect={setSelectedEnd}
        />
      )}
    </Card>
  );
}

function PerformanceBody({
  data,
  selectedEnd,
  onSelect,
}: {
  data: PerformanceData;
  selectedEnd: string;
  onSelect: (end: string) => void;
}) {
  const { periods, cadence } = data;
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      saveHidden(next);
      return next;
    });
  const last = periods[periods.length - 1];
  const totalChange = last.endValue - data.baselineValue;
  const totals = periods.reduce(
    (t, p) => ({
      market: t.market + p.classes.reduce((s, c) => s + c.marketChange + c.income, 0),
      flows: t.flows + p.deposits - p.withdrawals,
      unreconciled: t.unreconciled + p.unreconciled,
    }),
    { market: 0, flows: 0, unreconciled: 0 },
  );

  // Only series that ever contribute, in a fixed order: classes, Untracked,
  // flows, unreconciled. Colors are bound to the class, not its position here.
  const series = useMemo<Series[]>(() => {
    const present = (key: string) => periods.some((p) => Math.round(contribution(p, key)) !== 0);
    const out: Series[] = [];
    let slot = 0;
    for (const c of data.classes) {
      const color = c.key === UNTRACKED_KEY
        ? UNTRACKED_COLOR
        : c.color ?? CLASS_TOKENS[slot++ % CLASS_TOKENS.length];
      if (present(c.key)) out.push({ key: c.key, name: c.name, color, fill: color });
    }
    if (present(FLOWS_KEY)) out.push({ key: FLOWS_KEY, name: "Deposits/Withdrawals", color: FLOWS_COLOR, fill: FLOWS_COLOR });
    if (present(UNRECONCILED_KEY)) {
      out.push({ key: UNRECONCILED_KEY, name: "Unreconciled cash", color: "var(--color-ink-3)", fill: `url(#${HATCH_ID})` });
    }
    return out;
  }, [data.classes, periods]);
  const visibleSeries = series.filter((s) => !hidden.has(s.key));

  const rows = useMemo(() => {
    const label = (end: string) =>
      cadence === "weekly"
        ? `${Number(end.slice(5, 7))}/${Number(end.slice(8, 10))}`
        : end !== data.baseline
          ? new Date(`${end}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })
          : fmtDay(end);
    return [
      { end: data.baseline, label: label(data.baseline), value: data.baselineValue, period: null as PerformancePeriod | null },
      ...periods.map((p) => ({
        end: p.end,
        label: label(p.end),
        value: p.endValue,
        period: p as PerformancePeriod | null,
        ...Object.fromEntries(series.map((s) => [s.key, contribution(p, s.key)])),
      })),
    ];
  }, [periods, series, cadence, data.baseline, data.baselineValue]);

  const values = rows.map((r) => r.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const vPad = Math.max((vMax - vMin) * 0.08, vMax * 0.005);
  const valueAxis = niceTicks(vMin - vPad, vMax + vPad);
  const selected = periods.find((p) => p.end === selectedEnd) ?? last;

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

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
        <span className={cn("text-sm font-medium", toneOf(totalChange))}>
          {signed(totalChange)} YTD
        </span>
        <span className="tp-caption">
          Investment return <span className={cn("tabular-nums", toneOf(totals.market))}>{signed(totals.market)}</span>
          {" · "}Deposits/Withdrawals <span className={cn("tabular-nums", toneOf(totals.flows))}>{signed(totals.flows)}</span>
          {" · "}Unreconciled cash <span className={cn("tabular-nums", toneOf(totals.unreconciled))}>{signed(totals.unreconciled)}</span>
        </span>
      </div>

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
            {/* Lines at exactly the rounded ticks: left to itself the grid picks its
                own tick count, leaving labels with no line beside them. */}
            <CartesianGrid
              stroke="var(--color-chart-grid)"
              vertical={false}
              horizontalCoordinatesGenerator={({ offset }) => {
                const lo = valueAxis.ticks[0];
                const hi = valueAxis.ticks[valueAxis.ticks.length - 1];
                const top = offset.top ?? 0;
                const h = offset.height ?? 0;
                return valueAxis.ticks.map((v) => top + ((hi - v) / (hi - lo || 1)) * h);
              }}
            />
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

      {/* Bottom: each period's change, split by what drove it. Click to break one down.
          Labeled separately, since its scale has nothing to do with the line's above. */}
      <p className="tp-caption pl-16 mt-4 mb-1">Change each {cadence === "weekly" ? "week" : "month"}</p>
      <ResponsiveContainer width="100%" height={190}>
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
          <defs>
            <pattern id={HATCH_ID} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--color-ink-5)" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--color-ink-3)" strokeWidth={2} />
            </pattern>
          </defs>
          <CartesianGrid stroke="var(--color-chart-grid)" vertical={false} />
          <XAxis
            dataKey="end"
            tickFormatter={(end: string) => rows.find((r) => r.end === end)?.label ?? ""}
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis {...yAxisProps} />
          <ReferenceLine y={0} stroke="var(--color-chart-axis)" strokeWidth={1} />
          {hoverEnd && hoverEnd !== data.baseline && (
            <ReferenceArea x1={hoverEnd} x2={hoverEnd} fill="var(--color-muted)" fillOpacity={1} strokeWidth={0} />
          )}
          <RechartsTooltip
            content={<ContributionTooltip series={series} hidden={hidden} cadence={cadence} />}
            cursor={false}
          />
          {visibleSeries.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="change"
              fill={s.fill}
              stroke="var(--color-background)"
              strokeWidth={1}
              maxBarSize={24}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 pl-16 text-xs text-muted-foreground">
        {series.map((s) => {
          const isHidden = hidden.has(s.key);
          return (
            <button
              key={s.key}
              onClick={() => toggleHidden(s.key)}
              aria-pressed={!isHidden}
              title={isHidden ? "Click to show" : "Click to hide"}
              className={cn("flex items-center gap-1.5 hover:text-foreground transition-opacity", isHidden && "opacity-40 line-through")}
            >
              {s.key === UNRECONCILED_KEY ? (
                <svg width={10} height={10} className="rounded-sm"><rect width={10} height={10} fill={`url(#${HATCH_ID})`} /></svg>
              ) : (
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
              )}
              {s.name}
            </button>
          );
        })}
      </div>

      <PeriodBreakdown period={selected} cadence={cadence} series={series} />
      <DataNotes data={data} />
    </>
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

function ContributionTooltip({ active, payload, series, hidden, cadence }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload.period as PerformancePeriod | null;
  if (!p) return null;
  const all = (series as Series[]).map((s) => ({ s, v: contribution(p, s.key) }));
  const items = all
    .filter((x) => !(hidden as Set<string>).has(x.s.key) && Math.round(x.v) !== 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  // Hidden series still count toward the net change, so show them as one line.
  const hiddenTotal = all.filter((x) => (hidden as Set<string>).has(x.s.key)).reduce((sum, x) => sum + x.v, 0);
  const change = p.endValue - p.startValue;
  return (
    <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs space-y-1 min-w-[220px]">
      <p className="font-semibold text-foreground">{periodTitle(p, cadence)}</p>
      {items.map(({ s, v }) => (
        <div key={s.key} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {s.key === UNRECONCILED_KEY ? (
              <svg width={8} height={8}><rect width={8} height={8} fill={`url(#${HATCH_ID})`} /></svg>
            ) : (
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
            )}
            {s.name}
          </span>
          <span className={cn("tabular-nums", toneOf(v))}>{signed(v)}</span>
        </div>
      ))}
      {Math.round(hiddenTotal) !== 0 && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground/70 pl-3.5">Hidden</span>
          <span className={cn("tabular-nums", toneOf(hiddenTotal))}>{signed(hiddenTotal)}</span>
        </div>
      )}
      <div className="flex justify-between gap-4 pt-1 border-t border-border">
        <span className="text-muted-foreground">Net change</span>
        <span className={cn("font-medium tabular-nums", toneOf(change))}>{signed(change)}</span>
      </div>
      <p className="text-muted-foreground pt-0.5">Click to break down</p>
    </div>
  );
}

// ── Period breakdown ─────────────────────────────────────────────────────────

const GRID = "grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_7.5rem] items-center gap-x-3";

function PeriodBreakdown({
  period: p,
  cadence,
  series,
}: {
  period: PerformancePeriod;
  cadence: PerformanceCadence;
  series: Series[];
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const colorOf = new Map(series.map((s) => [s.key, s.color]));
  const classRows = p.classes
    .filter((c) => Math.round(c.marketChange) !== 0 || Math.round(c.income) !== 0)
    .sort((a, b) => Math.abs(b.marketChange + b.income) - Math.abs(a.marketChange + a.income));
  const nameOf = (key: string) => series.find((s) => s.key === key)?.name ?? (key === UNTRACKED_KEY ? "Untracked" : key);
  const marketTotal = p.classes.reduce((s, c) => s + c.marketChange, 0);
  const incomeTotal = p.classes.reduce((s, c) => s + c.income, 0);
  const change = p.endValue - p.startValue;
  const changePct = p.startValue > 0 ? (change / p.startValue) * 100 : null;

  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <div className="flex items-baseline gap-2">
          <h4 className="tp-row-label">{periodTitle(p, cadence)}</h4>
          <span className="tp-caption">{fmtDay(p.start)} close → {fmtDay(p.end)} close</span>
        </div>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="tabular-nums text-muted-foreground">{money(p.startValue)} → {money(p.endValue)}</span>
          <span className={cn("font-semibold tabular-nums", toneOf(change))}>
            {signed(change)}{changePct != null && ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`}
          </span>
        </div>
      </div>

      <div className={cn(GRID, "pb-1.5 text-xs text-muted-foreground")}>
        <span>Asset class</span>
        <span className="text-right">Price change</span>
        <span className="text-right">Dividends &amp; interest</span>
        <span className="text-right">Total</span>
      </div>

      <div className="divide-y divide-border border-y border-border">
        {classRows.map((c) => {
          const isOpen = open.has(c.key);
          const total = c.marketChange + c.income;
          return (
            <div key={c.key}>
              <button onClick={() => toggle(c.key)} className={cn(GRID, "w-full py-2 text-left text-sm hover:bg-muted")}>
                <span className="flex items-center gap-2 min-w-0">
                  <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorOf.get(c.key) ?? UNTRACKED_COLOR }} />
                  <span className="truncate">{nameOf(c.key)}</span>
                </span>
                <span className={cn("text-right tabular-nums", toneOf(c.marketChange))}>{signed(c.marketChange)}</span>
                <span className={cn("text-right tabular-nums", toneOf(c.income))}>{signed(c.income)}</span>
                <span className={cn("text-right tabular-nums font-medium", toneOf(total))}>{signed(total)}</span>
              </button>
              {isOpen && <HoldingRows holdings={c.holdings} />}
            </div>
          );
        })}
        <div className={cn(GRID, "py-2 text-sm font-medium")}>
          <span className="pl-[1.375rem]">Investment return</span>
          <span className={cn("text-right tabular-nums", toneOf(marketTotal))}>{signed(marketTotal)}</span>
          <span className={cn("text-right tabular-nums", toneOf(incomeTotal))}>{signed(incomeTotal)}</span>
          <span className={cn("text-right tabular-nums", toneOf(marketTotal + incomeTotal))}>{signed(marketTotal + incomeTotal)}</span>
        </div>
      </div>

      <div className="divide-y divide-border border-b border-border">
        <FlowRow
          label="Deposits"
          amount={p.deposits}
          open={open.has("deposits")}
          onToggle={() => toggle("deposits")}
          items={p.flows.filter((f) => f.amount > 0).map((f) => ({ key: `${f.date}${f.account}${f.amount}`, label: `${fmtDay(f.date)} · ${f.account} · ${f.description}`, amount: f.amount }))}
        />
        <FlowRow
          label="Withdrawals"
          amount={-p.withdrawals}
          open={open.has("withdrawals")}
          onToggle={() => toggle("withdrawals")}
          items={p.flows.filter((f) => f.amount < 0).map((f) => ({ key: `${f.date}${f.account}${f.amount}`, label: `${fmtDay(f.date)} · ${f.account} · ${f.description}`, amount: f.amount }))}
        />
        <FlowRow
          label="Unreconciled cash"
          hint="Where a recorded cash balance differs from what trades, dividends, and transfers since the previous one predict. It lands in the period of that balance, so it usually points to a transfer or fee that isn't recorded."
          amount={p.unreconciled}
          open={open.has("unreconciled")}
          onToggle={() => toggle("unreconciled")}
          items={p.unreconciledByAccount.map((u) => ({ key: u.account, label: u.account, amount: u.amount }))}
        />
      </div>
    </div>
  );
}

function HoldingRows({ holdings }: { holdings: PerformancePeriod["classes"][number]["holdings"] }) {
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 8;
  const shown = showAll ? holdings : holdings.slice(0, LIMIT);
  return (
    <div className="pb-2">
      {shown.map((h) => (
        <div key={h.label} className={cn(GRID, "py-1 text-xs")}>
          <span className="pl-[2.75rem] truncate text-muted-foreground">{h.label}</span>
          <span className={cn("text-right tabular-nums", toneOf(h.marketChange))}>{signed(h.marketChange)}</span>
          <span className={cn("text-right tabular-nums", toneOf(h.income))}>{signed(h.income)}</span>
          <span className={cn("text-right tabular-nums", toneOf(h.marketChange + h.income))}>{signed(h.marketChange + h.income)}</span>
        </div>
      ))}
      {holdings.length > LIMIT && (
        <button onClick={() => setShowAll((v) => !v)} className="pl-[2.75rem] py-1 text-xs text-primary hover:underline">
          {showAll ? "Show fewer" : `Show ${holdings.length - LIMIT} more`}
        </button>
      )}
    </div>
  );
}

function FlowRow({
  label,
  hint,
  amount,
  open,
  onToggle,
  items,
}: {
  label: string;
  hint?: string;
  amount: number;
  open: boolean;
  onToggle: () => void;
  items: Array<{ key: string; label: string; amount: number }>;
}) {
  const expandable = items.length > 0;
  return (
    <div>
      <button
        onClick={expandable ? onToggle : undefined}
        className={cn(GRID, "w-full py-2 text-left text-sm", expandable ? "hover:bg-muted" : "cursor-default")}
      >
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !expandable && "invisible")}
          />
          <span>{label}</span>
          {hint && <InfoHint>{hint}</InfoHint>}
        </span>
        <span />
        <span />
        <span className={cn("text-right tabular-nums font-medium", toneOf(amount))}>{signed(amount)}</span>
      </button>
      {open && expandable && (
        <div className="pb-2">
          {items.map((i) => (
            <div key={i.key} className={cn(GRID, "py-1 text-xs")}>
              <span className="pl-[1.375rem] truncate text-muted-foreground">{i.label}</span>
              <span />
              <span />
              <span className={cn("text-right tabular-nums", toneOf(i.amount))}>{signed(i.amount)}</span>
            </div>
          ))}
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
