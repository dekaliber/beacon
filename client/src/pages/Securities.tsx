import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Link2, Pencil, Layers, X, Plus } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
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

// ── Constants ──────────────────────────────────────────────────────────────

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

// Three columns: each is a list of parent-level slugs to show in that column
const WEIGHT_COLUMNS = [
  ["us-stocks", "intl-stocks"],
  ["us-bonds", "intl-bonds"],
  ["alternatives", "cash"],
] as const;

// ── Main page ──────────────────────────────────────────────────────────────

export function SecuritiesPage() {
  const navigate = useNavigate();
  const { data: instruments, refetch } = useApi(() => getInstruments(), []);
  const { data: assetClasses } = useApi(() => getFlatAssetClasses(), []);

  const [editModal, setEditModal] = useState<{ open: boolean; instrument: Instrument | null }>({
    open: false, instrument: null,
  });

  // slug → AssetClass lookup (used for group header labels + colors)
  const acBySlug = useMemo(() => {
    const map = new Map<string, AssetClass>();
    for (const ac of assetClasses ?? []) {
      if (ac.slug) map.set(ac.slug, ac);
    }
    return map;
  }, [assetClasses]);

  // assetClassId → its top-level AssetClass (parent if child, self if top-level)
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

  // Group instruments by the top-level class of their highest weight
  const { groups, unclassified } = useMemo(() => {
    const GROUP_ORDER = ["us-stocks", "intl-stocks", "us-bonds", "intl-bonds", "alternatives", "cash"];
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

    // Append any custom top-level classes not in GROUP_ORDER
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
      <tr key={instrument.id} className="hover:bg-muted/30">

        {/* Symbol + linked equivalents */}
        <td className="py-2 pl-4 pr-2 align-middle">
          {!instrument.isManual && (
            <span className="font-semibold text-sm">{instrument.primaryTicker}</span>
          )}
          {!instrument.isManual && instrument.tickers.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {instrument.tickers.map((t) => (
                <div key={t.id} className="flex items-center gap-1">
                  <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-semibold text-sm">{t.ticker}</span>
                </div>
              ))}
            </div>
          )}
        </td>

        {/* Name */}
        <td className="py-2 px-2 align-middle overflow-hidden">
          <span className="text-sm text-muted-foreground truncate block">
            {instrument.name ?? <span className="italic opacity-50">—</span>}
          </span>
        </td>

        {/* Accounts */}
        <td className="py-2 px-2 align-middle">
          <div className="flex flex-wrap gap-1">
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
                  className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                  style={{ backgroundColor: acct.color ?? "#e2e8f0" }}
                >
                  {label}
                </span>
              );
            })}
          </div>
        </td>

        {/* Classification chips + warning */}
        <td className="py-2 px-2 align-middle">
          <div className="flex flex-wrap items-center gap-1">
            {sortedWeights.map((w) => {
              const abbrev = (w.assetClass.slug && SLUG_ABBREV[w.assetClass.slug]) || w.assetClass.name;
              const pct = Math.round(parseFloat(w.weight));
              return (
                <span
                  key={w.assetClassId}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground font-medium whitespace-nowrap"
                >
                  {abbrev} {pct}%
                </span>
              );
            })}
            {instrument.isCollectible && (
              <span className="rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-700 whitespace-nowrap">
                28% max
              </span>
            )}
            {!isComplete && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-amber-500"
                aria-label={instrument.weights.length === 0 ? "No allocation defined" : `Only ${Math.round(total)}% allocated`}
              />
            )}
          </div>
        </td>

        {/* Actions */}
        <td className="py-2 pr-3 align-middle">
          <div className="flex items-center justify-end">
            <button
              onClick={() => setEditModal({ open: true, instrument })}
              className="rounded p-1 hover:bg-accent"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        </td>

      </tr>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/investments")}
              className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h2 className="text-2xl font-bold">Securities</h2>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          All unique securities across your investment accounts. Set asset class weights here once and they apply everywhere.
        </p>
      </div>

      <Card>
        {instruments && instruments.length > 0 ? (
          <div className="overflow-x-auto">
            <table style={{ tableLayout: "fixed", width: "100%", minWidth: "700px" }}>
              <colgroup>
                <col style={{ width: "80px" }} />
                <col />
                <col style={{ width: "200px" }} />
                <col style={{ width: "280px" }} />
                <col style={{ width: "36px" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 pl-4 pr-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Symbol</th>
                  <th className="py-2 px-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</th>
                  <th className="py-2 px-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Accounts</th>
                  <th className="py-2 px-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Classification</th>
                  <th className="py-2 pr-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[
                  ...groups.flatMap(({ slug, ac, instruments: groupInsts }) => [
                    <tr key={`section-${slug}`} className="bg-muted/40 border-b border-border">
                      <td
                        colSpan={5}
                        className="py-1.5 pl-3 pr-2"
                        style={{ borderLeft: `3px solid ${ac?.color ?? "transparent"}` }}
                      >
                        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                          {ac?.name ?? slug}
                        </span>
                      </td>
                    </tr>,
                    ...groupInsts.map((instrument) => renderRow(instrument)),
                  ]),
                  ...(unclassified.length > 0
                    ? [
                        <tr key="section-unclassified" className="bg-muted/40 border-b border-border">
                          <td colSpan={5} className="py-1.5 pl-3 pr-2" style={{ borderLeft: "3px solid transparent" }}>
                            <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                              Not Classified
                            </span>
                          </td>
                        </tr>,
                        ...unclassified.map((instrument) => renderRow(instrument)),
                      ]
                    : []),
                ]}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Layers}
            title="No securities yet"
            description="Securities are created automatically when you add holdings to your investment accounts."
          />
        )}
      </Card>

      <EditModal
        open={editModal.open}
        instrument={editModal.instrument}
        allInstruments={instruments ?? []}
        assetClasses={assetClasses ?? []}
        onClose={() => setEditModal({ open: false, instrument: null })}
        onSave={async (id, { name, isCollectible, weights, mergeIds, removeTickers }) => {
          await Promise.all([
            setInstrumentWeights(id, weights),
            patchInstrument(id, { name, isCollectible }),
            ...removeTickers.map((t) => removeInstrumentTicker(id, t)),
            ...mergeIds.map((otherId) => mergeInstrument(id, otherId)),
          ]);
          setEditModal({ open: false, instrument: null });
          refetch();
        }}
      />
    </div>
  );
}

