import { useState, useEffect } from "react";
import { Plus, X, ChevronDown, ChevronRight, Tags, TrendingUp, EyeOff, Trash2, Check, Pencil } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getCategories, getFlatCategories, createCategory, updateCategory, deleteCategory, getCategoryUsage } from "@/api";
import type { Category } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel } from "@/components/Typography";

const CATEGORY_COLORS = [
  "#C1121F", "#F94144", "#F3722C", "#F8961E", "#F9844A",
  "#F9C74F", "#EFE233", "#D4A017", "#9B2335", "#E8618C",
  "#90BE6D", "#43AA8B", "#4D908E", "#277DA1", "#577590",
  "#1B4965", "#3D6B8C", "#5E548E", "#9B72CF", "#C77DFF",
];

// ── Category section list ─────────────────────────────────────────────────────

function CategorySection({
  categories,
  expanded,
  onToggleExpand,
  onEdit,
  onAddChild,
}: {
  categories: Category[];
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onEdit: (cat: Category) => void;
  onAddChild: (parentId: string) => void;
}) {
  if (categories.length === 0) {
    return (
      <p className="rounded-xl border border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No categories yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border divide-y divide-border">
      {categories.map((cat) => {
        const isOpen = expanded.has(cat.id);
        const hasChildren = (cat.children?.length ?? 0) > 0;

        return (
          <div key={cat.id}>
            {/* Parent row — tap to expand/collapse */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => hasChildren && onToggleExpand(cat.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hasChildren && onToggleExpand(cat.id); } }}
              className={`flex w-full items-center gap-3 bg-card px-4 py-3 text-left ${hasChildren ? "" : "cursor-default"}`}
            >
              <span className="w-4 shrink-0 text-muted-foreground">
                {hasChildren ? (
                  isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
                ) : null}
              </span>
              <span
                className="h-7 w-7 shrink-0 rounded-md"
                style={cat.color ? { backgroundColor: cat.color } : undefined}
              />
              <span className="flex-1 text-sm font-medium">{cat.name}</span>
              {cat.ignoreInBudget && <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
              {hasChildren && (
                <span className="tp-caption">{cat.children!.length}</span>
              )}
              <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => onAddChild(cat.id)}
                  className="rounded p-1.5 hover:bg-accent"
                  aria-label="Add subcategory"
                >
                  <Plus className="h-4 w-4 text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(cat)}
                  className="rounded pl-1.5 py-1.5 hover:bg-accent"
                  aria-label="Edit category"
                >
                  <Pencil className="h-4 w-4 text-muted-foreground/40" />
                </button>
              </span>
            </div>

            {/* Children — tap to edit */}
            {isOpen && hasChildren && (
              <div className="divide-y divide-border border-t border-border bg-muted/30">
                {cat.children!.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onEdit(child)}
                    className="flex w-full items-center gap-3 py-2.5 pl-12 pr-4 text-left hover:bg-muted/50"
                  >
                    <span className="flex-1 text-sm">{child.name}</span>
                    {child.ignoreInBudget && <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
                    <Pencil className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MobileCategories() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [modalKind, setModalKind] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: categories, refetch } = useApi(() => getCategories(), []);
  const { data: flatCategories, refetch: refetchFlat } = useApi(() => getFlatCategories(), []);

  const expenseCategories = (categories ?? []).filter((c) => c.kind === "EXPENSE");
  const incomeCategories = (categories ?? []).filter((c) => c.kind === "INCOME");

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const openAdd = () => {
    setEditing(null);
    setParentId(undefined);
    setModalKind("EXPENSE");
    setModalOpen(true);
  };

  const openAddChild = (pid: string, kind: "EXPENSE" | "INCOME") => {
    setEditing(null);
    setParentId(pid);
    setModalKind(kind);
    setModalOpen(true);
  };

  const openEdit = (cat: Category) => {
    setEditing(cat);
    setParentId(cat.parentId ?? undefined);
    setModalKind(cat.kind);
    setModalOpen(true);
  };

  const handleSave = async (data: Partial<Category>) => {
    if (editing) {
      await updateCategory(editing.id, data);
    } else {
      await createCategory({ ...data, kind: modalKind });
    }
    setModalOpen(false);
    setEditing(null);
    setParentId(undefined);
    refetch();
    refetchFlat();
  };

  const handleDelete = async (reassignTo?: string) => {
    if (!editing) return;
    await deleteCategory(editing.id, reassignTo);
    setModalOpen(false);
    setEditing(null);
    setParentId(undefined);
    refetch();
    refetchFlat();
  };

  if (!categories) return <BeaconLoader />;

  return (
    <>
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="tp-page-title">Categories</h1>
          <button
            type="button"
            onClick={openAdd}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>

        {/* Expense */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <SectionLabel as="h2" className="flex items-center gap-2">
              <Tags className="h-3.5 w-3.5" /> Expense
            </SectionLabel>
          </div>
          <CategorySection
            categories={expenseCategories}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onEdit={openEdit}
            onAddChild={(id) => openAddChild(id, "EXPENSE")}
          />
        </div>

        {/* Income */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <SectionLabel as="h2" className="flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5" /> Income
            </SectionLabel>
          </div>
          <CategorySection
            categories={incomeCategories}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onEdit={openEdit}
            onAddChild={(id) => openAddChild(id, "INCOME")}
          />
        </div>
      </div>

      {modalOpen && (
        <MobileCategoryModal
          category={editing}
          parentId={parentId}
          kind={modalKind}
          allFlatCategories={flatCategories ?? []}
          onClose={() => { setModalOpen(false); setEditing(null); setParentId(undefined); }}
          onSave={handleSave}
          onDelete={editing ? handleDelete : undefined}
        />
      )}
    </>
  );
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────

function MobileCategoryModal({
  category,
  parentId,
  kind,
  allFlatCategories,
  onClose,
  onSave,
  onDelete,
}: {
  category: Category | null;
  parentId?: string;
  kind: "EXPENSE" | "INCOME";
  allFlatCategories: Category[];
  onClose: () => void;
  onSave: (data: Partial<Category>) => Promise<void>;
  onDelete?: (reassignTo?: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedColor, setSelectedColor] = useState(category?.color ?? CATEGORY_COLORS[0]);
  const [ignoreInBudget, setIgnoreInBudget] = useState(category?.ignoreInBudget ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [fetchingUsage, setFetchingUsage] = useState(false);
  const [usageInfo, setUsageInfo] = useState<{ count: number; categoryIds: string[] } | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [selectedKind, setSelectedKind] = useState<"EXPENSE" | "INCOME">(kind);

  const isTopLevelAdd = !category && !parentId;
  const kindLabel = selectedKind === "INCOME" ? "Income " : "";
  const title = category
    ? `Edit ${kindLabel}Category`
    : parentId
    ? `Add ${kindLabel}Subcategory`
    : "Add Category";

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      name: form.get("name") as string,
      color: selectedColor,
      ignoreInBudget,
      parentId,
      kind: selectedKind,
    } as Partial<Category>);
    setSaving(false);
  };

  const handleDeleteClick = async () => {
    setFetchingUsage(true);
    const usage = await getCategoryUsage(category!.id);
    setUsageInfo(usage);
    setFetchingUsage(false);
    setConfirmDelete(true);
  };

  // ── Confirm-delete screen ──
  if (confirmDelete && usageInfo !== null) {
    const recordLabel = kind === "INCOME" ? "income records" : "expenses";
    const eligible = allFlatCategories.filter(
      (c) => !usageInfo.categoryIds.includes(c.id) && c.kind === kind
    );
    const parents = eligible.filter((c) => !c.parentId);
    const children = eligible.filter((c) => c.parentId);

    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-background">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="tp-panel-title">Delete Category</h2>
          <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
          <p className="text-sm">
            Are you sure you want to delete <strong>{category!.name}</strong>
            {category!.children && category!.children.length > 0 && (
              <> and its {category!.children.length} subcategories</>
            )}?
          </p>
          {usageInfo.count > 0 ? (
            <div className="space-y-3 rounded-md border border-warn-line bg-warn-soft p-3">
              <p className="text-sm text-warn-deep">
                {usageInfo.count} {recordLabel} use this category. Reassign them or leave uncategorized.
              </p>
              <div className="relative">
                <select
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                  className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground bg-background"
                >
                  <option value="">Leave uncategorized</option>
                  {parents.map((parent) => {
                    const kids = children.filter((c) => c.parentId === parent.id);
                    if (kids.length === 0) return <option key={parent.id} value={parent.id}>{parent.name}</option>;
                    return (
                      <optgroup key={parent.id} label={parent.name}>
                        {kids.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
                      </optgroup>
                    );
                  })}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No {recordLabel} use this category.</p>
          )}
        </div>
        <div className="shrink-0 border-t border-border p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                await onDelete!(reassignTo || undefined);
                setDeleting(false);
              }}
              className="flex-1 rounded-md bg-down py-2.5 text-sm font-medium text-white disabled:opacity-50 transition-opacity"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main form ──
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="tp-panel-title">{title}</h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <form id="mobile-category-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-5 p-4">

          {isTopLevelAdd && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Type</label>
              <div className="relative">
                <select
                  value={selectedKind}
                  onChange={(e) => setSelectedKind(e.target.value as "EXPENSE" | "INCOME")}
                  className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground"
                >
                  <option value="EXPENSE">Expense</option>
                  <option value="INCOME">Income</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium">Name</label>
            <input
              name="name"
              type="text"
              required
              defaultValue={category?.name ?? ""}
              placeholder="Category name"
              className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          {!parentId && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Color</label>
              <div className="grid grid-cols-10 gap-2">
                {CATEGORY_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setSelectedColor(color)}
                    style={{ backgroundColor: color }}
                    className={`aspect-square w-full rounded-md transition-transform ${
                      selectedColor === color ? "scale-110 ring-2 ring-border ring-offset-1" : ""
                    }`}
                  />
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setIgnoreInBudget((v) => !v)}
            className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
              ignoreInBudget ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
              ignoreInBudget ? "border-primary bg-primary" : "border-border"
            }`}>
              {ignoreInBudget && <Check className="h-3 w-3 text-white" />}
            </span>
            <span className={ignoreInBudget ? "text-primary" : ""}>Ignore in budget</span>
          </button>

        </div>
      </form>

      <div className="shrink-0 border-t border-border p-4">
        <div className="flex gap-3">
          {onDelete && (
            <button
              type="button"
              disabled={fetchingUsage}
              onClick={handleDeleteClick}
              className="rounded-md border border-border p-2.5 text-muted-foreground hover:border-down hover:text-down transition-colors disabled:opacity-50"
              aria-label="Delete category"
            >
              <Trash2 className="h-4 w-4" />
            </button>
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
            form="mobile-category-form"
            disabled={saving}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            {saving ? "Saving…" : category ? "Save Changes" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
