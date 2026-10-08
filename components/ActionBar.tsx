"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPT, classifyFile, formatSize, validateFiles } from "@/lib/client/attachments";

const BTN =
  "min-h-11 min-w-11 flex-1 border-2 border-black bg-amber-300 px-3 text-xs font-bold uppercase text-black shadow-[2px_2px_0_0_#000] disabled:cursor-not-allowed disabled:opacity-50";

function Chip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = classifyFile(file) === "image";
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage || typeof URL.createObjectURL !== "function") return;
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL must be created/revoked with the effect lifecycle
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
    };
  }, [file, isImage]);
  return (
    <li
      data-testid="attachment-chip"
      className="flex min-h-11 max-w-full items-center gap-2 border-2 border-black bg-black/50 pl-1 text-xs"
    >
      {isImage && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="h-9 w-9 flex-none object-cover" />
      ) : (
        <span aria-hidden className="flex-none px-1 text-lg">
          {classifyFile(file) === "pdf" ? "📕" : isImage ? "🖼" : "📄"}
        </span>
      )}
      <span className="min-w-0 max-w-[9rem] truncate">{file.name}</span>
      <span className="flex-none text-indigo-300">{formatSize(file.size)}</span>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="min-h-11 min-w-11 flex-none text-base font-bold text-red-300"
      >
        ✕
      </button>
    </li>
  );
}

export function ActionBar({
  onSubmit,
  busy = false,
  uploading = false,
  error = null,
  running = false,
  paused = false,
  onControl,
}: {
  onSubmit?: (query: string, files: File[]) => Promise<boolean | void> | boolean | void;
  /** True while attachments are uploading. */
  uploading?: boolean;
  /** True while a quest is starting or running. */
  busy?: boolean;
  error?: string | null;
  /** True only while a quest is actively running (enables HITL controls). */
  running?: boolean;
  paused?: boolean;
  onControl?: (action: "pause" | "resume" | "inject", text?: string) => Promise<boolean> | void;
}) {
  const [query, setQuery] = useState("");
  const [guidance, setGuidance] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const { accepted, errors } = validateFiles(files, incoming);
    setFileErrors(errors);
    if (accepted.length) setFiles([...files, ...accepted]);
  };
  const canControl = running && !!onControl;
  const canInject = canControl && guidance.trim().length > 0;
  const canSubmit = !busy && (query.trim().length > 0 || files.length > 0) && !!onSubmit;
  return (
    <div className="flex-none space-y-2 border-t-4 border-amber-200/80 bg-indigo-950 px-3 pt-2 pb-2 lg:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <form
        aria-label="Quest actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          const sent = files;
          setFileErrors([]);
          void Promise.resolve(onSubmit?.(query.trim(), sent)).then((ok) => {
            if (ok === false) return;
            setQuery("");
            setFiles((cur) => cur.filter((f) => !sent.includes(f)));
          });
        }}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          setDragging(false);
          if (!busy) addFiles(Array.from(e.dataTransfer.files));
        }}
        className={`space-y-2 ${dragging ? "outline-dashed outline-2 outline-amber-300" : ""}`}
      >
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        {fileErrors.length > 0 && (
          <ul
            role="alert"
            aria-label="Attachment errors"
            className="space-y-0.5 text-xs text-red-300"
          >
            {fileErrors.map((m, i) => (
              <li key={i} className="break-words">
                {m}
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <ul aria-label="Selected attachments" className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <Chip
                key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                file={f}
                onRemove={() => {
                  setFileErrors([]);
                  setFiles(files.filter((x) => x !== f));
                }}
              />
            ))}
          </ul>
        )}
        {uploading && (
          <p role="status" className="text-xs text-amber-300">
            Uploading…
          </p>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            accept={ACCEPT}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className={`${BTN} flex-none text-lg`}
          >
            📎
          </button>
          <input
            type="text"
            aria-label="Quest"
            placeholder="Enter your quest…"
            enterKeyHint="send"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData?.files ?? []);
              if (pasted.length === 0) return;
              e.preventDefault();
              if (!busy) addFiles(pasted);
            }}
            disabled={busy}
            maxLength={4000}
            className="min-h-11 min-w-0 flex-1 border-2 border-black bg-black/50 px-3 text-base text-white placeholder:text-indigo-300"
          />
          <button
            type="submit"
            aria-label="Go"
            disabled={!canSubmit}
            className={`${BTN} flex-none`}
          >
            {uploading ? "…" : "Go"}
          </button>
        </div>
      </form>
      <form
        aria-label="Director controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canInject) return;
          const text = guidance.trim();
          setGuidance("");
          void onControl?.("inject", text);
        }}
        className="flex gap-2"
      >
        <button
          type="button"
          disabled={!canControl}
          aria-pressed={paused}
          onClick={() => void onControl?.(paused ? "resume" : "pause")}
          className={`${BTN} flex-none`}
        >
          {paused ? "Resume" : "Pause Deliberation"}
        </button>
        <input
          type="text"
          aria-label="Director guidance"
          placeholder="Director guidance…"
          enterKeyHint="send"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          disabled={!canControl}
          maxLength={2000}
          className="min-h-11 min-w-0 flex-1 border-2 border-black bg-black/50 px-3 text-base text-white placeholder:text-indigo-300 disabled:opacity-50"
        />
        <button type="submit" disabled={!canInject} className={`${BTN} flex-none`}>
          Send
        </button>
      </form>
    </div>
  );
}
