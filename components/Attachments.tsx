"use client";

import { useEffect, useRef } from "react";
import type { AttachmentRef } from "@/lib/client/questReducer";

export const uploadUrl = (id: string) => `/api/uploads/${encodeURIComponent(id)}`;

/** Thumbnails (images) and file chips for attachments already stored on the server. */
export function AttachmentList({
  attachments,
  onOpen,
}: {
  attachments: AttachmentRef[];
  onOpen?: (a: AttachmentRef) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul
      aria-label="Attachments"
      className="mt-1 flex flex-wrap gap-2"
      data-testid="attachment-list"
    >
      {attachments.map((a) => (
        <li key={a.id}>
          {a.kind === "image" ? (
            <button
              type="button"
              aria-label={`Open ${a.filename}`}
              onClick={() => onOpen?.(a)}
              className="block h-16 w-16 overflow-hidden border-2 border-black bg-black/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={uploadUrl(a.id)}
                alt={a.filename}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ) : (
            <a
              href={uploadUrl(a.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 max-w-[14rem] items-center gap-1 border-2 border-black bg-black/40 px-2 text-xs text-sky-200 underline"
            >
              <span aria-hidden>{a.kind === "pdf" ? "📕" : "📄"}</span>
              <span className="truncate">{a.filename}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ImageLightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentRef;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/85 p-3"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={uploadUrl(attachment.id)}
        alt={attachment.filename}
        className="max-h-[80dvh] max-w-full border-4 border-amber-200/80 object-contain"
      />
      <p className="max-w-full truncate text-xs text-indigo-200">{attachment.filename}</p>
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="min-h-11 min-w-11 border-2 border-black bg-amber-300 px-4 text-xs font-bold uppercase text-black shadow-[2px_2px_0_0_#000]"
      >
        Close
      </button>
    </div>
  );
}
