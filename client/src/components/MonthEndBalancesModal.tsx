import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Tooltip } from "@/components/Tooltip";
import {
  deleteMonthEndCash,
  deleteMonthEndManual,
  getMonthEndBalances,
  setMonthEndCash,
  setMonthEndManual,
} from "@/api";
import { cn } from "@/lib/utils";
import type { MonthEndBalances, MonthEndCell } from "@/types";

// ── Month-end balances editor ─────────────────────────────────────────────────
// One finished month's close: each investment account's settlement cash, and
// each manually tracked investment's value. A recorded value (typed in,
// imported, or from a statement) can be changed or deleted; deleting falls back
// to what the records around it work out to, shown here as the placeholder.
// The open month is edited on the account pages instead.

type Tab = "cash" | "manual";

type Line = {
  key: string;
  kind: Tab;
  id: string; // accountId for cash, seriesId for manual
  label: string;
  group: string; // account name
  cell: MonthEndCell;
};

/** What the user has done to a line: a typed value, or "use calculated". */
type Draft = { text: string } | { cleared: true };

const SOURCE_LABEL: Record<string, string> = {
  STATEMENT: "Statement value",
  MANUAL: "Set on the account page",
  QFX_IMPORT: "From a QFX import",
  OPTION_ASSIGNMENT: "From an option assignment",
  OPTION_CALL_AWAY: "From an option call-away",
  TRANSFER: "From a transfer",
  SEED: "Value when history began",
};

const fmt2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => (n < 0 ? `−$${fmt2.format(-n)}` : `$${fmt2.format(Math.abs(n) < 0.005 ? 0 : n)}`);
const fixed = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** The typed text as a number, or null if it isn't one. */
function parse(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "").replace(/^−/, "-");
  if (t === "" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/** "2026-10-30" → "Oct 30, 2026". */
const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function linesAt(d: MonthEndBalances, i: number): Line[] {
  const out: Line[] = [];
  for (const a of d.accounts) {
    out.push({ key: `cash:${a.id}`, kind: "cash", id: a.id, label: a.name, group: a.name, cell: a.cash[i] });
    for (const m of a.manual) {
      // Removed by then: nothing to value
      if (m.cells[i].calculated == null) continue;
      out.push({ key: `manual:${m.id}`, kind: "manual", id: m.id, label: m.name, group: a.name, cell: m.cells[i] });
    }
  }
  return out;
}

export function MonthEndBalancesModal({
  open,
  month: initialMonth,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** YYYY-MM-DD close the modal opens on; it can page to any other finished month. */
  month: string;
  onClose: () => void;
  /** Called after each save that wrote anything, so the caller can refresh. */
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<Tab>("cash");
  const [data, setData] = useState<MonthEndBalances | null>(null);
  const [month, setMonth] = useState(initialMonth);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const load = () =>
    getMonthEndBalances()
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message));

  useEffect(() => {
    if (!open) return;
    setData(null);
    setMonth(initialMonth);
    setDrafts(new Map());
    setError(null);
    setSavedNote(null);
    setTab("cash");
    load();
  }, [open, initialMonth]);

  const index = data ? data.months.indexOf(month) : -1;
  const lines = useMemo(() => (data && index >= 0 ? linesAt(data, index) : null), [data, index]);

  const setDraft = (key: string, d: Draft | null) =>
    setDrafts((prev) => {
      const next = new Map(prev);
      if (d) next.set(key, d);
      else next.delete(key);
      return next;
    });

  /** The write a line's draft calls for, if any; false when it won't parse. */
  const changeOf = (l: Line): { value: number | null } | false | undefined => {
    const d = drafts.get(l.key);
    if (!d) return undefined;
    if ("cleared" in d) return l.cell.recorded != null ? { value: null } : undefined;
    const v = parse(d.text);
    if (v == null || (l.kind === "manual" && v < 0)) return d.text.trim() === "" ? undefined : false;
    if (l.cell.recorded != null && Math.abs(v - l.cell.recorded) < 0.005) return undefined;
    return { value: v };
  };

  const changes = (lines ?? []).map((l) => ({ l, c: changeOf(l) }));
  const invalid = changes.filter((x) => x.c === false).map((x) => x.l.key);
  const pending = changes.filter((x): x is { l: Line; c: { value: number | null } } => !!x.c);
  // Drafts belong to the month on screen, so paging waits until they're saved
  // or cleared; a Save never carries edits from a month that's out of view.
  const dirty = pending.length > 0 || invalid.length > 0;

  const go = (by: 1 | -1) => {
    if (!data || dirty) return;
    const next = data.months[index + by];
    if (!next) return;
    setMonth(next);
    setDrafts(new Map());
    setError(null);
    setSavedNote(null);
  };

  const save = async () => {
    if (invalid.length) {
      setError("Fix the highlighted values first.");
      return;
    }
    setSaving(true);
    setError(null);
    setSavedNote(null);
    const failed: string[] = [];
    for (const { l, c } of pending) {
      try {
        if (l.kind === "cash") {
          await (c.value == null ? deleteMonthEndCash(l.id, month) : setMonthEndCash(l.id, month, c.value));
        } else {
          await (c.value == null ? deleteMonthEndManual(l.id, month) : setMonthEndManual(l.id, month, c.value));
        }
        setDraft(l.key, null);
      } catch (e) {
        failed.push(`${l.label}: ${(e as Error).message}`);
      }
    }
    const wrote = pending.length - failed.length;
    if (wrote > 0) {
      onSaved();
      // Calculated values in this and later months move with what was saved.
      await load();
      setSavedNote(`Saved ${wrote} ${wrote === 1 ? "change" : "changes"}.`);
    }
    setSaving(false);
    if (failed.length) setError(failed.join(" · "));
  };

  const counts = { cash: 0, manual: 0 };
  for (const { l, c } of changes) if (c) counts[l.kind]++;
  const shown = (lines ?? []).filter((l) => l.kind === tab);
  const hasManual = (lines ?? []).some((l) => l.kind === "manual");

  const pagerButton = (by: 1 | -1) => {
    const target = data?.months[index + by];
    const button = (
      <button
        type="button"
        onClick={() => go(by)}
        disabled={!target || dirty || saving}
        aria-label={by < 0 ? "Previous month" : "Next month"}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        {by < 0 ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
    );
    if (!target) return button;
    return (
      <Tooltip content={dirty ? "Save your changes first" : `${longDay(target)} close`}>
        {/* A span, so the tooltip still shows while the button is disabled */}
        <span className="inline-flex">{button}</span>
      </Tooltip>
    );
  };

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title="Manual balances" className="max-w-xl">
      <div className="mb-4 flex items-center justify-between rounded-md bg-muted px-2 py-1.5">
        {pagerButton(-1)}
        <p className="tp-row-label tabular-nums">{index >= 0 || !data ? `${longDay(month)} close` : "—"}</p>
        {pagerButton(1)}
      </div>

      <div className="flex rounded-md border border-border overflow-hidden text-13 font-medium mb-4">
        {(["cash", "manual"] as const).map((t, i) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 py-2 px-3 transition-colors",
              i > 0 && "border-l border-border",
              tab === t ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted",
            )}
          >
            {t === "cash" ? "Cash balances" : "Manual investments"}
            {counts[t] > 0 && <span className="ml-1.5 opacity-75">({counts[t]})</span>}
          </button>
        ))}
      </div>

      {loadError ? (
        <p className="tp-caption py-10 text-center">{loadError}</p>
      ) : !data ? (
        <p className="tp-caption py-10 text-center">Loading balances…</p>
      ) : !lines ? (
        <p className="tp-caption py-10 text-center">This month's balances can't be edited here.</p>
      ) : shown.length === 0 ? (
        <p className="tp-caption py-10 text-center">
          {tab === "manual" && !hasManual ? "No manually tracked investments this month." : "No accounts this month."}
        </p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {shown.map((l, i) => (
            <div key={l.key}>
              {/* Manual investments are grouped under their account */}
              {l.kind === "manual" && (i === 0 || shown[i - 1].group !== l.group) && (
                <p className="pt-3 pb-1 text-xs font-medium text-muted-foreground">{l.group}</p>
              )}
              <BalanceLine
                key={`${month}|${l.key}`}
                line={l}
                draft={drafts.get(l.key)}
                invalid={invalid.includes(l.key)}
                disabled={saving}
                onChange={(d) => setDraft(l.key, d)}
              />
            </div>
          ))}
        </div>
      )}

      <p className="tp-caption mt-3">
        Leave a value blank to keep it as is. Deleting a recorded value falls back to the calculated one shown.
        Current balances are set on each account's page.
      </p>
      {error && <p className="mt-3 text-xs text-down">{error}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        {savedNote && !dirty && <p className="mr-auto text-xs text-up">{savedNote}</p>}
        <Button variant="secondary" onClick={onClose} disabled={saving}>{dirty ? "Discard & close" : "Close"}</Button>
        <Button onClick={save} disabled={saving || pending.length === 0}>
          {saving ? "Saving…" : pending.length > 1 ? `Save ${pending.length} changes` : "Save"}
        </Button>
      </div>
    </Modal>
  );
}

