import { useState, useEffect } from "react";
import { Plus, X, ChevronDown, ChevronRight, PieChart, Target, Trash2, Pencil } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getAssetClasses, createAssetClass, updateAssetClass, deleteAssetClass, setAssetClassTarget, deleteAssetClassTarget } from "@/api";
import type { AssetClass } from "@/types";
import { cn } from "@/lib/utils";
import { BeaconLoader } from "@/components/BeaconLoader";

const PRESET_COLORS = [
  "#0891b2", "#059669", "#16a34a",
  "#d97706", "#dc2626", "#7c3aed", "#db2777",
  "#6b7280", "#0284c7", "#65a30d",
];

// ── Helpers (mirrored from desktop) ──────────────────────────────────────────

function effectiveTarget(ac: AssetClass): number | null {
  const children = ac.children ?? [];
  const childrenWithTargets = children.filter((c) => c.target != null);
  if (children.length > 0 && childrenWithTargets.length > 0) {
    return childrenWithTargets.reduce((sum, c) => sum + parseFloat(c.target!.targetPct), 0);
  }
  return ac.target ? parseFloat(ac.target.targetPct) : null;
}

function isDerived(ac: AssetClass): boolean {
  const children = ac.children ?? [];
  return children.length > 0 && children.some((c) => c.target != null);
}

function totalLeafTarget(classes: AssetClass[]): number {
  return classes.reduce((sum, c) => sum + (effectiveTarget(c) ?? 0), 0);
}

