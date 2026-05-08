import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "message_filter";

type Persisted = { types: string[]; folders: string[] };

const TYPE_OPTIONS: ChipOption[] = [
  { id: "private", label: "Личные" },
  { id: "groups", label: "Группы" },
  { id: "contacts", label: "Контакты" },
];

export type FilterState = {
  types: string[];
  folderIds: number[];
};

type Props = {
  /** Counts shown next to type chips. Optional. */
  typeCounts?: Partial<Record<"private" | "groups" | "contacts", number>>;
  onChange: (state: FilterState) => void;
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { types: [], folders: [] };
    const parsed = JSON.parse(raw);
    return {
      types: Array.isArray(parsed.types) ? parsed.types : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
    };
  } catch {
    return { types: [], folders: [] };
  }
}

function savePersisted(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* best-effort */
  }
}

export function ContactsFilter({ typeCounts, onChange }: Props) {
  const persisted = useMemo(loadPersisted, []);
  const [types, setTypes] = useState<string[]>(persisted.types);
  const [folderIds, setFolderIds] = useState<string[]>(persisted.folders);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted({ types, folders: folderIds });
    onChange({
      types,
      folderIds: folderIds
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n)),
    });
  }, [types, folderIds, onChange]);

  const toggleType = (id: string) =>
    setTypes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleFolder = (id: string) =>
    setFolderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const typeOptionsWithCounts: ChipOption[] = TYPE_OPTIONS.map((opt) => ({
    ...opt,
    count: typeCounts?.[opt.id as "private" | "groups" | "contacts"],
  }));

  const folderOptions: ChipOption[] = folders.map((f) => ({
    id: String(f.id),
    label: f.title,
  }));

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-border">
      <ChipFilter options={typeOptionsWithCounts} selected={types} onToggle={toggleType} />
      {!isLoading && folderOptions.length > 0 && (
        <ChipFilter options={folderOptions} selected={folderIds} onToggle={toggleFolder} />
      )}
    </div>
  );
}
