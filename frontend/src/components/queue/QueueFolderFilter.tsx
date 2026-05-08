import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "queue_folder_filter";

function loadPersisted(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function savePersisted(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* best-effort */
  }
}

type Props = {
  onChange: (folderIds: number[]) => void;
};

export function QueueFolderFilter({ onChange }: Props) {
  const persisted = useMemo(loadPersisted, []);
  const [selected, setSelected] = useState<string[]>(persisted);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted(selected);
    onChange(
      selected.map((s) => Number(s)).filter((n) => Number.isFinite(n)),
    );
  }, [selected, onChange]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (isLoading || folders.length === 0) return null;

  const options: ChipOption[] = folders.map((f) => ({
    id: String(f.id),
    label: f.title,
  }));

  return (
    <div className="px-4 py-2 border-b border-border">
      <ChipFilter options={options} selected={selected} onToggle={toggle} />
    </div>
  );
}
