import { useEffect, useMemo } from "react";
import { Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "message_tabs_v2";

export type ScopeAll = { kind: "all" };
export type ScopeFolder = { kind: "folder"; id: number };
export type ScopeArchive = { kind: "archive" };
export type Scope = ScopeAll | ScopeFolder | ScopeArchive;

export type ChatType = "private" | "groups" | "contacts";

export type TabState = {
  scope: Scope;
  type: ChatType;
};

const DEFAULT_STATE: TabState = { scope: { kind: "all" }, type: "private" };

function loadPersisted(): TabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_STATE;
    const type: ChatType =
      parsed.type === "groups" || parsed.type === "contacts" ? parsed.type : "private";
    if (parsed.scope?.kind === "all") return { scope: { kind: "all" }, type };
    if (parsed.scope?.kind === "archive") return { scope: { kind: "archive" }, type };
    if (parsed.scope?.kind === "folder" && Number.isFinite(parsed.scope?.id)) {
      return { scope: { kind: "folder", id: Number(parsed.scope.id) }, type };
    }
    return { scope: { kind: "all" }, type };
  } catch {
    return DEFAULT_STATE;
  }
}

function savePersisted(state: TabState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

type Props = {
  state: TabState;
  onChange: (next: TabState) => void;
  /** Optional total counts per type within current scope (for badges). */
  typeCounts?: Partial<Record<ChatType, number>>;
};

/** Helper for parent: get initial state synchronously. */
export function getInitialTabState(): TabState {
  return loadPersisted();
}

export function MessageTabs({ state, onChange, typeCounts }: Props) {
  const { folders } = useFolders();

  useEffect(() => {
    savePersisted(state);
  }, [state]);

  const setScope = (scope: Scope) => onChange({ ...state, scope });
  const setType = (type: ChatType) => onChange({ ...state, type });

  const scopeIsActive = (s: Scope): boolean => {
    if (s.kind !== state.scope.kind) return false;
    if (s.kind === "folder" && state.scope.kind === "folder") {
      return s.id === state.scope.id;
    }
    return true;
  };

  const typeOptions = useMemo<Array<{ id: ChatType; label: string }>>(() => {
    const base: Array<{ id: ChatType; label: string }> = [
      { id: "private", label: "Личные" },
      { id: "groups", label: "Группы" },
    ];
    // Contacts list is meaningless inside Archive scope.
    if (state.scope.kind !== "archive") base.push({ id: "contacts", label: "Контакты" });
    return base;
  }, [state.scope.kind]);

  // If user is on "contacts" then switches into Archive — fall back to "private".
  useEffect(() => {
    if (state.scope.kind === "archive" && state.type === "contacts") {
      onChange({ ...state, type: "private" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.scope.kind]);

  return (
    <div className="flex flex-col border-b border-border bg-background">
      {/* Level 1: scope (All / Folders / Archive) */}
      <div className="flex gap-1 overflow-x-auto px-3 py-2 no-scrollbar">
        <ScopeChip
          label="Все"
          active={scopeIsActive({ kind: "all" })}
          onClick={() => setScope({ kind: "all" })}
        />
        {folders.map((f) => (
          <ScopeChip
            key={f.id}
            label={f.title}
            active={scopeIsActive({ kind: "folder", id: f.id })}
            onClick={() => setScope({ kind: "folder", id: f.id })}
          />
        ))}
        <ScopeChip
          label="Архив"
          icon={<Archive className="h-3.5 w-3.5" />}
          active={scopeIsActive({ kind: "archive" })}
          onClick={() => setScope({ kind: "archive" })}
        />
      </div>

      {/* Level 2: chat type (segmented switcher) */}
      <div className="flex gap-1 px-3 pb-2">
        {typeOptions.map((opt) => {
          const active = state.type === opt.id;
          const count = typeCounts?.[opt.id];
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setType(opt.id)}
              className={cn(
                "flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:bg-muted",
              )}
              aria-pressed={active}
            >
              {opt.label}
              {count != null && (
                <span className="ml-1 opacity-70 tabular-nums">({count})</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScopeChip({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium transition-colors border whitespace-nowrap",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:bg-muted",
      )}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}
