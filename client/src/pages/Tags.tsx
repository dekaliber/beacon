import { useState } from "react";
import { Plus, Trash2, Pencil, Tag as TagIcon } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getTags, createTag, updateTag, deleteTag } from "@/api";
import type { Tag } from "@/types";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

export function TagsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const { data: tags, refetch } = useApi(() => getTags(), []);

  const handleSave = async (data: { name: string; color?: string }) => {
    if (editing) {
      await updateTag(editing.id, data);
    } else {
      await createTag(data);
    }
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this tag? It will be removed from all expenses and income entries.")) {
      await deleteTag(id);
      refetch();
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Tags</h2>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Add Tag
        </Button>
      </div>

      <Card>
        {tags && tags.length > 0 ? (
          <div className="divide-y divide-border">
            {tags.map((tag) => (
              <div key={tag.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div
                    className="h-4 w-4 rounded-full border border-border"
                    style={{ backgroundColor: tag.color ?? "hsl(var(--muted-foreground))" }}
                  />
                  <span className="font-medium">{tag.name}</span>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setEditing(tag); setModalOpen(true); }}
                    className="rounded p-1 hover:bg-accent"
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </button>
                  <button onClick={() => handleDelete(tag.id)} className="rounded p-1 hover:bg-accent">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={TagIcon}
            title="No tags yet"
            description="Create tags to label and group your expenses and income entries."
            action={
              <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
                <Plus className="h-4 w-4" /> Add Tag
              </Button>
            }
          />
        )}
      </Card>

      <TagModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        tag={editing}
      />
    </div>
  );
}

interface TagModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; color?: string }) => Promise<void>;
  tag: Tag | null;
}

function TagModal({ open, onClose, onSave, tag }: TagModalProps) {
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState<string>(tag?.color ?? PRESET_COLORS[0]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      name: form.get("name") as string,
      color,
    });
    setSaving(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={tag ? "Edit Tag" : "Add Tag"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Name</label>
          <input
            name="name"
            type="text"
            required
            defaultValue={tag?.name ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. tax-deductible"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium">Color</label>
          <div className="flex flex-wrap gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  backgroundColor: c,
                  borderColor: color === c ? "#000" : "transparent",
                }}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Custom:</label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border border-border"
            />
            <span className="text-sm text-muted-foreground">{color}</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : tag ? "Update" : "Add Tag"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
