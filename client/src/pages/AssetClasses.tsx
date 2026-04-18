import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, ChevronRight, ChevronDown, Target, PieChart } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import {
  getAssetClasses,
  createAssetClass,
  updateAssetClass,
  deleteAssetClass,
  setAssetClassTarget,
  deleteAssetClassTarget,
} from "@/api";
import type { AssetClass } from "@/types";
import { cn } from "@/lib/utils";

const PRESET_COLORS = [
  "#4f46e5", "#0891b2", "#059669", "#16a34a",
  "#d97706", "#dc2626", "#7c3aed", "#db2777",
  "#6b7280", "#0284c7", "#65a30d", "#ea580c",
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * For a top-level class, the effective target is derived from its children
 * whenever at least one child has a target set. Otherwise it falls back to
 * the class's own directly-stored target.
 */
function effectiveTarget(ac: AssetClass): number | null {
  const children = ac.children ?? [];
  const childrenWithTargets = children.filter((c) => c.target != null);
  if (children.length > 0 && childrenWithTargets.length > 0) {
    return childrenWithTargets.reduce((sum, c) => sum + parseFloat(c.target!.targetPct), 0);
  }
  return ac.target ? parseFloat(ac.target.targetPct) : null;
}

/** True when the parent's displayed target comes from summing its children. */
function isDerived(ac: AssetClass): boolean {
  const children = ac.children ?? [];
  return children.length > 0 && children.some((c) => c.target != null);
}

/** Total of all effective leaf-level targets (used for the summary banner). */
function totalLeafTarget(classes: AssetClass[]): number {
  return classes.reduce((sum, c) => sum + (effectiveTarget(c) ?? 0), 0);
}

/** Number of top-level classes that have any effective target. */
function countWithTargets(classes: AssetClass[]): number {
  return classes.filter((c) => effectiveTarget(c) != null).length;
}

// ── Main page ──────────────────────────────────────────────────────────────

export function AssetClassesPage() {
  const { data: assetClasses, refetch } = useApi(() => getAssetClasses(), []);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [modalState, setModalState] = useState<{
    open: boolean;
    editing: AssetClass | null;
    parentId: string | null;
  }>({ open: false, editing: null, parentId: null });
  const [targetModal, setTargetModal] = useState<{ open: boolean; assetClass: AssetClass | null }>({
    open: false,
    assetClass: null,
  });

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const openAdd = (parentId: string | null = null) => {
    setModalState({ open: true, editing: null, parentId });
  };

  const openEdit = (ac: AssetClass) => {
    setModalState({ open: true, editing: ac, parentId: ac.parentId });
  };

  const closeModal = () => setModalState({ open: false, editing: null, parentId: null });

  const handleSave = async (data: { name?: string; color?: string | null }) => {
    if (modalState.editing) {
      await updateAssetClass(modalState.editing.id, data);
    } else {
      const created = await createAssetClass({ ...data, parentId: modalState.parentId });
      // Auto-expand parent if adding a child
      if (modalState.parentId) {
        setExpandedIds((prev) => new Set([...prev, modalState.parentId!]));
      }
      // Auto-expand new top-level class
      if (!modalState.parentId) {
        setExpandedIds((prev) => new Set([...prev, (created as AssetClass).id]));
      }
    }
    closeModal();
    refetch();
  };

  const handleDelete = async (ac: AssetClass) => {
    const msg = ac.children?.length
      ? `"${ac.name}" has sub-classes. Delete those first.`
      : `Delete "${ac.name}"? This will remove it from any instrument allocations.`;
    if (ac.children?.length) { alert(msg); return; }
    if (!confirm(msg)) return;
    try {
      await deleteAssetClass(ac.id);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const handleSetTarget = async (ac: AssetClass, pct: number | null) => {
    if (pct === null) {
      await deleteAssetClassTarget(ac.id);
    } else {
      await setAssetClassTarget(ac.id, pct);
    }
    setTargetModal({ open: false, assetClass: null });
    refetch();
  };

  const leafTotal = assetClasses ? totalLeafTarget(assetClasses) : 0;
  const anyTargetSet = assetClasses ? countWithTargets(assetClasses) > 0 : false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Asset Classes</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Define your target allocation and color-code each class for charts.
          </p>
        </div>
        <Button onClick={() => openAdd(null)}>
          <Plus className="h-4 w-4" /> Add Class
        </Button>
      </div>

      {/* Target summary banner */}
      {assetClasses && assetClasses.length > 0 && anyTargetSet && (
        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border px-4 py-3 text-sm",
            Math.abs(leafTotal - 100) < 0.1
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          )}
        >
          <Target className="h-4 w-4 shrink-0" />
          <span>
            Target allocations sum to{" "}
            <strong>{leafTotal.toFixed(1)}%</strong>
            {Math.abs(leafTotal - 100) < 0.1
              ? " — fully allocated!"
              : leafTotal < 100
              ? ` — ${(100 - leafTotal).toFixed(1)}% unallocated`
              : ` — ${(leafTotal - 100).toFixed(1)}% over-allocated`}
          </span>
        </div>
      )}

      {assetClasses && assetClasses.length > 0 ? (
        <Card className="divide-y divide-border p-0">
          {assetClasses.map((topClass) => {
            const expanded = expandedIds.has(topClass.id);
            const hasChildren = (topClass.children?.length ?? 0) > 0;
            const derived = isDerived(topClass) ? effectiveTarget(topClass) : undefined;
            return (
              <div key={topClass.id}>
                {/* Top-level row */}
                <AssetClassRow
                  assetClass={topClass}
                  isChild={false}
                  expanded={expanded}
                  hasChildren={hasChildren}
                  derivedTarget={derived}
                  onToggle={() => toggleExpand(topClass.id)}
                  onEdit={() => openEdit(topClass)}
                  onDelete={() => handleDelete(topClass)}
                  onSetTarget={() => setTargetModal({ open: true, assetClass: topClass })}
                  onAddChild={() => { openAdd(topClass.id); setExpandedIds((p) => new Set([...p, topClass.id])); }}
                />
                {/* Children */}
                {expanded && topClass.children?.map((child) => (
                  <AssetClassRow
                    key={child.id}
                    assetClass={child}
                    isChild={true}
                    expanded={false}
                    hasChildren={false}
                    onToggle={() => {}}
                    onEdit={() => openEdit(child)}
                    onDelete={() => handleDelete(child)}
                    onSetTarget={() => setTargetModal({ open: true, assetClass: child })}
                    onAddChild={() => {}}
                  />
                ))}
              </div>
            );
          })}
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={PieChart}
            title="No asset classes yet"
            description="Asset classes help you define a target allocation and track how your portfolio compares."
            action={
              <Button onClick={() => openAdd(null)}>
                <Plus className="h-4 w-4" /> Add Class
              </Button>
            }
          />
        </Card>
      )}

      <AssetClassModal
        open={modalState.open}
        onClose={closeModal}
        onSave={handleSave}
        editing={modalState.editing}
        isChild={modalState.parentId !== null}
      />

      <TargetModal
        open={targetModal.open}
        assetClass={targetModal.assetClass}
        onClose={() => setTargetModal({ open: false, assetClass: null })}
        onSave={handleSetTarget}
      />
    </div>
  );
}

