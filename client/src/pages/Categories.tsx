import { useState } from "react";
import { Plus, Trash2, Pencil, Tags, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getCategories, createCategory, updateCategory, deleteCategory } from "@/api";
import type { Category } from "@/types";

export function Categories() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: categories, refetch } = useApi(() => getCategories(), []);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = async (data: Partial<Category>) => {
    if (editing) {
      await updateCategory(editing.id, data);
    } else {
      await createCategory(data);
    }
    setModalOpen(false);
    setEditing(null);
    setParentId(undefined);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this category?")) {
      try {
        await deleteCategory(id);
        refetch();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Failed to delete");
      }
    }
  };

  const openAddChild = (pid: string) => {
    setEditing(null);
    setParentId(pid);
    setModalOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Categories</h2>
        <Button onClick={() => { setEditing(null); setParentId(undefined); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Add Category
        </Button>
      </div>

      {categories && categories.length > 0 ? (
        <Card className="divide-y divide-border p-0">
          {categories.map((cat) => {
            const isOpen = expanded.has(cat.id);
            const hasChildren = cat.children && cat.children.length > 0;

            return (
              <div key={cat.id}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
                  <button
                    onClick={() => hasChildren && toggleExpand(cat.id)}
                    className={`rounded p-0.5 ${hasChildren ? "hover:bg-accent" : ""}`}
                    disabled={!hasChildren}
                  >
                    {hasChildren ? (
                      isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
                    ) : (
                      <span className="inline-block h-4 w-4" />
                    )}
                  </button>

                  {cat.color && (
                    <div className="h-4 w-4 rounded-full" style={{ backgroundColor: cat.color }} />
                  )}

                  <span className="flex-1 font-medium">{cat.name}</span>

                  {hasChildren && (
                    <span className="text-xs text-muted-foreground">
                      {cat.children!.length} subcategories
                    </span>
                  )}

                  <div className="flex gap-1">
                    <button
                      onClick={() => openAddChild(cat.id)}
                      className="rounded p-1 hover:bg-accent"
                      title="Add subcategory"
                    >
                      <Plus className="h-4 w-4 text-muted-foreground" />
                    </button>
                    {!cat.isDefault && (
                      <>
                        <button
                          onClick={() => { setEditing(cat); setParentId(cat.parentId ?? undefined); setModalOpen(true); }}
                          className="rounded p-1 hover:bg-accent"
                        >
                          <Pencil className="h-4 w-4 text-muted-foreground" />
                        </button>
                        <button onClick={() => handleDelete(cat.id)} className="rounded p-1 hover:bg-accent">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isOpen && hasChildren && (
                  <div className="border-t border-border bg-muted/30">
                    {cat.children!.map((child) => (
                      <div key={child.id} className="flex items-center gap-3 py-2 pl-12 pr-4 hover:bg-muted/50">
                        <span className="flex-1 text-sm">{child.name}</span>
                        {!child.isDefault && (
                          <div className="flex gap-1">
                            <button
                              onClick={() => { setEditing(child); setParentId(child.parentId ?? undefined); setModalOpen(true); }}
                              className="rounded p-1 hover:bg-accent"
                            >
                              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                            <button onClick={() => handleDelete(child.id)} className="rounded p-1 hover:bg-accent">
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={Tags}
            title="No categories"
            description="Categories help organize your expenses."
            action={
              <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
                <Plus className="h-4 w-4" /> Add Category
              </Button>
            }
          />
        </Card>
      )}

      <CategoryModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); setParentId(undefined); }}
        onSave={handleSave}
        category={editing}
        parentId={parentId}
      />
    </div>
  );
}

interface CategoryModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<Category>) => Promise<void>;
  category: Category | null;
  parentId?: string;
}

function CategoryModal({ open, onClose, onSave, category, parentId }: CategoryModalProps) {
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      name: form.get("name") as string,
      color: (form.get("color") as string) || undefined,
      parentId,
    } as Partial<Category>);
    setSaving(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={category ? "Edit Category" : parentId ? "Add Subcategory" : "Add Category"}
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
            <input
              name="color"
              type="color"
              defaultValue={category?.color ?? "#4F46E5"}
              className="h-10 w-20 cursor-pointer rounded-md border border-border"
            />
          </div>
        )}

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
