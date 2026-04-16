import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Tags, TrendingUp, ChevronDown, ChevronRight, EyeOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getCategories, getFlatCategories, createCategory, updateCategory, deleteCategory, getCategoryUsage } from "@/api";
import type { Category } from "@/types";

export function Categories() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [modalKind, setModalKind] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteModal, setDeleteModal] = useState<{ category: Category; usageCount: number; categoryIds: string[] } | null>(null);

  const { data: categories, refetch } = useApi(() => getCategories(), []);
  const { data: flatCategories, refetch: refetchFlat } = useApi(() => getFlatCategories(), []);

  const expenseCategories = (categories ?? []).filter((c) => c.kind === "EXPENSE");
  const incomeCategories = (categories ?? []).filter((c) => c.kind === "INCOME");

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openAdd = (kind: "EXPENSE" | "INCOME") => {
    setEditing(null);
    setParentId(undefined);
    setModalKind(kind);
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

  const handleDeleteStart = async (cat: Category) => {
    const usage = await getCategoryUsage(cat.id);
    setDeleteModal({ category: cat, usageCount: usage.count, categoryIds: usage.categoryIds });
  };

  const handleDeleteConfirm = async (reassignTo?: string) => {
    if (!deleteModal) return;
    try {
      await deleteCategory(deleteModal.category.id, reassignTo);
      refetch();
      refetchFlat();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
    setDeleteModal(null);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Categories</h2>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Expense Categories */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Tags className="h-4 w-4" /> Expense Categories
            </h3>
            <Button size="sm" variant="secondary" onClick={() => openAdd("EXPENSE")}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          <CategoryList
            categories={expenseCategories}
            expanded={expanded}
            icon={Tags}
            onToggleExpand={toggleExpand}
            onAddChild={(id) => openAddChild(id, "EXPENSE")}
            onEdit={openEdit}
            onDelete={handleDeleteStart}
          />
        </div>

        {/* Income Categories */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <TrendingUp className="h-4 w-4" /> Income Categories
            </h3>
            <Button size="sm" variant="secondary" onClick={() => openAdd("INCOME")}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          <CategoryList
            categories={incomeCategories}
            expanded={expanded}
            icon={TrendingUp}
            onToggleExpand={toggleExpand}
            onAddChild={(id) => openAddChild(id, "INCOME")}
            onEdit={openEdit}
            onDelete={handleDeleteStart}
          />
        </div>
      </div>

      <CategoryModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); setParentId(undefined); }}
        onSave={handleSave}
        category={editing}
        parentId={parentId}
        kind={modalKind}
      />

      {deleteModal && (
        <DeleteCategoryModal
          category={deleteModal.category}
          usageCount={deleteModal.usageCount}
          allCategories={(flatCategories ?? []).filter(
            (c) => !deleteModal.categoryIds.includes(c.id) && c.kind === deleteModal.category.kind
          )}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteModal(null)}
        />
      )}
    </div>
  );
}

// ── Category list (shared between expense and income columns) ──

interface CategoryListProps {
  categories: Category[];
  expanded: Set<string>;
  icon: LucideIcon;
  onToggleExpand: (id: string) => void;
  onAddChild: (id: string) => void;
  onEdit: (cat: Category) => void;
  onDelete: (cat: Category) => void;
}

