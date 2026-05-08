import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "queue_filter";

export type QueueFilterState = { types: ("private" | "groups")[]; folderIds: number[] };

const TYPE_OPTIONS: ChipOption[] = [
  { id: "private", label: "Личные" },
  { id: "groups", label: "Группы" },
];

type Persisted = { types: string[]; folders: string[] };

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { types: [], folders: [] };
    const p = JSON.parse(raw);
    return {
      types: Array.isArray(p.types) ? p.types : [],
      folders: Array.isArray(p.folders) ? p.folders : [],
    };
  } catch {
    return { types: [], folders: [] };
  }
}

function savePersisted(p: Persisted) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* best-effort */ }
}

export function QueueFilter({ onChange }: { onChange: (s: QueueFilterState) => void }) {
  const persisted = useMemo(loadPersisted, []);
  const [types, setTypes] = useState<string[]>(persisted.types);
  const [folderIds, setFolderIds] = useState<string[]>(persisted.folders);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted({ types, folders: folderIds });
    onChange({
      types: types.filter((t): t is "private" | "groups" => t === "private" || t === "groups"),
      folderIds: folderIds.map((s) => Number(s)).filter((n) => Number.isFinite(n)),
    });
  }, [types, folderIds, onChange]);

  const toggle = (set: string[], setSet: (v: string[]) => void) => (id: string) =>
    setSet(set.includes(id) ? set.filter((x) => x !== id) : [...set, id]);

  const folderOptions: ChipOption[] = folders.map((f) => ({ id: String(f.id), label: f.title }));

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-border">
      <ChipFilter options={TYPE_OPTIONS} selected={types} onToggle={toggle(types, setTypes)} />
      {!isLoading && folderOptions.length > 0 && (
        <ChipFilter options={folderOptions} selected={folderIds} onToggle={toggle(folderIds, setFolderIds)} />
      )}
    </div>
  );
}