function countWithTargets(classes: AssetClass[]): number {
  return classes.filter((c) => effectiveTarget(c) != null).length;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MobileAssetClasses() {
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
      const created = await createAssetClass({ ...data, parentId: modalState.parentId });
      if (modalState.parentId) {
        setExpandedIds((prev) => new Set([...prev, modalState.parentId!]));
      } else {
        setExpandedIds((prev) => new Set([...prev, (created as AssetClass).id]));
      }
    }
    closeModal();
    refetch();
  };

  const handleDelete = async (id: string) => {
    await deleteAssetClass(id);
    closeModal();
    refetch();
  };

  if (!assetClasses) return <BeaconLoader />;

  const leafTotal = totalLeafTarget(assetClasses);
  const anyTargetSet = countWithTargets(assetClasses) > 0;

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="tp-page-title">Asset Classes</h1>
          <button
            type="button"
            onClick={() => openAdd(null)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>

        {/* Target summary banner */}
        {assetClasses.length > 0 && anyTargetSet && (
          <div className={cn(
            "flex items-center gap-3 rounded-lg border px-4 py-3 text-sm",
            Math.abs(leafTotal - 100) < 0.1
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          )}>
            <Target className="h-4 w-4 shrink-0" />
            <span>
              Targets sum to <strong>{leafTotal.toFixed(1)}%</strong>
              {Math.abs(leafTotal - 100) < 0.1
                ? " — fully allocated!"
                : leafTotal < 100
                ? ` — ${(100 - leafTotal).toFixed(1)}% unallocated`
                : ` — ${(leafTotal - 100).toFixed(1)}% over-allocated`}
            </span>
          </div>
        )}

        {assetClasses.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
            <PieChart className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No asset classes yet</p>
            <p className="mt-1 tp-caption">Define a target allocation and color-code each class for charts.</p>
            <button
              type="button"
              onClick={() => openAdd(null)}
              className="mt-4 mx-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              <Plus className="h-4 w-4" /> Add Class
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border divide-y divide-border">
            {assetClasses.map((topClass) => {
              const expanded = expandedIds.has(topClass.id);
              const hasChildren = (topClass.children?.length ?? 0) > 0;
              const derived = isDerived(topClass) ? effectiveTarget(topClass) : undefined;
              const displayTarget = derived !== undefined ? derived : (topClass.target ? parseFloat(topClass.target.targetPct) : null);

              return (
                <div key={topClass.id}>
                  {/* Parent row — tap to expand/collapse */}
                  <div
                    onClick={() => hasChildren && toggleExpand(topClass.id)}
                    className={`flex w-full items-center gap-3 bg-card px-4 py-3 text-left ${hasChildren ? "cursor-pointer" : ""}`}
                  >
                    <span className="w-4 shrink-0 text-muted-foreground">
                      {hasChildren
                        ? expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
                        : null}
                    </span>
                    <span
                      className="h-7 w-7 shrink-0 rounded-md"
                      style={{ backgroundColor: topClass.color ?? "#e2e8f0" }}
                    />
                    <span className="flex-1 text-sm font-medium truncate">{topClass.name}</span>
                    <span className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      derived !== undefined
                        ? "bg-muted text-muted-foreground"
                        : displayTarget != null
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground"
                    )}>
                      {displayTarget != null ? `${displayTarget.toFixed(1)}%` : "—"}
                      {derived !== undefined && <span className="ml-0.5 opacity-60">∑</span>}
                    </span>
                    <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => { openAdd(topClass.id); setExpandedIds((p) => new Set([...p, topClass.id])); }}
                        className="rounded p-1.5 hover:bg-accent"
                        aria-label="Add sub-class"
                      >
                        <Plus className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(topClass)}
                        className="rounded pl-1.5 py-1.5 hover:bg-accent"
                        aria-label="Edit"
                      >
                        <Pencil className="h-4 w-4 text-muted-foreground/40" />
                      </button>
                    </span>
                  </div>

                  {/* Children — tap to edit */}
                  {expanded && hasChildren && (
                    <div className="divide-y divide-border border-t border-border bg-muted/30">
                      {topClass.children!.map((child) => {
                        const childTarget = child.target ? parseFloat(child.target.targetPct) : null;
                        return (
                          <button
                            key={child.id}
                            type="button"
                            onClick={() => openEdit(child)}
                            className="flex w-full items-center gap-3 py-2.5 pl-12 pr-4 text-left hover:bg-muted/50"
                          >
                            <span className="flex-1 text-sm truncate">{child.name}</span>
                            <span className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                              childTarget != null ? "bg-primary/10 text-primary" : "text-muted-foreground"
                            )}>
                              {childTarget != null ? `${childTarget.toFixed(1)}%` : "—"}
                            </span>
                            <Pencil className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modalState.open && (
        <MobileAssetClassModal
          editing={modalState.editing}
          isChild={modalState.parentId !== null}
          onClose={closeModal}
          onSave={handleSave}
          onDelete={modalState.editing && !modalState.editing.isSystem ? handleDelete : undefined}
        />
      )}
    </>
  );
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────

function MobileAssetClassModal({
  editing,
  isChild,
  onClose,
  onSave,
  onDelete,
}: {
  editing: AssetClass | null;
  isChild: boolean;
  onClose: () => void;
  onSave: (data: { name?: string; color?: string | null; targetPct?: number | null }) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [color, setColor] = useState(editing?.color ?? PRESET_COLORS[0]);

  const derivedVal = editing && isDerived(editing) ? effectiveTarget(editing) : undefined;
  const showDerivedTarget = editing !== null && derivedVal !== undefined;
  const showTargetInput = editing !== null && derivedVal === undefined;
  const currentTarget = editing?.target ? parseFloat(editing.target.targetPct) : null;

  const title = editing
    ? `Edit "${editing.name}"`
    : isChild ? "Add Sub-Class" : "Add Asset Class";

  // Lock body scroll while open
  useEffect(() => {
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
  }, []);

  useEffect(() => {
    setColor(editing?.color ?? PRESET_COLORS[0]);
    setConfirmDelete(false);
  }, [editing]);

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

  // ── Main form ──
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <h2 className="tp-panel-title">{title}</h2>
          {editing?.isSystem && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              built-in
            </span>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <form id="mobile-asset-class-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-5 p-4">

          {/* Name — hidden for system classes */}
          {(!editing || !editing.isSystem) && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Name</label>
              <input
                name="name"
                type="text"
                required
                defaultValue={editing?.name ?? ""}
                placeholder={isChild ? "e.g. Large Cap" : "e.g. Alternatives"}
                className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
              />
            </div>
          )}

          {/* Target — derived (read-only) */}
          {showDerivedTarget && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Target Allocation</label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
                <span>{derivedVal != null ? `${derivedVal.toFixed(1)}%` : "—"}</span>
                <span className="opacity-60">∑ derived from sub-classes</span>
              </div>
            </div>
          )}

          {/* Target — editable */}
          {showTargetInput && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Target Allocation</label>
              <p className="mb-2 tp-caption">Percentage of your portfolio to allocate here. Leave blank to remove.</p>
              <div className="relative">
                <input
                  name="targetPct"
                  type="text"
                  inputMode="decimal"
                  defaultValue={currentTarget ?? ""}
                  placeholder="e.g. 40"
                  className="w-full rounded-md border border-border px-3 py-2.5 pr-8 text-sm focus:border-primary focus:outline-none"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
              </div>
            </div>
          )}

          {/* Color — top-level only */}
          {!isChild && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Color</label>
              <div className="grid grid-cols-10 gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    style={{ backgroundColor: c }}
                    className={`aspect-square w-full rounded-md transition-transform hover:scale-110 ${
                      color === c ? "scale-110 ring-2 ring-border ring-offset-1" : ""
                    }`}
                  />
                ))}
              </div>
            </div>
          )}

        </div>
      </form>

      <div className="shrink-0 border-t border-border p-4">
        <div className="flex gap-3">
          {onDelete && (
            confirmDelete ? (
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  await onDelete!(editing!.id);
                  setDeleting(false);
                }}
                className="rounded-md bg-destructive px-3 py-2.5 text-sm font-medium text-destructive-foreground disabled:opacity-50 transition-colors"
              >
                {deleting ? "Deleting…" : "Confirm?"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-border p-2.5 text-muted-foreground hover:border-destructive hover:text-destructive transition-colors"
                aria-label="Delete asset class"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="mobile-asset-class-form"
            disabled={saving}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            {saving ? "Saving…" : editing ? "Save Changes" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
