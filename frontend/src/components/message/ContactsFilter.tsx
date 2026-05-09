import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "message_filter";

type Persisted = { types: string[]; folders: string[]; archive?: boolean };

const TYPE_OPTIONS: ChipOption[] = [
  { id: "private", label: "Личные" },
  { id: "groups", label: "Группы" },
  { id: "contacts", label: "Контакты" },
];

const ARCHIVE_OPTION: ChipOption = { id: "archive", label: "Архив" };

export type FilterState = {
  types: string[];
  folderIds: number[];
  archive: boolean;
};

type Props = {
  /** Counts shown next to type chips. Optional. */
  typeCounts?: Partial<Record<"private" | "groups" | "contacts", number>>;
  /** Optional count for archive chip. */
  archiveCount?: number;
  onChange: (state: FilterState) => void;
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { types: [], folders: [], archive: false };
    const parsed = JSON.parse(raw);
    return {
      types: Array.isArray(parsed.types) ? parsed.types : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      archive: !!parsed.archive,
    };
  } catch {
    return { types: [], folders: [], archive: false };
  }
}

function savePersisted(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* best-effort */
  }
}

export function ContactsFilter({ typeCounts, archiveCount, onChange }: Props) {
  const persisted = useMemo(loadPersisted, []);
  const [types, setTypes] = useState<string[]>(persisted.types);
  const [folderIds, setFolderIds] = useState<string[]>(persisted.folders);
  const [archive, setArchive] = useState<boolean>(!!persisted.archive);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted({ types, folders: folderIds, archive });
    onChange({
      types,
      folderIds: folderIds
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n)),
      archive,
    });
  }, [types, folderIds, archive, onChange]);

  const toggleType = (id: string) =>
    setTypes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleFolder = (id: string) =>
    setFolderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleArchive = () => setArchive((v) => !v);

  const typeOptionsWithCounts: ChipOption[] = TYPE_OPTIONS.map((opt) => ({
    ...opt,
    count: typeCounts?.[opt.id as "private" | "groups" | "contacts"],
  }));

  const archiveOptionWithCount: ChipOption = {
    ...ARCHIVE_OPTION,
    count: archiveCount,
  };

  const folderOptions: ChipOption[] = folders.map((f) => ({
    id: String(f.id),
    label: f.title,
  }));

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-border">
      <div className="flex flex-wrap gap-2">
        <ChipFilter options={typeOptionsWithCounts} selected={types} onToggle={toggleType} />
        <ChipFilter
          options={[archiveOptionWithCount]}
          selected={archive ? ["archive"] : []}
          onToggle={toggleArchive}
        />
      </div>
      {!isLoading && folderOptions.length > 0 && (
        <ChipFilter options={folderOptions} selected={folderIds} onToggle={toggleFolder} />
      )}
    </div>
  );
}
