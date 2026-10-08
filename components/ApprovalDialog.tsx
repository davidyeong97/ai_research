"use client";

import { useState } from "react";
import type { PendingApproval } from "@/lib/client/questReducer";

const BTN =
  "min-h-11 flex-1 border-2 border-black px-3 text-sm font-bold uppercase text-black shadow-[2px_2px_0_0_#000] disabled:cursor-not-allowed disabled:opacity-50";

export function ApprovalDialog({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (approved: boolean) => Promise<boolean> | void;
}) {
  const [sent, setSent] = useState(false);
  const { plan } = approval;
  const decide = (ok: boolean) => {
    setSent(true);
    void Promise.resolve(onDecide(ok)).then((r) => {
      if (r === false) setSent(false);
    });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        className="max-h-dvh w-full max-w-lg space-y-3 overflow-y-auto border-4 border-amber-200/80 bg-indigo-950 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-indigo-50 shadow-[4px_4px_0_0_#000]"
      >
        <h2
          id="approval-title"
          className="text-sm font-bold uppercase tracking-widest text-amber-300"
        >
          Approve council plan?
        </h2>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-indigo-300">Rounds</dt>
          <dd>{plan.rounds ?? "?"}</dd>
          <dt className="text-indigo-300">Tools</dt>
          <dd>{plan.tools.length ? plan.tools.join(", ") : "none"}</dd>
          <dt className="text-indigo-300">Max tokens</dt>
          <dd data-testid="est-tokens">
            {approval.estimatedMaxTokens === null
              ? "?"
              : approval.estimatedMaxTokens.toLocaleString()}
          </dd>
          <dt className="text-indigo-300">Max cost</dt>
          <dd data-testid="est-cost">
            {approval.estimatedMaxCostUsd === null
              ? "?"
              : `$${approval.estimatedMaxCostUsd.toFixed(2)}`}
          </dd>
        </dl>
        {approval.attachments.length > 0 && (
          <ul aria-label="Attachments" className="space-y-1">
            {approval.attachments.map((a) => (
              <li key={a.id} className="break-all border-2 border-black bg-black/40 px-2 py-1 text-xs">
                {a.kind === "image" ? "🖼" : "📄"} {a.filename}
              </li>
            ))}
          </ul>
        )}
        <ul aria-label="Agents" className="space-y-1">
          {plan.agents.map((a) => (
            <li key={a.id} className="border-2 border-black bg-black/40 px-2 py-1 text-xs">
              <span className="font-bold">{a.role}</span>
              {a.model && <span className="text-indigo-300"> · {a.model}</span>}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={sent}
            onClick={() => decide(false)}
            className={`${BTN} bg-red-400`}
          >
            Reject
          </button>
          <button
            type="button"
            disabled={sent}
            onClick={() => decide(true)}
            className={`${BTN} bg-emerald-400`}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
