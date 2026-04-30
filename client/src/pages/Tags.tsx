import { useRef, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Tag as TagIcon, ChevronDown, ChevronUp, CornerDownRight, AlertTriangle } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getTags, createTag, updateTag, deleteTag, getExpenses, getTagOrphanedOffsets } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Expense, OrphanedOffset, Tag } from "@/types";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

export function TagsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const expenseCache = useRef<Map<string, Expense[]>>(new Map());
  const orphanedOffsetCache = useRef<Map<string, OrphanedOffset[]>>(new Map());

  const { data: tags, refetch } = useApi(() => getTags(), []);

  const handleSave = async (data: { name: string; color?: string; group?: string | null }) => {
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
    await deleteTag(id);
    expenseCache.current.delete(id);
    orphanedOffsetCache.current.delete(id);
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleToggleExpand = async (tag: Tag) => {
    const id = tag.id;
    if (expandedIds.has(id)) {
      setExpandedIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      return;
    }
    // Expand — fetch if not cached
    if (!expenseCache.current.has(id)) {
      setLoadingIds((prev) => new Set([...prev, id]));
      try {
        const [expRes, orphanRes] = await Promise.all([
          getExpenses({ tagIds: id, sortBy: "date", sortOrder: "asc", limit: "500" }),
          getTagOrphanedOffsets(id),
        ]);
        expenseCache.current.set(id, expRes.data);
        orphanedOffsetCache.current.set(id, orphanRes);
      } catch {
        expenseCache.current.set(id, []);
        orphanedOffsetCache.current.set(id, []);
      }
      setLoadingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
    setExpandedIds((prev) => new Set([...prev, id]));
  };

  // Group tags by their group field. Named groups sorted alphabetically;
  // ungrouped tags collected under a null key at the end.
  const tagGroups = useMemo(() => {
    if (!tags) return [];
    const map = new Map<string | null, Tag[]>();
    for (const tag of tags) {
      const key = tag.group ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(tag);
    }
    const named = [...map.entries()]
      .filter(([k]) => k !== null)
      .sort(([a], [b]) => (a as string).localeCompare(b as string));
    const ungrouped = map.has(null) ? [[null, map.get(null)!] as [null, Tag[]]] : [];
    return [...named, ...ungrouped];
  }, [tags]);

  // Distribute groups across 2 columns, balancing by total tag count
  const columns = useMemo(() => {
    const cols: [string | null, Tag[]][][] = [[], []];
    const colCounts = [0, 0];
    for (const group of tagGroups) {
      const weight = group[1].length + (group[0] ? 1 : 0);
      const minIdx = colCounts.indexOf(Math.min(...colCounts));
      cols[minIdx].push(group);
      colCounts[minIdx] += weight;
    }
    return cols;
  }, [tagGroups]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Tags</h2>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Add Tag
        </Button>
      </div>

      {tags && tags.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {columns.map((col, ci) => (
            <div key={ci} className="space-y-6">
              {col.map(([groupName, groupTags]) => (
                <Card key={groupName ?? "__ungrouped__"}>
                  {groupName && (
                    <p className="mb-2 text-sm font-semibold">{groupName}</p>
                  )}
                  <div className="divide-y divide-border">
                    {groupTags.map((tag) => {
                      const isExpanded = expandedIds.has(tag.id);
                      const isLoading = loadingIds.has(tag.id);
                      const expenses = expenseCache.current.get(tag.id) ?? [];
                      const orphanedOffsets = orphanedOffsetCache.current.get(tag.id) ?? [];
                      return (
                        <div key={tag.id}>
                          {/* Tag row */}
                          <div className="flex items-center justify-between gap-3 py-2.5">
                            <button
                              onClick={() => { setEditing(tag); setModalOpen(true); }}
                              className="flex min-w-0 flex-1 items-center gap-3 rounded text-left hover:opacity-80"
                            >
                              <div
                                className="h-6 w-6 flex-shrink-0 rounded-md"
                                style={{ backgroundColor: tag.color ?? "hsl(var(--muted-foreground))" }}
                              />
                              <span className="truncate font-medium">{tag.name}</span>
                            </button>
                            <div className="flex flex-shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
                              {(tag.personalTotal > 0 || tag.jointTotal > 0) && (
                                <>
                                  {tag.personalTotal > 0 && (
                                    <span className="flex items-center gap-1">
                                      <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-gray-400 text-[9px] font-bold text-white">P</span>
                                      {formatCurrency(tag.personalTotal)}
                                    </span>
                                  )}
                                  {tag.jointTotal > 0 && (
                                    <span className="flex items-center gap-1">
                                      <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-blue-500 text-[9px] font-bold text-white">J</span>
                                      {formatCurrency(tag.jointTotal)}
                                    </span>
                                  )}
                                </>
                              )}
                              <button
                                onClick={() => handleToggleExpand(tag)}
                                className="rounded p-1 hover:bg-accent"
                                title={isExpanded ? "Hide expenses" : "Show expenses"}
                              >
                                {isExpanded
                                  ? <ChevronUp className="h-3.5 w-3.5" />
                                  : <ChevronDown className="h-3.5 w-3.5" />
                                }
                              </button>
                              <button
                                onClick={() => { setEditing(tag); setModalOpen(true); }}
                                className="rounded p-1 hover:bg-accent"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Expanded expense list */}
                          {isExpanded && (
                            <div className="border-t border-border/50 pb-1 pl-9 pt-1">
                              {isLoading ? (
                                <p className="py-2 text-center text-xs text-muted-foreground">Loading…</p>
                              ) : expenses.length === 0 && orphanedOffsets.length === 0 ? (
                                <p className="py-2 text-center text-xs text-muted-foreground">No expenses</p>
                              ) : (
                                <table className="w-full table-fixed text-xs">
                                  <colgroup>
                                    <col className="w-[70px]" />
                                    <col />
                                    <col className="w-8" />
                                    <col className="w-[70px]" />
                                  </colgroup>
                                  <thead>
                                    <tr className="border-b border-border/50">
                                      <th className="pb-1.5 pt-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                                      <th className="pb-1.5 pt-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Vendor</th>
                                      <th className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"></th>
                                      <th className="pb-1.5 pt-1 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {[
                                      ...expenses.map(e => ({ kind: "expense" as const, date: e.date, data: e })),
                                      ...orphanedOffsets.map(o => ({ kind: "orphaned" as const, date: o.date, data: o })),
                                    ].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map((item) => {
                                      if (item.kind === "expense") {
                                        const exp = item.data;
                                        return (
                                          <>
                                            <tr key={exp.id} className="border-b border-border/30">
                                              <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                                                {formatDate(exp.date.slice(0, 10))}
                                              </td>
                                              <td className="py-1.5 pr-2">
                                                <span className="block truncate">{exp.vendor || exp.description}</span>
                                              </td>
                                              <td className="py-1.5">
                                                <span
                                                  className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[8px] font-bold text-white ${
                                                    exp.account.isJoint ? "bg-blue-500" : "bg-gray-400"
                                                  }`}
                                                >
                                                  {exp.account.isJoint ? "J" : "P"}
                                                </span>
                                              </td>
                                              <td className="py-1.5 text-right tabular-nums">
                                                {formatCurrency(parseFloat(exp.amount))}
                                              </td>
                                            </tr>
                                            {(exp.offsets ?? []).map((offset) => (
                                              <tr key={offset.id} className="border-b border-border/30 last:border-0 text-muted-foreground">
                                                <td className="py-1 pr-3" />
                                                <td className="py-1 pr-2">
                                                  <span className="flex items-center gap-1 truncate">
                                                    <CornerDownRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
                                                    {offset.vendor || offset.description}
                                                  </span>
                                                </td>
                                                <td className="py-1">
                                                  <span
                                                    className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[8px] font-bold text-white ${
                                                      offset.account.isJoint ? "bg-blue-500" : "bg-gray-400"
                                                    }`}
                                                  >
                                                    {offset.account.isJoint ? "J" : "P"}
                                                  </span>
                                                </td>
                                                <td className="py-1 text-right tabular-nums">
                                                  {formatCurrency(parseFloat(offset.amount))}
                                                </td>
                                              </tr>
                                            ))}
                                          </>
                                        );
                                      } else {
                                        const offset = item.data;
                                        return (
                                          <tr key={offset.id} className="border-b border-border/30 last:border-0">
                                            <td className="py-1 pr-3 tabular-nums text-muted-foreground">
                                              {formatDate(offset.date.slice(0, 10))}
                                            </td>
                                            <td className="py-1 pr-2">
                                              <span className="flex items-center gap-1 truncate text-amber-600">
                                                <CornerDownRight className="h-3 w-3 flex-shrink-0 opacity-60" />
                                                <span className="truncate">{offset.vendor || offset.description}</span>
                                                <AlertTriangle
                                                  className="h-3 w-3 flex-shrink-0"
                                                  aria-label={`Orphaned offset — parent transaction "${offset.parentExpense?.vendor || offset.parentExpense?.description || "unknown"}" is not tagged`}
                                                />
                                              </span>
                                            </td>
                                            <td className="py-1">
                                              <span
                                                className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[8px] font-bold text-white ${
                                                  offset.account.isJoint ? "bg-blue-500" : "bg-gray-400"
                                                }`}
                                              >
                                                {offset.account.isJoint ? "J" : "P"}
                                              </span>
                                            </td>
                                            <td className="py-1 text-right tabular-nums text-amber-600">
                                              {formatCurrency(parseFloat(offset.amount))}
                                            </td>
                                          </tr>
                                        );
                                      }
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
            </div>
          ))}
        </div>
      ) : tags ? (
        <Card>
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
        </Card>
      ) : null}

      <TagModal
        key={editing?.id ?? "new"}
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        tag={editing}
      />
    </div>
  );
}

interface TagModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; color?: string; group?: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  tag: Tag | null;
}

function TagModal({ open, onClose, onSave, onDelete, tag }: TagModalProps) {
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState<string>(tag?.color ?? PRESET_COLORS[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const group = (form.get("group") as string).trim();
    await onSave({
      name: form.get("name") as string,
      color,
      group: group || null,
    });
    setSaving(false);
  };

  const handleDeleteClick = async () => {
    if (!tag) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    await onDelete(tag.id);
    setDeleting(false);
  };

  const handleClose = () => {
    setConfirmDelete(false);
    setDeleting(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title={tag ? "Edit Tag" : "Add Tag"}>
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
          <div className="grid w-fit grid-cols-8 gap-2">
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

        <div>
          <label className="mb-1 block text-sm font-medium">
            Group{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            name="group"
            type="text"
            defaultValue={tag?.group ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Living, Discretionary"
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div>
            {tag && (
              <button
                type="button"
                onClick={handleDeleteClick}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting..." : confirmDelete ? "Confirm Delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : tag ? "Update" : "Add Tag"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
