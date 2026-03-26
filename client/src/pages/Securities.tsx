import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Link2, X, Layers } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import {
  getInstruments,
  getFlatAssetClasses,
  setInstrumentWeights,
  addInstrumentTicker,
  removeInstrumentTicker,
  patchInstrument,
  deleteInstrument,
} from "@/api";
import type { AssetClass, Instrument } from "@/types";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────

function classifiedPct(instrument: Instrument): number {
  return instrument.weights.reduce((sum, w) => sum + parseFloat(w.weight), 0);
}

function accountBadge(color: string | null) {
  return color ?? "#e2e8f0";
}

// ── Main page ──────────────────────────────────────────────────────────────

export function SecuritiesPage() {
  const { data: instruments, refetch } = useApi(() => getInstruments(), []);
  const { data: assetClasses } = useApi(() => getFlatAssetClasses(), []);

  const [weightsModal, setWeightsModal] = useState<{ open: boolean; instrument: Instrument | null }>({
    open: false, instrument: null,
  });
  const [aliasModal, setAliasModal] = useState<{ open: boolean; instrument: Instrument | null }>({
    open: false, instrument: null,
  });
  const [renameModal, setRenameModal] = useState<{ open: boolean; instrument: Instrument | null }>({
    open: false, instrument: null,
  });

  const handleDelete = async (instrument: Instrument) => {
    const accountNames = [...new Set(instrument.holdings.map((h) => h.account.name))];
    const msg = `Remove "${instrument.primaryTicker}" from Securities? Holdings in ${accountNames.join(", ")} will be unlinked but not deleted.`;
    if (!confirm(msg)) return;
    try {
      await deleteInstrument(instrument.id);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const handleRemoveAlias = async (instrument: Instrument, ticker: string) => {
    if (!confirm(`Remove alias "${ticker}" from ${instrument.primaryTicker}?`)) return;
    try {
      await removeInstrumentTicker(instrument.id, ticker);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove alias");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Securities</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            All unique securities across your investment accounts. Set asset class weights here once and they apply everywhere.
          </p>
        </div>
      </div>

      <Card>
        {instruments && instruments.length > 0 ? (
          <div className="divide-y divide-border">
            {instruments.map((instrument) => {
              const pct = classifiedPct(instrument);
              const isFullyClassified = pct >= 99.9;
              const allTickers = [instrument.primaryTicker, ...instrument.tickers.map((t) => t.ticker)];
              const uniqueAccounts = [...new Map(instrument.holdings.map((h) => [h.account.id, h.account])).values()];

              return (
                <div key={instrument.id} className="px-4 py-4">
                  <div className="flex items-start gap-4">
                    {/* Ticker + name */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{instrument.primaryTicker}</span>
                        {/* Alias tickers */}
                        {instrument.tickers.map((t) => (
                          <span key={t.id} className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {t.ticker}
                            <button
                              onClick={() => handleRemoveAlias(instrument, t.ticker)}
                              className="ml-0.5 hover:text-destructive"
                              title={`Remove alias ${t.ticker}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                      {instrument.name && (
                        <p className="mt-0.5 text-sm text-muted-foreground truncate">{instrument.name}</p>
                      )}

                      {/* Account badges */}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {uniqueAccounts.map((acct) => {
                          // Find ticker(s) this account uses for this instrument
                          const holdingTickers = instrument.holdings
                            .filter((h) => h.account.id === acct.id)
                            .map((h) => h.ticker);
                          const aliasNote =
                            holdingTickers.some((t) => t !== instrument.primaryTicker)
                              ? ` (as ${holdingTickers.filter((t) => t !== instrument.primaryTicker).join(", ")})`
                              : "";
                          return (
                            <span
                              key={acct.id}
                              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white"
                              style={{ backgroundColor: accountBadge(acct.color) }}
                            >
                              {acct.name}{aliasNote}
                            </span>
                          );
                        })}
                      </div>

                      {/* Classification bar */}
                      <div className="mt-2.5 flex items-center gap-2">
                        <div className="h-1.5 w-32 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn("h-full rounded-full transition-all", isFullyClassified ? "bg-green-500" : "bg-primary")}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                        <span className={cn("text-xs", isFullyClassified ? "text-green-600 font-medium" : "text-muted-foreground")}>
                          {isFullyClassified ? "Fully classified" : pct > 0 ? `${pct.toFixed(0)}% classified` : "Unclassified"}
                        </span>
                      </div>

                      {/* Weight pills */}
                      {instrument.weights.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {instrument.weights.map((w) => (
                            <span
                              key={w.id}
                              className="rounded-full px-2 py-0.5 text-xs font-medium"
                              style={{
                                backgroundColor: w.assetClass.color ? `${w.assetClass.color}20` : undefined,
                                color: w.assetClass.color ?? undefined,
                                border: `1px solid ${w.assetClass.color ?? "#e2e8f0"}`,
                              }}
                            >
                              {w.assetClass.name} {parseFloat(w.weight).toFixed(0)}%
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => setWeightsModal({ open: true, instrument })}
                        className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                        title="Edit asset class weights"
                      >
                        Edit weights
                      </button>
                      <button
                        onClick={() => setAliasModal({ open: true, instrument })}
                        className="rounded p-1 hover:bg-accent"
                        title="Add equivalent ticker"
                      >
                        <Link2 className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button
                        onClick={() => setRenameModal({ open: true, instrument })}
                        className="rounded p-1 hover:bg-accent"
                        title="Rename"
                      >
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button
                        onClick={() => handleDelete(instrument)}
                        className="rounded p-1 hover:bg-accent"
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Layers}
            title="No securities yet"
            description="Securities are created automatically when you add holdings to your investment accounts."
          />
        )}
      </Card>

      {/* Weights modal */}
      <WeightsModal
        open={weightsModal.open}
        instrument={weightsModal.instrument}
        assetClasses={assetClasses ?? []}
        onClose={() => setWeightsModal({ open: false, instrument: null })}
        onSave={async (id, weights) => {
          await setInstrumentWeights(id, weights);
          setWeightsModal({ open: false, instrument: null });
          refetch();
        }}
      />

      {/* Alias modal */}
      <AliasModal
        open={aliasModal.open}
        instrument={aliasModal.instrument}
        onClose={() => setAliasModal({ open: false, instrument: null })}
        onSave={async (id, ticker) => {
          await addInstrumentTicker(id, ticker);
          setAliasModal({ open: false, instrument: null });
          refetch();
        }}
      />

      {/* Rename modal */}
      <RenameModal
        open={renameModal.open}
        instrument={renameModal.instrument}
        onClose={() => setRenameModal({ open: false, instrument: null })}
        onSave={async (id, name) => {
          await patchInstrument(id, { name });
          setRenameModal({ open: false, instrument: null });
          refetch();
        }}
      />
    </div>
  );
}

// ── WeightsModal ───────────────────────────────────────────────────────────

interface WeightsModalProps {
  open: boolean;
  instrument: Instrument | null;
  assetClasses: AssetClass[];
  onClose: () => void;
  onSave: (id: string, weights: { assetClassId: string; weight: number }[]) => Promise<void>;
}

function WeightsModal({ open, instrument, assetClasses, onClose, onSave }: WeightsModalProps) {
  const [saving, setSaving] = useState(false);
  const [weights, setWeights] = useState<Record<string, string>>({});

  // Initialise weights from instrument whenever modal opens
  useEffect(() => {
    if (!open || !instrument) return;
    const map: Record<string, string> = {};
    for (const w of instrument.weights) {
      map[w.assetClassId] = parseFloat(w.weight).toString();
    }
    setWeights(map);
  }, [open, instrument]);

  const total = Object.values(weights).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

  const handleSave = async () => {
    if (!instrument) return;
    if (total > 100.01) return;
    setSaving(true);
    try {
      const entries = Object.entries(weights)
        .map(([assetClassId, w]) => ({ assetClassId, weight: parseFloat(w) || 0 }))
        .filter((e) => e.weight > 0);
      await onSave(instrument.id, entries);
    } finally {
      setSaving(false);
    }
  };

  // Leaf-level classes only (children, or top-level with no children)
  const leafClasses = assetClasses.filter(
    (ac) => ac.parentId !== null || !assetClasses.some((c) => c.parentId === ac.id)
  );

  // Group by parent for display
  const parentIds = [...new Set(leafClasses.map((ac) => ac.parentId).filter(Boolean) as string[])];
  const topLevelLeafs = leafClasses.filter((ac) => ac.parentId === null);
  const groups: { parent: AssetClass | null; children: AssetClass[] }[] = [
    ...parentIds.map((pid) => ({
      parent: assetClasses.find((ac) => ac.id === pid) ?? null,
      children: leafClasses.filter((ac) => ac.parentId === pid),
    })),
    ...(topLevelLeafs.length > 0 ? [{ parent: null, children: topLevelLeafs }] : []),
  ].sort((a, b) => (a.parent?.displayOrder ?? 99) - (b.parent?.displayOrder ?? 99));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Asset Class Weights — ${instrument?.primaryTicker ?? ""}`}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Enter the percentage of this security that belongs to each asset class. Total must be ≤ 100%.
        </p>

        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
          {groups.map(({ parent, children }) => (
            <div key={parent?.id ?? "top"}>
              {parent && (
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: parent.color ?? "#e2e8f0" }} />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{parent.name}</span>
                </div>
              )}
              <div className="space-y-1.5 pl-4">
                {children.map((ac) => (
                  <div key={ac.id} className="flex items-center gap-3">
                    <label className="flex-1 text-sm">{ac.name}</label>
                    <div className="relative w-24">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={weights[ac.id] ?? ""}
                        onChange={(e) => setWeights((prev) => ({ ...prev, [ac.id]: e.target.value }))}
                        placeholder="0"
                        className="w-full rounded border border-border px-2 py-1 pr-6 text-right text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Total */}
        <div
          className={cn(
            "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium",
            total > 100.01 ? "bg-destructive/10 text-destructive" : total >= 99.9 ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground"
          )}
        >
          <span>Total</span>
          <span>{total.toFixed(1)}%</span>
        </div>
        {total > 100.01 && (
          <p className="text-xs text-destructive">Total exceeds 100%. Please adjust the weights.</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || total > 100.01}>
            {saving ? "Saving..." : "Save Weights"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── AliasModal ─────────────────────────────────────────────────────────────

interface AliasModalProps {
  open: boolean;
  instrument: Instrument | null;
  onClose: () => void;
  onSave: (id: string, ticker: string) => Promise<void>;
}

function AliasModal({ open, instrument, onClose, onSave }: AliasModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!instrument) return;
    setError(null);
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      await onSave(instrument.id, (form.get("ticker") as string).toUpperCase().trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add alias");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add Equivalent Ticker — ${instrument?.primaryTicker ?? ""}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Add a ticker that tracks the same underlying portfolio (e.g. add VTSAX as an alias for VTI).
          Holdings with this ticker will share the same asset class weights.
        </p>
        <div>
          <label className="mb-1 block text-sm font-medium">Ticker</label>
          <input
            name="ticker"
            type="text"
            required
            className="w-full rounded-md border border-border px-3 py-2 text-sm uppercase focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. VTSAX"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Adding..." : "Add Alias"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── RenameModal ────────────────────────────────────────────────────────────

interface RenameModalProps {
  open: boolean;
  instrument: Instrument | null;
  onClose: () => void;
  onSave: (id: string, name: string | null) => Promise<void>;
}

function RenameModal({ open, instrument, onClose, onSave }: RenameModalProps) {
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!instrument) return;
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const name = (form.get("name") as string).trim();
    try {
      await onSave(instrument.id, name || null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Edit Name — ${instrument?.primaryTicker ?? ""}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Display Name</label>
          <input
            name="name"
            type="text"
            defaultValue={instrument?.name ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Vanguard Total Stock Market"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
