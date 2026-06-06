import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Link2, Layers, X, Plus, CircleQuestionMark } from "lucide-react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import {
  getInstruments,
  getFlatAssetClasses,
  setInstrumentWeights,
  mergeInstrument,
  removeInstrumentTicker,
  patchInstrument,
} from "@/api";
import type { AssetClass, Instrument } from "@/types";
import { cn } from "@/lib/utils";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue } from "@/components/Typography";

// ── Constants ──────────────────────────────────────────────────────────────────

const SLUG_ABBREV: Record<string, string> = {
  "us-stocks":       "US",
  "us-large-cap":    "US-L",
  "us-mid-cap":      "US-M",
  "us-small-cap":    "US-S",
  "intl-stocks":     "INT",
  "intl-developed":  "INT-DM",
  "intl-emerging":   "INT-EM",
  "us-bonds":        "BND",
  "us-bonds-govt":   "BND-G",
  "us-bonds-corp":   "BND-C",
  "us-bonds-muni":   "BND-M",
  "intl-bonds":      "IBND",
  "intl-bonds-govt": "IBND-G",
  "intl-bonds-corp": "IBND-C",
  "alternatives":    "ALT",
  "alt-real-estate": "RE",
  "alt-commodities": "COM",
  "alt-gold":        "GLD",
  "alt-energy":      "NRG",
  "alt-other":       "Other",
  "cash":            "Cash",
};

const WEIGHT_COLUMNS = [
  ["us-stocks", "intl-stocks"],
  ["us-bonds", "intl-bonds"],
  ["alternatives", "cash"],
] as const;

const GROUP_ORDER = ["us-stocks", "intl-stocks", "us-bonds", "intl-bonds", "alternatives", "cash"];

