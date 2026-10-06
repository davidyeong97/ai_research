"use client";

import { useState } from "react";
import { Markdown } from "./Markdown";

export function FinalAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      data-testid="final-answer"
      aria-label="Council's Verdict"
      className="mt-3 border-4 border-amber-300 bg-amber-300/15 p-3 text-sm shadow-[4px_4px_0_0_#000]"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-widest text-amber-300">
          <span aria-hidden="true">📜 </span>Council&apos;s Verdict
        </h3>
        <button
          type="button"
          onClick={() => void copy()}
          className="min-h-9 border-2 border-amber-300 bg-indigo-950 px-2 text-xs font-bold uppercase text-amber-200 shadow-[2px_2px_0_0_#000] hover:bg-indigo-900"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <Markdown>{text}</Markdown>
    </section>
  );
}
