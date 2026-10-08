---
name: council
description: Run a multi-agent AI debate with fact-checking (Council) for hard, high-stakes, or contested questions.
metadata: { "openclaw": { "requires": { "env": ["COUNCIL_MCP_TOKEN"] } } }
---

# Council

Council is a multi-agent debate platform exposed as MCP tools (server `council`). A lead orchestrator plans the question, several models debate it with web search and fact-checking, and the lead synthesizes one final answer. It costs real money and takes minutes.

## When to use it

Use Council for questions that benefit from several model perspectives and fact-checking:

- complex, high-stakes, or research-heavy questions (decisions, comparisons, technical or legal/medical/financial analysis);
- contested topics where a single model's view may be biased or wrong.

Do NOT use it for:

- trivial lookups, quick facts, or chit-chat;
- anything containing secrets, credentials, API keys, or private data the user has not explicitly okayed sending to third-party model providers (OpenRouter and the models behind it). Only attach files the user okayed.

If unsure whether the question is worth the cost, ask the user first.

## How to use it

Tool calls must stay short, so debates are driven with long-polling.

1. Call `council_ask` with `question` (specific and self-contained) and `waitSeconds: 45`. Keep `maxCostUsd` modest (omit it to use the server default) unless the user asks for a bigger budget. Never set `autoApprove` unless the user asked for it.
2. If it returns the final answer, go to step 5.
3. Otherwise it returns a `questId`. Call `council_status` with `questId` and `waitSeconds: 50` (pass `sinceSeq` from the previous reply) repeatedly, at most ~10 times, until the quest is finished, needs approval, or fails. Tell the user it is still running if you stop polling; they can ask you to resume later.
4. When finished, call `council_result` with the `questId`.
5. Reply with a concise summary of the final answer, the `viewUrl` (if present) so the user can open the arena and watch or replay the debate, and the reported cost. Mention if the debate hit its budget cap or errored.

## Approval

Expensive (complexity 5) quests pause for approval. If `council_status` reports `awaitingApproval`:

1. Show the user the plan and the estimated maximum cost.
2. Call `council_approve` with `approve: true` ONLY after the user explicitly consents in this conversation. Use `approve: false` if they decline.
3. Then continue polling with `council_status`.

Never approve on your own.

## Steering a running debate

- Relay user guidance mid-debate with `council_control` `{ questId, action: "inject", guidance: "..." }`.
- `pause` / `resume` are available if the user asks.
- If the user changes their mind, call `council_control` with `action: "cancel"`.

## Other tools

- `council_start`: same as `council_ask` but returns immediately without waiting.
- `council_list`: list recent quests (find a `questId` from an earlier conversation).
- `council_export`: full transcript as Markdown or JSON.

## Errors

- Concurrency or daily-cost limits (rate-limit / 429-style errors): tell the user, do not retry in a tight loop.
- Auth errors: `COUNCIL_MCP_TOKEN` is missing or wrong; ask the user to check the Council MCP setup.