// ── AssetClassRow ──────────────────────────────────────────────────────────

interface RowProps {
  assetClass: AssetClass;
  isChild: boolean;
  expanded: boolean;
  hasChildren: boolean;
  /** When set, this parent's target is derived from children — shown read-only. */
  derivedTarget?: number | null;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetTarget: () => void;
  onAddChild: () => void;
}

function AssetClassRow({
  assetClass,
  isChild,
  expanded,
  hasChildren,
  derivedTarget,
  onToggle,
  onEdit,
  onDelete,
  onSetTarget,
  onAddChild,
}: RowProps) {
  const ownTarget = assetClass.target ? parseFloat(assetClass.target.targetPct) : null;
  // derivedTarget is defined (even if null) when the row is a parent with child targets
  const isTargetDerived = derivedTarget !== undefined;
  const displayTarget = isTargetDerived ? derivedTarget : ownTarget;

  return (
    <div className={cn("flex items-center gap-3 py-3", isChild ? "pl-10 pr-3" : "px-3")}>
      {/* Expand toggle (top-level only) */}
      {!isChild && (
        <button
          onClick={onToggle}
          className={`rounded p-0.5 ${hasChildren ? "hover:bg-accent" : ""}`}
          disabled={!hasChildren}
        >
          {hasChildren ? (
            expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
          ) : (
            <span className="inline-block h-4 w-4" />
          )}
        </button>
      )}

      {/* Color swatch (top-level only; children inherit) */}
      {!isChild && (
        <div
          className="h-7 w-7 shrink-0 rounded-md"
          style={{ backgroundColor: assetClass.color ?? "#e2e8f0" }}
        />
      )}

      {/* Name + system badge */}
      <div className="flex flex-1 items-center gap-2 min-w-0">
        <span className={cn("truncate", isChild ? "text-sm" : "font-medium")}>{assetClass.name}</span>
        {assetClass.isSystem && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            built-in
          </span>
        )}
      </div>

      {/* Target badge — read-only derived vs. editable */}
      {isTargetDerived ? (
        <span
          className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
          title="Derived from sub-class targets"
        >
          {displayTarget != null ? `${displayTarget.toFixed(1)}%` : "—"}
          <span className="ml-1 opacity-60">∑</span>
        </span>
      ) : (
        <button
          onClick={onSetTarget}
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
            displayTarget != null
              ? "bg-primary/10 text-primary hover:bg-primary/20"
              : "border border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"
          )}
          title="Set target allocation"
        >
          {displayTarget != null ? `${displayTarget.toFixed(1)}%` : "Set target"}
        </button>
      )}

      {/* Action buttons */}
      <div className="flex shrink-0 gap-0.5">
        {!isChild && (
          <button
            onClick={onAddChild}
            className="rounded p-1 hover:bg-accent"
            title="Add sub-class"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
        <button onClick={onEdit} className="rounded p-1 hover:bg-accent" title="Edit">
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        {!assetClass.isSystem && (
          <button onClick={onDelete} className="rounded p-1 hover:bg-accent" title="Delete">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── AssetClassModal ────────────────────────────────────────────────────────

interface AssetClassModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name?: string; color?: string | null }) => Promise<void>;
  editing: AssetClass | null;
  isChild: boolean;
}

function AssetClassModal({ open, onClose, onSave, editing, isChild }: AssetClassModalProps) {
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState<string>(editing?.color ?? PRESET_COLORS[0]);

  useEffect(() => {
    if (open) {
      setColor(editing?.color ?? PRESET_COLORS[0]);
    }
  }, [open, editing]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      const name = form.get("name") as string | null;
      await onSave({ ...(name != null ? { name } : {}), color });
    } finally {
      setSaving(false);
    }
  };

  const title = editing
    ? `Edit ${editing.isSystem ? "Color for " : ""}"${editing.name}"`
    : isChild
    ? "Add Sub-Class"
    : "Add Asset Class";

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name — hidden for system class (can only change color) */}
        {(!editing || !editing.isSystem) && (
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              name="name"
              type="text"
              required
              defaultValue={editing?.name ?? ""}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={isChild ? "e.g. Large Cap" : "e.g. Alternatives"}
            />
          </div>
        )}

        {!isChild && (
          <div>
            <label className="mb-2 block text-sm font-medium">Color</label>
            <div className="grid w-fit grid-cols-6 gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{ backgroundColor: c }}
                  className={`h-7 w-7 rounded-md transition-transform hover:scale-110 ${
                    color === c ? "scale-110 ring-2 ring-border ring-offset-1" : ""
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : editing ? "Update" : "Add"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── TargetModal ────────────────────────────────────────────────────────────

interface TargetModalProps {
  open: boolean;
  assetClass: AssetClass | null;
  onClose: () => void;
  onSave: (ac: AssetClass, pct: number | null) => Promise<void>;
}

function TargetModal({ open, assetClass, onClose, onSave }: TargetModalProps) {
  const [saving, setSaving] = useState(false);
  const current = assetClass?.target ? parseFloat(assetClass.target.targetPct) : null;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!assetClass) return;
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const raw = form.get("targetPct") as string;
    try {
      await onSave(assetClass, raw === "" ? null : parseFloat(raw));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Target for ${assetClass?.name ?? ""}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Set the percentage of your portfolio you want allocated to this asset class.
          Leave blank to remove the target.
        </p>
        <div>
          <label className="mb-1 block text-sm font-medium">Target %</label>
          <div className="relative">
            <input
              name="targetPct"
              type="number"
              min={0}
              max={100}
              step={0.1}
              defaultValue={current ?? ""}
              placeholder="e.g. 40"
              className="w-full rounded-md border border-border px-3 py-2 pr-8 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>
        <div className="flex justify-between gap-2 pt-2">
          <div>
            {current != null && (
              <Button
                type="button"
                variant="secondary"
                onClick={async () => { if (!assetClass) return; setSaving(true); await onSave(assetClass, null); setSaving(false); }}
                disabled={saving}
              >
                Remove target
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Set Target"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