// ── Scroll lock ────────────────────────────────────────────────────────────────

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function MobileSecurities() {
  const { data: instruments, refetch } = useApi(() => getInstruments(), []);
  const { data: assetClasses } = useApi(() => getFlatAssetClasses(), []);

  const [editInstrument, setEditInstrument] = useState<Instrument | null>(null);

  const acBySlug = useMemo(() => {
    const map = new Map<string, AssetClass>();
    for (const ac of assetClasses ?? []) {
      if (ac.slug) map.set(ac.slug, ac);
    }
    return map;
  }, [assetClasses]);

  const idToTopLevel = useMemo(() => {
    const acs = assetClasses ?? [];
    const map = new Map<string, AssetClass>();
    for (const ac of acs) {
      if (ac.parentId === null) {
        map.set(ac.id, ac);
      } else {
        const parent = acs.find((p) => p.id === ac.parentId);
        if (parent) map.set(ac.id, parent);
      }
    }
    return map;
  }, [assetClasses]);

  const { groups, unclassified } = useMemo(() => {
    const buckets = new Map<string, Instrument[]>();
    const unclassified: Instrument[] = [];

    for (const inst of instruments ?? []) {
      if (inst.weights.length === 0) { unclassified.push(inst); continue; }
      const topWeight = inst.weights.reduce((a, b) =>
        parseFloat(a.weight) >= parseFloat(b.weight) ? a : b,
      );
      const topLevel = idToTopLevel.get(topWeight.assetClassId);
      const slug = topLevel?.slug ?? null;
      if (!slug) { unclassified.push(inst); continue; }
      if (!buckets.has(slug)) buckets.set(slug, []);
      buckets.get(slug)!.push(inst);
    }

    const ordered = GROUP_ORDER
      .filter((s) => buckets.has(s))
      .map((s) => ({ slug: s, ac: acBySlug.get(s) ?? null, instruments: buckets.get(s)! }));

    for (const [slug, insts] of buckets) {
      if (!GROUP_ORDER.includes(slug)) {
        ordered.push({ slug, ac: acBySlug.get(slug) ?? null, instruments: insts });
      }
    }

    return { groups: ordered, unclassified };
  }, [instruments, idToTopLevel, acBySlug]);

  const renderRow = (instrument: Instrument) => {
    const uniqueAccounts = [
      ...new Map([
        ...instrument.holdings.map((h) => [h.account.id, h.account] as const),
        ...instrument.manualInvestments.map((m) => [m.account.id, m.account] as const),
      ]).values(),
    ];
    const total = instrument.weights.reduce((sum, w) => sum + parseFloat(w.weight), 0);
    const isComplete = total >= 99.9;
    const SLUG_ORDER = Object.keys(SLUG_ABBREV);
    const sortedWeights = [...instrument.weights].sort((a, b) => {
      const ai = SLUG_ORDER.indexOf(a.assetClass.slug ?? "");
      const bi = SLUG_ORDER.indexOf(b.assetClass.slug ?? "");
      return (ai === -1 ? SLUG_ORDER.length : ai) - (bi === -1 ? SLUG_ORDER.length : bi);
    });

    return (
      <button
        key={instrument.id}
        type="button"
        onClick={() => setEditInstrument(instrument)}
        className="w-full flex items-start gap-3 py-3 px-4 text-left active:opacity-60"
      >
        {/* Ticker + aliases */}
        <div className="shrink-0 w-16 pt-0.5">
          {!instrument.isManual && (
            <span className="font-semibold text-sm">{instrument.primaryTicker}</span>
          )}
          {!instrument.isManual && instrument.tickers.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {instrument.tickers.map((t) => (
                <div key={t.id} className="flex items-center gap-0.5">
                  <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">{t.ticker}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Name + accounts + chips */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-muted-foreground truncate">
            {instrument.name ?? <span className="italic opacity-50">—</span>}
          </p>
          {uniqueAccounts.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {uniqueAccounts.map((acct) => {
                const aliasTickers = instrument.holdings
                  .filter((h) => h.account.id === acct.id && h.ticker !== instrument.primaryTicker)
                  .map((h) => h.ticker);
                const label = aliasTickers.length > 0
                  ? `${acct.name} (${aliasTickers.join(", ")})`
                  : acct.name;
                return (
                  <span
                    key={acct.id}
                    className="rounded-full px-2 py-0.5 text-10 font-medium text-white"
                    style={{ backgroundColor: acct.color ?? "#e2e8f0" }}
                  >
                    {label}
                  </span>
                );
              })}
            </div>
          )}
          {(sortedWeights.length > 0 || instrument.isCollectible || !isComplete) && (
            <div className="flex flex-wrap items-center gap-1 mt-1">
              {sortedWeights.map((w) => {
                const abbrev = (w.assetClass.slug && SLUG_ABBREV[w.assetClass.slug]) || w.assetClass.name;
                const pct = Math.round(parseFloat(w.weight));
                return (
                  <StatValue
                    key={w.assetClassId}
                    className="rounded bg-border px-1.5 py-0.5 text-10 text-muted-foreground font-medium whitespace-nowrap"
                  >
                    {abbrev} {pct}%
                  </StatValue>
                );
              })}
              {instrument.isCollectible && (
                <span className="rounded bg-warn-soft border border-warn-line px-1.5 py-0.5 text-10 font-medium text-warn-deep whitespace-nowrap">
                  28% max
                </span>
              )}
              {!isComplete && (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" />
              )}
            </div>
          )}
        </div>
      </button>
    );
  };

  const renderSection = (slug: string, ac: AssetClass | null, insts: Instrument[], isFirst = false) => (
    <div key={`section-${slug}`}>
      <div
        className={cn("flex items-center gap-2 pl-[13px] pr-4 py-2 bg-muted border-border", isFirst ? "border-b" : "border-y")}
        style={{ borderLeft: `3px solid ${ac?.color ?? "transparent"}` }}
      >
        <SectionLabel as="span" className="text-foreground">
          {ac?.name ?? slug}
        </SectionLabel>
      </div>
      <div className="divide-y divide-border">
        {insts.map((inst) => renderRow(inst))}
      </div>
    </div>
  );

  if (!instruments) return <BeaconLoader />;

  return (
    <>
      <div className="space-y-5">
        <h1 className="tp-page-title">Securities</h1>

        {instruments.length > 0 ? (
          <div className="rounded-b-xl rounded-tr-xl border border-border bg-card overflow-hidden">
            {groups.map(({ slug, ac, instruments: groupInsts }, idx) =>
              renderSection(slug, ac, groupInsts, idx === 0),
            )}
            {unclassified.length > 0 &&
              renderSection("unclassified", null, unclassified, groups.length === 0)}
          </div>
        ) : (
          <div className="rounded-xl border border-border">
            <EmptyState
              icon={Layers}
              title="No securities yet"
              description="Securities are created automatically when you add holdings to your investment accounts."
            />
          </div>
        )}
      </div>

      <EditOverlay
        instrument={editInstrument}
        allInstruments={instruments ?? []}
        assetClasses={assetClasses ?? []}
        onClose={() => setEditInstrument(null)}
        onSave={async (id, { name, isCollectible, weights, mergeIds, removeTickers }) => {
          await Promise.all([
            setInstrumentWeights(id, weights),
            patchInstrument(id, { name, isCollectible }),
            ...removeTickers.map((t) => removeInstrumentTicker(id, t)),
            ...mergeIds.map((otherId) => mergeInstrument(id, otherId)),
          ]);
          setEditInstrument(null);
          refetch();
        }}
      />
    </>
  );
}

// ── EditOverlay ─────────────────────────────────────────────────────────────────

interface EditSavePayload {
  name: string | null;
  isCollectible: boolean;
  weights: { assetClassId: string; weight: number }[];
  mergeIds: string[];
  removeTickers: string[];
}

interface EditOverlayProps {
  instrument: Instrument | null;
  allInstruments: Instrument[];
  assetClasses: AssetClass[];
  onClose: () => void;
  onSave: (id: string, payload: EditSavePayload) => Promise<void>;
}

function EditOverlay({ instrument, allInstruments, assetClasses, onClose, onSave }: EditOverlayProps) {
  const isOpen = instrument !== null;
  useBodyScrollLock(isOpen);

  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [isCollectible, setIsCollectible] = useState(false);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [pendingSlots, setPendingSlots] = useState<string[]>([]);

  useEffect(() => {
    if (!instrument) return;
    setName(instrument.name ?? "");
    setIsCollectible(instrument.isCollectible);
    const map: Record<string, string> = {};
    for (const w of instrument.weights) {
      map[w.assetClassId] = parseFloat(w.weight).toString();
    }
    setWeights(map);
    setToRemove(new Set());
    setPendingSlots([]);
  }, [instrument]);

  const total = Object.values(weights).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

  const tickerToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const inst of allInstruments) map.set(inst.primaryTicker, inst.id);
    return map;
  }, [allInstruments]);

  const handleSave = async () => {
    if (!instrument || total > 100.01) return;
    setSaving(true);
    try {
      const selectedTickers = pendingSlots.filter((s) => s !== "");
      const mergeIds = selectedTickers
        .map((t) => tickerToId.get(t))
        .filter((id): id is string => id !== undefined);
      await onSave(instrument.id, {
        name: name.trim() || null,
        isCollectible,
        weights: Object.entries(weights)
          .map(([assetClassId, w]) => ({ assetClassId, weight: parseFloat(w) || 0 }))
          .filter((e) => e.weight > 0),
        mergeIds,
        removeTickers: [...toRemove],
      });
    } finally {
      setSaving(false);
    }
  };

  const bySlug = useMemo(() => {
    const map = new Map<string, AssetClass>();
    for (const ac of assetClasses) {
      if (ac.slug) map.set(ac.slug, ac);
    }
    return map;
  }, [assetClasses]);

  const childrenByParentSlug = useMemo(() => {
    const map = new Map<string, AssetClass[]>();
    for (const ac of assetClasses) {
      if (!ac.parentId) continue;
      const parent = assetClasses.find((p) => p.id === ac.parentId);
      if (!parent?.slug) continue;
      if (!map.has(parent.slug)) map.set(parent.slug, []);
      map.get(parent.slug)!.push(ac);
    }
    return map;
  }, [assetClasses]);

  const renderWeightGroup = (parentSlug: string) => {
    const parent = bySlug.get(parentSlug);
    if (!parent) return null;
    const children = childrenByParentSlug.get(parentSlug) ?? [];

    if (children.length === 0) {
      return (
        <div key={parent.id} className="flex items-center gap-2 py-2">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: parent.color ?? "#e2e8f0" }} />
            <SectionLabel as="span" className="truncate">{parent.name}</SectionLabel>
          </div>
          <WeightInput id={parent.id} value={weights[parent.id] ?? ""} onChange={(v) => setWeights((p) => ({ ...p, [parent.id]: v }))} />
        </div>
      );
    }

    return (
      <div key={parent.id} className="py-2">
        <div className="flex items-center gap-1.5 mb-2">
          <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: parent.color ?? "#e2e8f0" }} />
          <SectionLabel as="span">{parent.name}</SectionLabel>
        </div>
        <div className="space-y-2 pl-3.5">
          {children.map((ac) => (
            <div key={ac.id} className="flex items-center gap-2">
              <label className="flex-1 text-sm truncate">{ac.name}</label>
              <WeightInput id={ac.id} value={weights[ac.id] ?? ""} onChange={(v) => setWeights((p) => ({ ...p, [ac.id]: v }))} />
            </div>
          ))}
        </div>
      </div>
    );
  };

  const activeAliases = (instrument?.tickers ?? []).filter((t) => !toRemove.has(t.ticker));
  const otherInstruments = useMemo(
    () => allInstruments.filter((i) => i.id !== instrument?.id),
    [allInstruments, instrument],
  );

  // All parent slugs in order
  const allParentSlugs = WEIGHT_COLUMNS.flat();

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex flex-col bg-background transition-transform duration-250 ease-out",
        isOpen ? "translate-y-0" : "translate-y-full",
      )}
    >
      {/* Drag handle */}
      <div className="mx-auto mt-3 mb-2 h-1 w-10 rounded-full bg-muted-foreground/30 shrink-0" />

      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-3 pt-1 shrink-0 border-b border-border">
        <h2 className="tp-panel-title">
          Edit — {instrument?.primaryTicker ?? ""}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="p-4 space-y-6">

          {/* Asset Class Weights */}
          <div>
            <h3 className="text-sm font-semibold mb-1">Asset Class Weights</h3>
            <div className="divide-y divide-border">
              {allParentSlugs.map((slug) => renderWeightGroup(slug))}
            </div>
            <div className={cn(
              "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium mt-3",
              total > 100.01
                ? "bg-down/10 text-down"
                : total >= 99.9
                ? "bg-up-soft text-up-deep"
                : "bg-secondary text-muted-foreground",
            )}>
              <span>Total</span>
              <span>{total.toFixed(1)}%</span>
            </div>
            {total > 100.01 && (
              <p className="mt-1 text-xs text-down">Total exceeds 100%. Please adjust the weights.</p>
            )}
          </div>

          {/* Asset Name */}
          {!instrument?.isManual && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Asset Name</h3>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Vanguard Total Stock Market"
                className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* Tax Treatment */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Tax Treatment</h3>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={isCollectible}
                onChange={(e) => setIsCollectible(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-border accent-primary"
              />
              <span className="flex items-center gap-1.5 text-sm">
                Taxed as collectible
                <span className="group relative">
                  <CircleQuestionMark className="h-3.5 w-3.5 cursor-default text-muted-foreground/60" />
                  <span className="pointer-events-none invisible absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 tp-caption opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
                    Long-term gains taxed at the lesser of 28% or your ordinary income rate. Applies to grantor-trust gold and silver ETFs (e.g. GLD, IAU, SLV).
                  </span>
                </span>
              </span>
            </label>
          </div>

          {/* Equivalents */}
          {!instrument?.isManual && (
            <div>
              <h3 className="text-sm font-semibold mb-1">Equivalents</h3>
              <p className="tp-caption mb-3">
                Link securities that track the same portfolio (e.g. VTSAX ↔ VTI). They will share these asset class weights.
              </p>

              {activeAliases.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {activeAliases.map((t) => (
                    <span key={t.id} className="flex items-center gap-0.5 rounded bg-muted px-2 py-0.5 text-sm font-medium">
                      {t.ticker}
                      <button
                        onClick={() => setToRemove((prev) => new Set([...prev, t.ticker]))}
                        className="ml-0.5 rounded hover:text-down"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {pendingSlots.length > 0 && (
                <div className="mb-2 space-y-2">
                  {pendingSlots.map((slot, idx) => {
                    const excludedTickers = new Set([
                      instrument?.primaryTicker ?? "",
                      ...activeAliases.map((t) => t.ticker),
                      ...pendingSlots.filter((_, i) => i !== idx),
                    ]);
                    return (
                      <InstrumentSelect
                        key={idx}
                        instruments={otherInstruments}
                        excludedTickers={excludedTickers}
                        value={slot}
                        onChange={(ticker) => setPendingSlots((prev) => prev.map((s, i) => (i === idx ? ticker : s)))}
                        onRemove={() => setPendingSlots((prev) => prev.filter((_, i) => i !== idx))}
                      />
                    );
                  })}
                </div>
              )}

              <button
                onClick={() => setPendingSlots((prev) => [...prev, ""])}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="h-3 w-3" />
                Add equivalent
              </button>
            </div>
          )}

        </div>
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 border-t border-border px-4 py-4 flex gap-2">
        <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || total > 100.01} className="flex-1">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ── WeightInput ──────────────────────────────────────────────────────────────────

function WeightInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative w-20 shrink-0">
      <input
        type="text"
        inputMode="decimal"
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className="w-full rounded border border-border px-2 py-1.5 pr-6 text-right text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 tp-caption">%</span>
    </div>
  );
}

// ── InstrumentSelect ─────────────────────────────────────────────────────────────

function InstrumentSelect({
  instruments,
  excludedTickers,
  value,
  onChange,
  onRemove,
}: {
  instruments: Instrument[];
  excludedTickers: Set<string>;
  value: string;
  onChange: (ticker: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(value === "");
  const [search, setSearch] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, minWidth: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(
    () => instruments.filter((i) => !excludedTickers.has(i.primaryTicker)),
    [instruments, excludedTickers],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      (i) => i.primaryTicker.toLowerCase().includes(q) || (i.name ?? "").toLowerCase().includes(q),
    );
  }, [search, options]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    if (!editing) return;
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
    }
    inputRef.current?.focus();
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current && !ref.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setEditing(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  const select = (ticker: string) => {
    onChange(ticker);
    setEditing(false);
    setSearch("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); select(filtered[focusIdx].primaryTicker); }
    else if (e.key === "Escape") { setEditing(false); setSearch(""); }
  };

  if (!instruments) return <BeaconLoader />;

  return (
    <div ref={ref} className="flex items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search symbol…"
          className="flex-1 rounded border border-primary px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          onClick={() => { setSearch(""); setEditing(true); }}
          className="flex-1 rounded border border-border px-2 py-1.5 text-left text-sm font-medium hover:border-primary transition-colors"
        >
          {value || <span className="text-muted-foreground">Select symbol…</span>}
        </button>
      )}
      <button onClick={onRemove} className="shrink-0 rounded p-1 hover:bg-muted" title="Remove">
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {editing && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: dropdownPos.top,
            left: dropdownPos.left,
            minWidth: Math.max(dropdownPos.minWidth, 200),
            zIndex: 9999,
          }}
          className="max-h-48 overflow-auto rounded-md border border-border bg-background shadow-lg"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches</div>
          ) : (
            filtered.map((inst, i) => (
              <button
                key={inst.id}
                onMouseDown={(e) => { e.preventDefault(); select(inst.primaryTicker); }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted",
                  i === focusIdx && "bg-accent",
                )}
              >
                <span className="font-medium">{inst.primaryTicker}</span>
                {inst.name && <span className="truncate text-muted-foreground">{inst.name}</span>}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
