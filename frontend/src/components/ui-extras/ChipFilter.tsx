import { cn } from "@/lib/utils";

export type ChipOption = {
  id: string;
  label: string;
  count?: number;
};

type Props = {
  options: ChipOption[];
  selected: string[];
  onToggle: (id: string) => void;
  className?: string;
};

/**
 * Multi-select chip group. Empty `selected` means "no filter applied"
 * (caller should treat empty as "show everything"). Clicking a chip toggles
 * it in the selected set.
 */
export function ChipFilter({ options, selected, onToggle, className }: Props) {
  if (options.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {options.map((opt) => {
        const active = selected.includes(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onToggle(opt.id)}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium transition-colors border",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted",
            )}
            aria-pressed={active}
          >
            {opt.label}
            {opt.count != null && (
              <span className="ml-1 opacity-60 tabular-nums">({opt.count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
