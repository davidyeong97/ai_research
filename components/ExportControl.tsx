"use client";

export function ExportControl({ questId }: { questId: string | null }) {
  if (!questId) return null;
  const href = (f: "md" | "json") =>
    `/api/quests/${encodeURIComponent(questId)}/export?format=${f}`;
  const cls =
    "inline-flex min-h-11 min-w-11 items-center justify-center border-2 border-amber-300 bg-indigo-950 px-3 text-xs font-bold uppercase text-amber-200 shadow-[2px_2px_0_0_#000] hover:bg-indigo-900";
  return (
    <div className="flex items-center gap-2" data-testid="export-control">
      <span className="text-[10px] uppercase tracking-wider text-indigo-300">Export</span>
      <a
        href={href("md")}
        download={`council-${questId}.md`}
        data-testid="export-md"
        className={cls}
      >
        Markdown
      </a>
      <a
        href={href("json")}
        download={`council-${questId}.json`}
        data-testid="export-json"
        className={cls}
      >
        JSON
      </a>
    </div>
  );
}
