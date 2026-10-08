import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDb } from "../db";
import { buildExport } from "../council/export";
import {
  controlQuest,
  decideApproval,
  getQuestSnapshot,
  listQuests,
  planSummary,
  ServiceError,
  startQuest,
  waitForQuest,
  type QuestSnapshot,
  type ServiceDeps,
} from "../council/service";

export const MAX_EXPORT_CHARS = 100_000;
const MAX_WAIT_SECONDS = 50;
const TERMINAL = new Set(["done", "error", "budget_exceeded", "cost_cap_exceeded", "cancelled", "interrupted"]);

/** Deep link to watch a quest in the web UI; undefined when PUBLIC_BASE_URL is unset. */
export function viewUrl(questId: string): string | undefined {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/?quest=${encodeURIComponent(questId)}` : undefined;
}

type Structured = Record<string, unknown>;

function ok(text: string, structuredContent: Structured): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(e: unknown): CallToolResult {
  let text: string;
  let structured: Structured;
  if (e instanceof ServiceError) {
    const hint =
      e.code === "not_found"
        ? " Use council_list to find valid quest ids."
        : e.code === "limit"
          ? " Do not retry immediately; tell the user the limit was hit."
          : "";
    text = `Error (${e.code}): ${e.message}${hint}`;
    structured = { error: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}) };
  } else {
    const message = e instanceof Error ? e.message : String(e);
    text = `Error: ${message}`;
    structured = { error: "internal", message };
  }
  return { isError: true, content: [{ type: "text", text }], structuredContent: structured };
}

async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

function nextStep(s: QuestSnapshot): string {
  if (s.status === "awaiting_approval") {
    return "This quest needs human approval. Show the plan and max cost to the user; call council_approve only after they explicitly agree.";
  }
  if (TERMINAL.has(s.status)) return s.status === "done" ? "" : `Quest ended with status ${s.status}.`;
  return `Quest is still running. Call council_status with questId ${s.questId} and waitSeconds=50 (sinceSeq=${s.lastSeq}) to keep waiting, then council_result.`;
}

function snapshotText(s: QuestSnapshot): string {
  const lines = [
    `Quest ${s.questId}: ${s.status}${s.paused ? " (paused)" : ""}`,
    `Tokens: ${s.totalTokens}, cost: $${s.totalCostUsd.toFixed(4)}`,
  ];
  const url = viewUrl(s.questId);
  if (url) lines.push(`Watch live: ${url}`);
  if (s.agents.length) lines.push(`Agents: ${s.agents.map((a) => `${a.role} (${a.model})`).join(", ")}`);
  const progress = s.recent
    .filter((e) => e.message || e.statusMessage)
    .slice(-3)
    .map((e) => `- [${e.action}] ${e.agentId}: ${e.statusMessage ?? e.message}`.slice(0, 240));
  if (progress.length && !s.finalAnswer) lines.push("Recent progress:", ...progress);
  if (s.finalAnswer) lines.push("", "Final answer:", s.finalAnswer);
  else if (s.error) lines.push(`Error: ${s.error}`);
  const step = nextStep(s);
  if (step) lines.push("", step);
  return lines.join("\n");
}

function snapshotStructured(s: QuestSnapshot): Structured {
  return { ...s, ...(viewUrl(s.questId) ? { viewUrl: viewUrl(s.questId) } : {}), nextStep: nextStep(s) || undefined };
}

const questId = z.string().min(1).describe("Quest id returned by council_ask / council_start");
const maxCostUsd = z
  .number()
  .positive()
  .optional()
  .describe("Optional spend cap in USD for this quest. Can only lower the server default cap. Keep modest.");
const autoApprove = z
  .boolean()
  .optional()
  .describe("Skip the human approval gate for expensive (complexity 5) quests. Only true if the user explicitly asked for it. Default false.");

export function createCouncilMcpServer(deps: ServiceDeps = {}): McpServer {
  const server = new McpServer(
    { name: "council", version: "0.1.0" },
    {
      instructions:
        "Council runs a multi-agent AI debate (several models + fact-checking) and returns a synthesized answer. Debates take minutes: use council_ask, and if it returns a questId, poll council_status with waitSeconds=50 then call council_result. Never send secrets. Only call council_approve after the human user explicitly approved.",
    },
  );

  const snapshotResult = (s: QuestSnapshot) => ok(snapshotText(s), snapshotStructured(s));
  const waitSecs = (n: number | undefined, dflt: number) => Math.min(MAX_WAIT_SECONDS, Math.max(0, n ?? dflt)) * 1000;

  server.registerTool(
    "council_ask",
    {
      title: "Ask the Council",
      description:
        "Start a multi-agent debate on a hard, high-stakes, research-heavy or contested question and wait up to waitSeconds (max 50) for the answer. Returns the final answer if finished, otherwise a questId and progress; then call council_status (waitSeconds=50) repeatedly and council_result. Costs real money; do not use for trivial questions or anything containing secrets.",
      inputSchema: {
        question: z.string().min(1).max(8000).describe("The question or task to debate. Be specific and self-contained."),
        maxCostUsd,
        autoApprove,
        waitSeconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional().describe("Seconds to wait for the answer (default 45, max 50)."),
      },
    },
    (args) =>
      guarded(async () => {
        const r = await startQuest(
          { query: args.question, source: "mcp", maxCostUsd: args.maxCostUsd, autoApprove: args.autoApprove ?? false },
          deps,
        );
        const snap = await waitForQuest(r.questId, { timeoutMs: waitSecs(args.waitSeconds, 45) }, deps);
        return snapshotResult(snap);
      }),
  );

  server.registerTool(
    "council_start",
    {
      title: "Start a Council quest",
      description:
        "Start a Council debate without waiting. Returns the questId and a plan summary (complexity, agents/models, rounds, budget, whether human approval is required). Follow up with council_status.",
      inputSchema: { question: z.string().min(1).max(8000), maxCostUsd, autoApprove },
    },
    (args) =>
      guarded(async () => {
        const r = await startQuest(
          { query: args.question, source: "mcp", maxCostUsd: args.maxCostUsd, autoApprove: args.autoApprove ?? false },
          deps,
        );
        const summary = planSummary(r.plan);
        const requiresApproval = r.status === "awaiting_approval";
        const text = [
          `Started quest ${r.questId} (${r.status}).`,
          `Complexity ${summary.complexity}, ${summary.rounds} round(s), agents: ${summary.agents.map((a) => `${a.role} (${a.model})`).join(", ")}.`,
          `Token budget: ${r.plan.budgetCapTokens}.`,
          requiresApproval
            ? "Human approval required: show the plan to the user and call council_approve only after they agree."
            : `Call council_status with questId ${r.questId} and waitSeconds=50.`,
          viewUrl(r.questId) ? `Watch live: ${viewUrl(r.questId)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return ok(text, {
          questId: r.questId,
          status: r.status,
          requiresApproval,
          plan: summary,
          budgetCapTokens: r.plan.budgetCapTokens,
          ...(viewUrl(r.questId) ? { viewUrl: viewUrl(r.questId) } : {}),
        });
      }),
  );

  server.registerTool(
    "council_status",
    {
      title: "Quest status",
      description:
        "Get a snapshot of a quest. With waitSeconds>0 (max 50) it long-polls until the quest finishes, needs approval, or (with sinceSeq) new events arrive. Prefer waitSeconds=50 over rapid polling.",
      inputSchema: {
        questId,
        sinceSeq: z.number().int().min(0).optional().describe("Only include/wake on events after this seq (use lastSeq from the previous snapshot)."),
        waitSeconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional().describe("Long-poll duration, 0-50 (default 0)."),
      },
    },
    (args) =>
      guarded(async () => {
        const ms = waitSecs(args.waitSeconds, 0);
        const snap =
          ms > 0
            ? await waitForQuest(args.questId, { timeoutMs: ms, untilSeqAfter: args.sinceSeq }, deps)
            : getQuestSnapshot(args.questId, { sinceSeq: args.sinceSeq }, deps);
        return snapshotResult(snap);
      }),
  );

  server.registerTool(
    "council_result",
    {
      title: "Quest result",
      description: "Get the final answer with cost and tokens for a finished quest, or the current status if it has not finished.",
      inputSchema: { questId },
    },
    (args) => guarded(() => snapshotResult(getQuestSnapshot(args.questId, { sinceSeq: Number.MAX_SAFE_INTEGER }, deps))),
  );

  server.registerTool(
    "council_control",
    {
      title: "Control a running quest",
      description:
        "pause/resume a running debate, inject user guidance into it (action=inject, guidance required), or cancel it. Use inject to relay the user's mid-debate input; cancel if the user changes their mind.",
      inputSchema: {
        questId,
        action: z.enum(["pause", "resume", "inject", "cancel"]),
        guidance: z.string().max(2000).optional().describe("Required for action=inject."),
      },
    },
    (args) =>
      guarded(() => {
        const r = controlQuest(args.questId, args.action, args.guidance, deps);
        return ok(`Action ${args.action} applied to quest ${args.questId}.${r.paused ? " Quest is paused." : ""}`, {
          questId: args.questId,
          action: args.action,
          paused: r.paused,
        });
      }),
  );

  server.registerTool(
    "council_approve",
    {
      title: "Approve or reject a quest plan",
      description:
        "Approve (or reject) a quest that is awaiting approval. ONLY call this after the human user has explicitly approved the plan and its cost in this conversation. Never approve on your own.",
      inputSchema: { questId, approve: z.boolean().describe("true to start the debate, false to cancel it.") },
    },
    (args) =>
      guarded(() => {
        decideApproval(args.questId, args.approve, deps);
        return ok(args.approve ? `Quest ${args.questId} approved and running.` : `Quest ${args.questId} rejected.`, {
          questId: args.questId,
          approved: args.approve,
        });
      }),
  );

  server.registerTool(
    "council_list",
    {
      title: "List quests",
      description: "List recent quests (newest first) with status and cost, optionally filtered by status.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
        status: z.string().optional().describe("e.g. running, awaiting_approval, done, cancelled."),
      },
    },
    (args) =>
      guarded(() => {
        const quests = listQuests({ limit: args.limit, status: args.status }, deps);
        const text = quests.length
          ? quests
              .map((q) => `${q.questId} [${q.status}] $${q.totalCostUsd.toFixed(4)} ${q.query.slice(0, 80)}`)
              .join("\n")
          : "No quests found.";
        return ok(text, { quests });
      }),
  );

  const exportText = (id: string, format: "md" | "json") => {
    const body = buildExport((deps.db ?? getDb()) as Parameters<typeof buildExport>[0], id, format);
    if (body === undefined) throw new ServiceError("not_found", "quest not found");
    const truncated = body.length > MAX_EXPORT_CHARS;
    return {
      text: truncated ? `${body.slice(0, MAX_EXPORT_CHARS)}\n\n[truncated: transcript exceeded ${MAX_EXPORT_CHARS} characters]` : body,
      truncated,
    };
  };

  server.registerTool(
    "council_export",
    {
      title: "Export transcript",
      description: "Export the full debate transcript of a quest as markdown or JSON (capped at ~100KB; truncation is noted).",
      inputSchema: { questId, format: z.enum(["md", "json"]).optional().describe("Default md.") },
    },
    (args) =>
      guarded(() => {
        const { text, truncated } = exportText(args.questId, args.format ?? "md");
        return ok(text, { questId: args.questId, format: args.format ?? "md", truncated });
      }),
  );

  server.registerResource(
    "quest-transcript",
    new ResourceTemplate("council://quests/{id}/transcript", { list: undefined }),
    { title: "Quest transcript", description: "Markdown transcript of a quest", mimeType: "text/markdown" },
    (uri, vars) => {
      const id = String(Array.isArray(vars.id) ? vars.id[0] : vars.id);
      const { text } = exportText(id, "md");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  return server;
}