// ── EditModal ───────────────────────────────────────────────────────────────

interface EditSavePayload {
  name: string | null;
  isCollectible: boolean;
  weights: { assetClassId: string; weight: number }[];
  mergeIds: string[];      // IDs of other instruments to merge into this one
  removeTickers: string[]; // alias ticker strings to remove
}

interface EditModalProps {
  open: boolean;
  instrument: Instrument | null;
  allInstruments: Instrument[];
  assetClasses: AssetClass[];
  onClose: () => void;
  onSave: (id: string, payload: EditSavePayload) => Promise<void>;
}

function EditModal({ open, instrument, allInstruments, assetClasses, onClose, onSave }: EditModalProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [isCollectible, setIsCollectible] = useState(false);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [pendingSlots, setPendingSlots] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !instrument) return;
    setName(instrument.name ?? "");
    setIsCollectible(instrument.isCollectible);
    const map: Record<string, string> = {};
    for (const w of instrument.weights) {
      map[w.assetClassId] = parseFloat(w.weight).toString();
    }
    setWeights(map);
    setToRemove(new Set());
    setPendingSlots([]);
  }, [open, instrument]);

  const total = Object.values(weights).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

  // Build a ticker→id lookup for resolving pending slot selections to instrument IDs
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

  // Index flat asset classes by slug for the 3-column weight layout
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
      // Top-level leaf (e.g. Cash)
      return (
        <div key={parent.id} className="mb-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: parent.color ?? "#e2e8f0" }} />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide truncate">{parent.name}</span>
            </div>
            <WeightInput id={parent.id} value={weights[parent.id] ?? ""} onChange={(v) => setWeights((p) => ({ ...p, [parent.id]: v }))} />
          </div>
        </div>
      );
    }

    return (
      <div key={parent.id} className="mb-4">
        <div className="flex items-center gap-1.5 mb-2">
          <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: parent.color ?? "#e2e8f0" }} />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{parent.name}</span>
        </div>
        <div className="space-y-1.5">
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

  // Existing aliases still active (minus removals)
  const activeAliases = (instrument?.tickers ?? []).filter((t) => !toRemove.has(t.ticker));

  // Other instruments available for equivalents selection
  const otherInstruments = useMemo(
    () => allInstruments.filter((i) => i.id !== instrument?.id),
    [allInstruments, instrument],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit — ${instrument?.primaryTicker ?? ""}`}
      className="max-w-3xl"
    >
      <div className="space-y-6">

        {/* ── Asset Class Weights ── */}
        <div>
          <h3 className="text-sm font-semibold mb-3">Asset Class Weights</h3>
          <div className="grid grid-cols-3 gap-x-6">
            {WEIGHT_COLUMNS.map((colSlugs, colIdx) => (
              <div key={colIdx}>
                {colSlugs.map((slug) => renderWeightGroup(slug))}
              </div>
            ))}
          </div>
          <div className={cn(
            "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium",
            total > 100.01
              ? "bg-destructive/10 text-destructive"
              : total >= 99.9
              ? "bg-green-50 text-green-700"
              : "bg-muted text-muted-foreground",
          )}>
            <span>Total</span>
            <span>{total.toFixed(1)}%</span>
          </div>
          {total > 100.01 && (
            <p className="mt-1 text-xs text-destructive">Total exceeds 100%. Please adjust the weights.</p>
          )}
        </div>

        {/* ── Asset Name ── */}
        {!instrument?.isManual && <div>
          <h3 className="text-sm font-semibold mb-2">Asset Name</h3>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Vanguard Total Stock Market"
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>}

        {/* ── Tax Treatment ── */}
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
                <span className="flex h-3.5 w-3.5 cursor-default items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] font-bold leading-none text-muted-foreground">
                  ?
                </span>
                <span className="pointer-events-none invisible absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
                  Long-term gains taxed at the lesser of 28% or your ordinary income rate. Applies to grantor-trust gold and silver ETFs (e.g. GLD, IAU, SLV).
                </span>
              </span>
            </span>
          </label>
        </div>

        {/* ── Equivalents ── */}
        {!instrument?.isManual && <div>
          <h3 className="text-sm font-semibold mb-1">Equivalents</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Link securities that track the same portfolio (e.g. VTSAX ↔ VTI). They will share these asset class weights.
          </p>

          {/* Existing aliases */}
          {activeAliases.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {activeAliases.map((t) => (
                <span key={t.id} className="flex items-center gap-0.5 rounded bg-muted px-2 py-0.5 text-sm font-medium">
                  {t.ticker}
                  <button
                    onClick={() => setToRemove((prev) => new Set([...prev, t.ticker]))}
                    className="ml-0.5 rounded hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Pending add slots */}
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
        </div>}

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || total > 100.01}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>

      </div>
    </Modal>
  );
}

// ── WeightInput ─────────────────────────────────────────────────────────────

function WeightInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative w-20 shrink-0">
      <input
        type="number"
        id={id}
        min={0}
        max={100}
        step={0.1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className="w-full rounded border border-border px-2 py-1 pr-6 text-right text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
    </div>
  );
}

// ── InstrumentSelect ────────────────────────────────────────────────────────

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
    // Measure position every time editing opens (handles initial-true case for new slots)
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

  const startEditing = () => {
    setSearch("");
    setEditing(true);
  };

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
          className="flex-1 rounded border border-primary px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          onClick={startEditing}
          className="flex-1 rounded border border-border px-2 py-1 text-left text-sm font-medium hover:border-primary transition-colors"
        >
          {value || <span className="text-muted-foreground">Select symbol…</span>}
        </button>
      )}
      <button onClick={onRemove} className="shrink-0 rounded p-1 hover:bg-accent" title="Remove">
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
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
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
