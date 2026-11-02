import { NotepadText } from "lucide-react";
import { InfoTooltip } from "@/components/Tooltip";
import { cn } from "@/lib/utils";

/**
 * Marks a transaction row whose Notes field is populated. Hovering shows the
 * note itself, so the user can read it without opening the edit modal.
 * Renders nothing for empty / whitespace-only notes.
 *
 * Pass `tooltip={false}` on touch layouts (mobile), where rows are tap-to-edit
 * and a hover tooltip would only flash as the editor opens.
 */
export function NoteIndicator({ notes, tooltip = true, className }: { notes?: string | null; tooltip?: boolean; className?: string }) {
  const text = notes?.trim();
  if (!text) return null;
  const icon = <NotepadText className={cn("h-3.5 w-3.5 shrink-0 cursor-default text-muted-foreground/60", className)} aria-label="Has notes" />;
  if (!tooltip) return icon;
  return (
    <InfoTooltip content={<span className="whitespace-pre-wrap break-words">{text}</span>}>
      {icon}
    </InfoTooltip>
  );
}