function BalanceLine({
  line: l,
  draft,
  invalid,
  disabled,
  onChange,
}: {
  line: Line;
  draft: Draft | undefined;
  invalid: boolean;
  disabled: boolean;
  onChange: (d: Draft | null) => void;
}) {
  const { recorded, calculated, source } = l.cell;
  const cleared = !!draft && "cleared" in draft;
  const text = draft && "text" in draft ? draft.text : recorded != null && !cleared ? fixed(recorded) : "";
  const fallback = calculated ?? 0;
  const diff = recorded != null ? recorded - fallback : 0;

  const status = cleared
    ? `Will use the calculated ${money(fallback)}`
    : recorded != null
      ? `${source ? SOURCE_LABEL[source] ?? source : "Recorded"}${Math.abs(diff) >= 0.005 ? ` · calculated ${money(fallback)}` : ""}`
      : "Calculated from the records around it";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_9.5rem_1.75rem] items-center gap-x-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{l.label}</p>
        <p className={cn("truncate text-xs", cleared ? "text-down" : "text-muted-foreground")}>{status}</p>
      </div>
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <input
          inputMode="decimal"
          value={cleared ? "" : text}
          placeholder={fixed(fallback)}
          disabled={disabled || cleared}
          onChange={(e) => onChange({ text: e.target.value })}
          className={cn(
            "w-full rounded-md border bg-background py-1.5 pl-6 pr-2.5 text-right text-sm tabular-nums text-foreground outline-none placeholder:text-muted-foreground/60 disabled:bg-muted",
            invalid ? "border-down" : "border-border focus:border-primary",
          )}
        />
      </div>
      <div className="flex justify-center">
        {cleared ? (
          <Tooltip content="Keep the recorded value">
            <button
              type="button"
              onClick={() => onChange(null)}
              disabled={disabled}
              className="p-1.5 text-muted-foreground/40 hover:text-foreground transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : recorded != null ? (
          <Tooltip content="Delete, and use the calculated value">
            <button
              type="button"
              onClick={() => onChange({ cleared: true })}
              disabled={disabled}
              className="p-1.5 text-muted-foreground/40 hover:text-down transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
