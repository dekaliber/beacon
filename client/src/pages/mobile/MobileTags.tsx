import { useState, useRef, useMemo, useEffect } from "react";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { Plus, Pencil, Trash2, Tag as TagIcon, ChevronDown, ChevronUp, CornerDownRight, AlertTriangle, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getTags, createTag, updateTag, deleteTag, getExpenses, getTagOrphanedOffsets } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Expense, OrphanedOffset, Tag } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue } from "@/components/Typography";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

// ── Expense row ───────────────────────────────────────────────────────────────

function ExpenseRow({ exp }: { exp: Expense }) {
  return (
    <>
      <div className="flex items-center gap-2 py-2 pl-11 pr-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{exp.vendor || exp.description}</p>
          <p className="tp-caption">{formatDate(exp.date.slice(0, 10))}</p>
        </div>
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
          style={{ backgroundColor: exp.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}
        >
          {exp.account.isJoint ? "J" : "P"}
        </span>
        <StatValue className="shrink-0 text-sm">{formatCurrency(parseFloat(exp.amount))}</StatValue>
      </div>
      {(exp.offsets ?? []).map((offset) => (
        <div key={offset.id} className="flex items-center gap-2 py-1.5 pl-14 pr-4 text-muted-foreground">
          <CornerDownRight className="h-3 w-3 shrink-0 opacity-50" />
          <p className="min-w-0 flex-1 truncate text-xs">{offset.vendor || offset.description}</p>
          <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
            style={{ backgroundColor: offset.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}
          >
            {offset.account.isJoint ? "J" : "P"}
          </span>
          <StatValue className="shrink-0 text-xs">{formatCurrency(parseFloat(offset.amount))}</StatValue>
        </div>
      ))}
    </>
  );
}

function OrphanedRow({ offset }: { offset: OrphanedOffset }) {
  return (
    <div className="flex items-center gap-2 py-2 pl-11 pr-4 text-warn">
      <CornerDownRight className="h-3 w-3 shrink-0 opacity-60" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate">
          <p className="truncate text-sm">{offset.vendor || offset.description}</p>
          <AlertTriangle className="h-3 w-3 shrink-0" />
        </div>
        <p className="text-xs opacity-70">{formatDate(offset.date.slice(0, 10))}</p>
      </div>
      <span
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
        style={{ backgroundColor: offset.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}
      >
        {offset.account.isJoint ? "J" : "P"}
      </span>
      <StatValue className="shrink-0 text-sm">{formatCurrency(parseFloat(offset.amount))}</StatValue>
    </div>
  );
}

// ── Tag row ───────────────────────────────────────────────────────────────────

function TagRow({
  tag,
  onEdit,
}: {
  tag: Tag;
  onEdit: (tag: Tag) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const expenseCache = useRef<Expense[] | null>(null);
  const orphanCache = useRef<OrphanedOffset[] | null>(null);

  const handleToggle = async () => {
    if (expanded) { setExpanded(false); return; }
    if (expenseCache.current === null) {
      setLoading(true);
      try {
        const [expRes, orphanRes] = await Promise.all([
          getExpenses({ tagIds: tag.id, sortBy: "date", sortOrder: "asc", limit: "500" }),
          getTagOrphanedOffsets(tag.id),
        ]);
        expenseCache.current = expRes.data;
        orphanCache.current = orphanRes;
      } catch {
        expenseCache.current = [];
        orphanCache.current = [];
      }
      setLoading(false);
    }
    setExpanded(true);
  };

  const rows = useMemo(() => {
    if (!expanded || expenseCache.current === null) return [];
    return [
      ...expenseCache.current.map((e) => ({ kind: "expense" as const, date: e.date, data: e })),
      ...(orphanCache.current ?? []).map((o) => ({ kind: "orphaned" as const, date: o.date, data: o })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [expanded]);

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Color swatch — tap to edit */}
        <button
          type="button"
          onClick={() => onEdit(tag)}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          <span
            className="h-6 w-6 shrink-0 rounded-md"
            style={{ backgroundColor: tag.color ?? "var(--color-gray-400)" }}
          />
          <span className="truncate text-sm font-medium">{tag.name}</span>
        </button>

        {/* Totals */}
        <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums font-mono text-muted-foreground">
          {tag.personalTotal > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold text-white" style={{ backgroundColor: PERSONAL_COLOR }}>P</span>
              {formatCurrency(tag.personalTotal)}
            </span>
          )}
          {tag.jointTotal > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold text-white" style={{ backgroundColor: JOINT_COLOR }}>J</span>
              {formatCurrency(tag.jointTotal)}
            </span>
          )}
        </div>

        {/* Edit */}
        <button
          type="button"
          onClick={() => onEdit(tag)}
          className="shrink-0 rounded p-1.5 text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>

        {/* Expand toggle */}
        <button
          type="button"
          onClick={handleToggle}
          className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Inline expense list */}
      {expanded && (
        <div className="border-t border-border/50 bg-muted/30">
          {loading ? (
            <p className="py-4 text-center tp-caption">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center tp-caption">No expenses</p>
          ) : (
            <div className="divide-y divide-border/50">
              {rows.map((item) =>
                item.kind === "expense"
                  ? <ExpenseRow key={item.data.id} exp={item.data} />
                  : <OrphanedRow key={item.data.id} offset={item.data} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MobileTags() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);

  const { data: tags, refetch } = useApi(() => getTags(), []);

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

  const openAdd = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (tag: Tag) => { setEditing(tag); setModalOpen(true); };

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
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  if (!tags) return <BeaconLoader />;

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="tp-page-title">Tags</h1>
          <button
            type="button"
            onClick={openAdd}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>

        {tagGroups.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-12 text-center">
            <TagIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No tags yet</p>
            <p className="mt-1 tp-caption">
              Create tags to label and group your expenses.
            </p>
            <button
              type="button"
              onClick={openAdd}
              className="mt-4 flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground mx-auto"
            >
              <Plus className="h-4 w-4" /> Add Tag
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {tagGroups.map(([groupName, groupTags]) => (
              <div key={groupName ?? "__ungrouped__"} className="space-y-2">
                {groupName && (
                  <SectionLabel>
                    {groupName}
                  </SectionLabel>
                )}
                <div className="overflow-hidden rounded-xl border border-border divide-y divide-border">
                  {groupTags.map((tag) => (
                    <TagRow key={tag.id} tag={tag} onEdit={openEdit} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalOpen && (
        <MobileTagModal
          key={editing?.id ?? "new"}
          tag={editing}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSave={handleSave}
          onDelete={editing ? handleDelete : undefined}
        />
      )}
    </>
  );
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────

function MobileTagModal({
  tag,
  onClose,
  onSave,
  onDelete,
}: {
  tag: Tag | null;
  onClose: () => void;
  onSave: (data: { name: string; color?: string; group?: string | null }) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [color, setColor] = useState<string>(tag?.color ?? PRESET_COLORS[0]);

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
    const group = (form.get("group") as string).trim();
    await onSave({
      name: form.get("name") as string,
      color,
      group: group || null,
    });
    setSaving(false);
  };

  // Confirm-delete screen
  if (confirmDelete) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-background">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="tp-panel-title">Delete Tag</h2>
          <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-3">
          <p className="text-sm">
            Delete <strong>{tag!.name}</strong>? This will remove the tag from all expenses.
          </p>
        </div>
        <div className="shrink-0 border-t border-border p-4 flex gap-3">
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
              await onDelete!(tag!.id);
              setDeleting(false);
            }}
            className="flex-1 rounded-md bg-down py-2.5 text-sm font-medium text-white disabled:opacity-50 transition-opacity"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    );
  }

  // Main form
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="tp-panel-title">{tag ? "Edit Tag" : "Add Tag"}</h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <form id="mobile-tag-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-5 p-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Name</label>
            <input
              name="name"
              type="text"
              required
              defaultValue={tag?.name ?? ""}
              placeholder="e.g. tax-deductible"
              className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">Color</label>
            <div className="grid grid-cols-8 gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{ backgroundColor: c }}
                  className={`aspect-square w-full rounded-md transition-transform ${
                    color === c ? "scale-110 ring-2 ring-border ring-offset-1" : ""
                  }`}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Group{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              name="group"
              type="text"
              defaultValue={tag?.group ?? ""}
              placeholder="e.g. Living, Discretionary"
              className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>
        </div>
      </form>

      <div className="shrink-0 border-t border-border p-4 flex gap-3">
        {onDelete && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded-md border border-border p-2.5 text-muted-foreground hover:border-down hover:text-down transition-colors"
            aria-label="Delete tag"
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
          form="mobile-tag-form"
          disabled={saving}
          className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
        >
          {saving ? "Saving…" : tag ? "Save Changes" : "Add"}
        </button>
      </div>
    </div>
  );
}