function CategoryList({ categories, expanded, icon: Icon, onToggleExpand, onAddChild, onEdit, onDelete }: CategoryListProps) {
  if (categories.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Icon}
          title="No categories"
          description="Add a category to get started."
        />
      </Card>
    );
  }

  return (
    <Card className="divide-y divide-border p-0">
      {categories.map((cat) => {
        const isOpen = expanded.has(cat.id);
        const hasChildren = cat.children && cat.children.length > 0;

        return (
          <div key={cat.id}>
            <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
              <button
                onClick={() => hasChildren && onToggleExpand(cat.id)}
                className={`rounded p-0.5 ${hasChildren ? "hover:bg-accent" : ""}`}
                disabled={!hasChildren}
              >
                {hasChildren ? (
                  isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
                ) : (
                  <span className="inline-block h-4 w-4" />
                )}
              </button>

              <div
                className="h-7 w-7 flex-shrink-0 rounded-md"
                style={cat.color ? { backgroundColor: cat.color } : undefined}
              />

              <span className="flex-1 font-medium">{cat.name}</span>

              {cat.ignoreInBudget && <span title="Ignored in budget" className="inline-flex flex-shrink-0"><EyeOff className="h-4 w-4 text-gray-300" /></span>}

              {hasChildren && (
                <span className="text-xs text-muted-foreground">
                  {cat.children!.length} subcategories
                </span>
              )}

              <div className="flex gap-1">
                <button
                  onClick={() => onAddChild(cat.id)}
                  className="rounded p-1 hover:bg-accent"
                  title="Add subcategory"
                >
                  <Plus className="h-4 w-4 text-muted-foreground" />
                </button>
                <button
                  onClick={() => onEdit(cat)}
                  className="rounded p-1 hover:bg-accent"
                >
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </button>
                <button onClick={() => onDelete(cat)} className="rounded p-1 hover:bg-accent">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </button>
              </div>
            </div>

            {isOpen && hasChildren && (
              <div className="border-t border-border bg-muted/30">
                {cat.children!.map((child) => (
                  <div key={child.id} className="flex items-center gap-3 py-2 pl-12 pr-4 hover:bg-muted/50">
                    <span className="flex-1 text-sm">{child.name}</span>
                    {child.ignoreInBudget && <span title="Ignored in budget" className="inline-flex flex-shrink-0"><EyeOff className="h-3.5 w-3.5 text-gray-300" /></span>}
                    <div className="flex gap-1">
                      <button
                        onClick={() => onEdit(child)}
                        className="rounded p-1 hover:bg-accent"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      <button onClick={() => onDelete(child)} className="rounded p-1 hover:bg-accent">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ── Category color palette ──

const CATEGORY_COLORS = [
  "#C1121F", "#F94144", "#F3722C", "#F8961E", "#F9844A",
  "#F9C74F", "#EFE233", "#D4A017", "#9B2335", "#E8618C",
  "#90BE6D", "#43AA8B", "#4D908E", "#277DA1", "#577590",
  "#1B4965", "#3D6B8C", "#5E548E", "#9B72CF", "#C77DFF",
];

// ── Category modal ──

interface CategoryModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<Category>) => Promise<void>;
  category: Category | null;
  parentId?: string;
  kind: "EXPENSE" | "INCOME";
}

function CategoryModal({ open, onClose, onSave, category, parentId, kind }: CategoryModalProps) {
  const [saving, setSaving] = useState(false);
  const [selectedColor, setSelectedColor] = useState(category?.color ?? CATEGORY_COLORS[0]);
  const [ignoreInBudget, setIgnoreInBudget] = useState(category?.ignoreInBudget ?? false);

  useEffect(() => {
    if (open) {
      setSelectedColor(category?.color ?? CATEGORY_COLORS[0]);
      setIgnoreInBudget(category?.ignoreInBudget ?? false);
    }
  }, [open, category]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      name: form.get("name") as string,
      color: (form.get("color") as string) || undefined,
      ignoreInBudget,
      parentId,
      kind,
    } as Partial<Category>);
    setSaving(false);
  };

  const kindLabel = kind === "INCOME" ? "Income " : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={category ? `Edit ${kindLabel}Category` : parentId ? `Add ${kindLabel}Subcategory` : `Add ${kindLabel}Category`}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Name</label>
          <input
            name="name"
            type="text"
            required
            defaultValue={category?.name ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Category name"
          />
        </div>

        {!parentId && (
          <div>
            <label className="mb-1 block text-sm font-medium">Color</label>
            <input type="hidden" name="color" value={selectedColor} />
            <div className="grid w-fit grid-cols-10 gap-2">
              {CATEGORY_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setSelectedColor(color)}
                  style={{ backgroundColor: color }}
                  className={`h-7 w-7 rounded-md transition-transform hover:scale-110 ${
                    selectedColor === color
                      ? "scale-110 ring-2 ring-border ring-offset-1"
                      : ""
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        <div className="rounded-md border border-border p-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={ignoreInBudget}
              onChange={(e) => setIgnoreInBudget(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm font-medium">Ignore in budget</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : category ? "Update" : "Add"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Delete category modal ──

interface DeleteCategoryModalProps {
  category: Category;
  usageCount: number;
  allCategories: Category[];
  onConfirm: (reassignTo?: string) => void;
  onClose: () => void;
}

function DeleteCategoryModal({ category, usageCount, allCategories, onConfirm, onClose }: DeleteCategoryModalProps) {
  const [reassignTo, setReassignTo] = useState("");

  const parentCategories = allCategories.filter((c) => !c.parentId);
  const childCategories = allCategories.filter((c) => c.parentId);

  const isIncome = category.kind === "INCOME";
  const recordLabel = isIncome ? "income records" : "expenses";

  return (
    <Modal open={true} onClose={onClose} title="Delete Category">
      <div className="space-y-4">
        <p className="text-sm">
          Are you sure you want to delete <strong>{category.name}</strong>
          {category.children && category.children.length > 0 && (
            <> and its {category.children.length} subcategories</>
          )}
          ?
        </p>

        {usageCount > 0 ? (
          <>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-800">
                {usageCount} {recordLabel} currently use this category.
                You can reassign them to a different category, or leave them uncategorized.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Reassign {recordLabel} to</label>
              <div className="relative">
              <select
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
                className="w-full appearance-none rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground"
              >
                <option value="">Leave uncategorized</option>
                {parentCategories.map((parent) => {
                  const children = childCategories.filter((c) => c.parentId === parent.id);
                  if (children.length === 0) {
                    return <option key={parent.id} value={parent.id}>{parent.name}</option>;
                  }
                  return (
                    <optgroup key={parent.id} label={parent.name}>
                      {children.map((child) => (
                        <option key={child.id} value={child.id}>{child.name}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No {recordLabel} use this category.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onConfirm(reassignTo || undefined)}
          >
            Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}
