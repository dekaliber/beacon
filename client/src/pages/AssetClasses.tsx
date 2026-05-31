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
import { BeaconLoader } from "@/components/BeaconLoader";

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

  const handleSave = async (data: { name?: string; color?: string | null; targetPct?: number | null }) => {
    if (modalState.editing) {
      await updateAssetClass(modalState.editing.id, { name: data.name, color: data.color });
      if ("targetPct" in data) {
        if (data.targetPct === null) {
          await deleteAssetClassTarget(modalState.editing.id);
        } else {
          await setAssetClassTarget(modalState.editing.id, data.targetPct!);
        }
      }
    } else {
      const created = await createAssetClass({ ...data, name: data.name!, parentId: modalState.parentId });
      if (modalState.parentId) {
        setExpandedIds((prev) => new Set([...prev, modalState.parentId!]));
      }
      if (!modalState.parentId) {
        setExpandedIds((prev) => new Set([...prev, (created as AssetClass).id]));
      }
    }
    closeModal();
    refetch();
  };

  const handleDelete = async (ac: AssetClass) => {
    if (ac.children?.length) {
      alert(`"${ac.name}" has sub-classes. Delete those first.`);
      return;
    }
    try {
      await deleteAssetClass(ac.id);
      closeModal();
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  if (!assetClasses) return <BeaconLoader />;

  const leafTotal = totalLeafTarget(assetClasses);
  const anyTargetSet = countWithTargets(assetClasses) > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="tp-page-title">Asset Classes</h2>
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
              ? "border-up-line bg-up-soft text-up-deep"
              : "border-warn-line bg-warn-soft text-warn-deep"
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
        onDelete={handleDelete}
        editing={modalState.editing}
        isChild={modalState.parentId !== null}
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
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-10 font-medium text-muted-foreground">
            built-in
          </span>
        )}
      </div>

      {/* Target badge — always read-only */}
      {isTargetDerived ? (
        <span
          className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
          title="Derived from sub-class targets"
        >
          {displayTarget != null ? `${displayTarget.toFixed(1)}%` : "—"}
          <span className="ml-1 opacity-60">∑</span>
        </span>
      ) : (
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
            displayTarget != null
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground"
          )}
        >
          {displayTarget != null ? `${displayTarget.toFixed(1)}%` : "—"}
        </span>
      )}

      {/* Action buttons */}
      <div className="flex shrink-0 gap-0.5">
        {!isChild && (
          <button
            onClick={onAddChild}
            className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
            title="Add sub-class"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={onEdit} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors" title="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── AssetClassModal ────────────────────────────────────────────────────────

interface AssetClassModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name?: string; color?: string | null; targetPct?: number | null }) => Promise<void>;
  onDelete: (ac: AssetClass) => Promise<void>;
  editing: AssetClass | null;
  isChild: boolean;
}

function AssetClassModal({ open, onClose, onSave, onDelete, editing, isChild }: AssetClassModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [color, setColor] = useState<string>(editing?.color ?? PRESET_COLORS[0]);

  useEffect(() => {
    if (open) {
      setColor(editing?.color ?? PRESET_COLORS[0]);
      setConfirmDelete(false);
    }
  }, [open, editing]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      const name = form.get("name") as string | null;
      const rawTarget = form.get("targetPct") as string | null;
      const targetData: { targetPct?: number | null } = {};
      if (rawTarget !== null) {
        targetData.targetPct = rawTarget === "" ? null : parseFloat(rawTarget);
      }
      await onSave({ ...(name != null ? { name } : {}), color, ...targetData });
    } finally {
      setSaving(false);
    }
  };

  const title = editing ? `Edit "${editing.name}"` : isChild ? "Add Sub-Class" : "Add Asset Class";

  const derivedVal = editing && isDerived(editing) ? effectiveTarget(editing) : undefined;
  const showDerivedTarget = editing !== null && derivedVal !== undefined;
  const showTargetInput = editing !== null && derivedVal === undefined;
  const currentTarget = editing?.target ? parseFloat(editing.target.targetPct) : null;

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name — hidden for system class (can only change color) */}
        {(!editing || !editing.isSystem) && (
          <div>
            <label className="block text-xs font-medium mb-1">Name</label>
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

        {showDerivedTarget && (
          <div>
            <label className="block text-xs font-medium mb-1">Target Allocation</label>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              <span>{derivedVal != null ? `${derivedVal.toFixed(1)}%` : "—"}</span>
              <span className="opacity-60">∑ derived from sub-classes</span>
            </div>
          </div>
        )}

        {showTargetInput && (
          <div>
            <label className="block text-xs font-medium mb-1">Target Allocation</label>
            <p className="mb-2 tp-caption">
              Percentage of your portfolio to allocate here. Leave blank to remove.
            </p>
            <div className="relative">
              <input
                name="targetPct"
                type="text"
                inputMode="decimal"
                defaultValue={currentTarget ?? ""}
                placeholder="e.g. 40"
                className="w-full rounded-md border border-border px-3 py-2 pr-8 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
        )}

        {!isChild && (
          <div>
            <label className="block text-xs font-medium mb-2">Color</label>
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

        <div className="flex justify-between gap-2 pt-2">
          <div>
            {editing && !editing.isSystem && (
              <button
                type="button"
                onClick={async () => {
                  if (!confirmDelete) { setConfirmDelete(true); return; }
                  setDeleting(true);
                  await onDelete(editing);
                  setDeleting(false);
                }}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-down hover:bg-down/10 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting..." : confirmDelete ? "Confirm Delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : editing ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

