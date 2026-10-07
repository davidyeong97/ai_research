# Project Specification: Multi-Agent Council & Consensus Chat (Game-UI)

## 1. Project Overview

This project is a web-based, multi-agent AI collaboration platform wrapped in an interactive, game-like user interface (RPG / Guild Hall / War Room theme).

When a user submits a prompt, a **Lead AI Orchestrator** analyzes the task complexity, dynamically selects an ensemble of sub-agents powered by diverse provider models (e.g., Gemini, Claude, OpenAI, Grok, Qwen, Kimi), and dictates a multi-round debate/research protocol. The sub-agents then conduct independent research (web search, reasoning, fact-checking), exchange findings, deliberate, and converge on an optimal solution for the user—all visualized in real-time through pixel/game avatar visualizers, action indicators, and dynamic state displays.

---

## 2. Core Architecture & Workflow

```
[User Query]
     │
     ▼
┌────────────────────────────────────────────────────────┐
│ 1. Lead AI Orchestrator (Orchestration Phase)          │
│    - Evaluates query complexity (1-5 scale)            │
│    - Selects N Sub-Agents based on specialization      │
│    - Defines total deliberation rounds (1 to M rounds) │
│    - Generates Execution Plan & Assigns Sub-Tasks      │
└────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────┐
│ 2. Sub-Agent Autonomous Research Phase                 │
│    - Web Searching & Tool Usage                       │
│    - Thinking / Chain-of-Thought Scratchpad            │
│    - Fact-checking & Verification                      │
└────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────┐
│ 3. Multi-Round Discussion & Consensus Phase            │
│    - Round 1: Initial Findings & Proposals             │
│    - Round 2..M: Critique, Rebuttal, Refinement        │
│    - Human-in-the-Loop Interventions (Optional Pause)  │
│    - Real-time turn-taking & inter-agent chat          │
└────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────┐
│ 4. Synthesis & Final Response Generation              │
│    - Lead Agent synthesizes sub-agent contributions     │
│    - Produces final polished answer for the user       │
└────────────────────────────────────────────────────────┘
```

---

## 3. Key Features & Functional Requirements

### 3.1 Lead Orchestrator Agent

- **Task Analysis**: Parses intent, domain (coding, science, creative, casual, reasoning), and complexity (1–5 scale).
- **Dynamic Agent Selection**: Picks required sub-agent models depending on API availability, domain fit, and provider quotas.
- **Debate Strategy**: Sets max turns per round, convergence thresholds, token cap limits, and allowed tools.

### 3.2 Sub-Agents & Tool Integration

- **Multi-Provider Support**: Pluggable backend adapter pattern supporting Anthropic, OpenAI, Google Gemini, xAI Grok, Alibaba Qwen, Moonshot Kimi, DeepSeek, and local models (Ollama).
- **Agent Capabilities**:
  - **Thinking/Scratchpad**: Emits visual reasoning events before submitting finalized messages.
  - **Web Search & Fact Checking**: Performs web queries in sandboxed tool environments and cross-verifies statements made by peer agents.

### 3.3 Game-Like UI / UX Concepts

- **Visual Representation**:
  - **Avatars & Sprites**: Pixel-art/2D avatars styled after model brands or custom personas.
  - **Status Indicators**: Badges above avatars (`Thinking 🤔`, `Searching Web 🌐`, `Debating ⚔️`, `Fact-Checking 🔍`, `Consensus Achieved ✅`).
  - **HP / Energy Bars**: Visual representation of remaining token budgets or confidence scores.
  - **Speech Bubbles & Chat Log**: Live speech bubbles above sprites paired with a central RPG text transcript log.
- **Layout Responsiveness**:
  - **Desktop**: Split-screen showing the 2D visual arena alongside a Markdown chat & deep inspection panel.
  - **Mobile**: Responsive stacked UI with tab navigation (`Visual Arena` ↔ `Discussion Stream`).

---

## 4. API, Token & Cost Management

### 4.1 Token Budget Allocation Strategy

- **Hard Caps per Quest**: Every user query is assigned a total token ceiling (e.g., max 50,000 combined tokens across all rounds).
- **Lead Orchestrator Budgeting**:
  - **Complexity 1-2**: 1–2 Sub-Agents, 1 Round (Max 10k tokens).
  - **Complexity 3-4**: 2–3 Sub-Agents, 2 Rounds (Max 30k tokens).
  - **Complexity 5**: 3–4 Sub-Agents, 3 Rounds + Deep Research (Max 50k tokens).
- **Context Truncation**: Debate history past Round 2 must be summarized by the Lead Agent before feeding context into Round 3+ to avoid exponential token scaling ($O(N^2)$ context growth).

### 4.2 Rate-Limiting & Cost Guardrails

- **Provider Rate-Limiting Engine**: Token Bucket algorithm per provider key to manage requests-per-minute (RPM) and tokens-per-minute (TPM).
- **Circuit Breaker Pattern**: Automatic fallback to alternative provider models (e.g., failover from Claude Sonnet to DeepSeek or Gemini) if rate limits or 5xx errors occur.
- **User-Level Quotas**: Tiered session usage limits (Free, Pro, BYOK - Bring Your Own Keys).

---

## 5. Security, Caching & Data Persistence

### 5.1 Tool Execution & Prompt Injection Security

- **Search & Tool Sandbox**: Agent web queries and code interpreters must execute inside isolated ephemeral environments (e.g., WebAssembly, Docker, or Serverless Workers).
- **Prompt Injection Defense**: Sub-agent outputs must be sanitized before passing into other agents' prompts to prevent malicious prompt injection chaining across agents.
- **Secret Redaction**: API keys and environment variables are strictly restricted to the backend service layer; zero key exposure to client scripts or sub-agent prompts.

### 5.2 Caching Strategy

- **Exact & Semantic Query Caching**:
  - **Level 1 (Semantic Cache - Vector DB)**: Caches identical or near-identical research queries made by sub-agents to save search/inference costs.
  - **Level 2 (Tool Output Cache - Redis)**: Caches web search results for 24 hours to prevent redundant external web API calls.

### 5.3 Data Persistence & State Management

- **Database Schema**: Postgres/Supabase or MongoDB store session histories.
- **Stored Entities**:
  - `Sessions`: User ID, total tokens used, total cost ($), quest outcome.
  - `OrchestrationPlans`: Task complexity, agent matrix, round count.
  - `AgentMessages`: Round #, agent ID, action type, thought log, visible message, token count, latency.

---

## 6. Human-in-the-Loop (HITL) Controls

- **Pause / Intervene Mode**: Users can click a "Pause Deliberation" button during live debate.
- **Director Guidance**: Users can insert a prompt mid-debate ("_Focus more on Python performance rather than readability_"), forcing all agents to adapt in the subsequent round.
- **Approval Gates**: For high-complexity tasks (Complexity Level 5), the Lead Orchestrator requests user approval on the proposed plan and estimated token cost before initializing sub-agents.

---

## 7. Technical Stack Recommendations

| Component                 | Recommended Technology                        | Notes                                            |
| :------------------------ | :-------------------------------------------- | :----------------------------------------------- |
| **Frontend Framework**    | React / Next.js OR Vue 3 (Vite)               | Fast rendering, structured component state       |
| **Styling & UI**          | Tailwind CSS + Lucide Icons + Framer Motion   | Fluid animations, retro gaming themes            |
| **Game / Stage Layer**    | Canvas API / PixiJS / Framer Motion Stage     | Sprite rendering, speech bubbles, status effects |
| **Backend API**           | Node.js (Fastify/Express) OR Python (FastAPI) | Handles SSE streaming and tool execution         |
| **Orchestration & State** | LangGraph / AutoGen / Custom SSE Bus          | Handles agent loops, turns, and event streaming  |
| **Cache & DB**            | Redis + Supabase (PostgreSQL)                 | Rate limits, web search caching, session data    |

---

## 8. API Data Structures & Protocols

### 8.1 Lead Agent Orchestration Payload

```json
{
  "taskId": "task_98234",
  "complexityScore": 4,
  "budgetCapTokens": 35000,
  "executionPlan": {
    "assignedAgents": [
      { "id": "claude-3-7-sonnet", "role": "Architect & Lead Coder", "avatar": "wizard" },
      { "id": "gemini-2-5-pro", "role": "Fact-Checker & Searcher", "avatar": "scout" },
      { "id": "grok-3", "role": "Critic & Edge-Case Specialist", "avatar": "rogue" }
    ],
    "maxRounds": 2,
    "toolsAllowed": ["web_search", "code_interpreter"]
  }
}
```

### 8.2 Real-Time Event Stream Format (SSE)

```json
{
  "timestamp": "2026-10-06T10:00:00Z",
  "round": 1,
  "agentId": "gemini-2-5-pro",
  "action": "SEARCHING",
  "tokensUsed": 340,
  "data": {
    "query": "latest benchmarks JS web frameworks 2026",
    "statusMessage": "Searching web for latest benchmarks..."
  }
}
```

---

## 9. Development Milestones & Roadmap

### Phase 1: Core Multi-LLM Adapter & Rate-Limiter Engine

- [x] Implement provider adapters with unified response schemas. _(All models are reached through a single OpenRouter adapter; direct OpenAI/Anthropic/Google/xAI/Ollama adapters are not implemented.)_
- [x] Build cost/token tracking logic (`lib/council/budget`). _(A rate-limiting bucket manager is not implemented.)_
- [x] Build Orchestrator parsing logic & SSE streaming engine.

### Phase 2: Discussion Protocol, Tools & HITL

- [x] Implement multi-turn debate loops and context truncation/summarization.
- [x] Add sandboxed web search tool pipeline.
- [x] Add fact-checking tool pipeline (after round 1 a fact-checker agent verifies peers' claims, emitting `FACT_CHECKING`; the verdict feeds later rounds).
- [x] Implement Human-In-The-Loop pause/resume/inject mechanisms.

### Phase 3: Game UI & Frontend Integration

- [x] Build pixel-art/2D sprite stage with status indicators and speech bubble components.
- [x] Connect real-time SSE stream state machine to UI animations.
- [x] Optimize responsive layout for desktop and mobile viewports.

### Phase 4: Security, Caching & Polish

- [x] Implement tool caching (SQLite exact-match cache; semantic cache not implemented).
- [x] Apply prompt injection sanitization across inter-agent communications.
- [ ] Add sound effects (8-bit text audio, battle chimes) and transcript export features.

---

## Running locally / on your phone via VPN

```bash
npm ci
cp .env.example .env.local     # then set APP_PASSWORD and OPENROUTER_API_KEY
npm run build
npm run start:lan              # same as: next start -H 0.0.0.0
```

Then open `http://<host-vpn-ip>:3000` on your phone and log in with `APP_PASSWORD`.

- Over plain http the session cookie is not marked `Secure`. Set `COOKIE_SECURE=true` only when serving over https.
- Data (SQLite) is stored at `DATABASE_PATH` (default `./data/council.db`).
- Quests that were still running when the server restarted are marked `interrupted` on startup.
- See `.env.example` for all configuration options.

---

## 10. Guidelines for AI Agents Working on This Repo

1. **Strict Separation of Concerns**: Keep multi-LLM API adapters and token streaming isolated from rendering components.
2. **Standardized Event Schema**: All backend agent actions MUST emit uniform event types (`THINKING`, `SEARCHING`, `SPEAKING`, `PAUSED`, `DONE`, `ERROR`).
3. **Graceful Fallbacks**: Always provide fallbacks for model timeouts or API rate limits so the multi-agent discussion completes uninterrupted.
4. **Mobile First UI Resilience**: Canvas/game displays must gracefully resize into compact status bars on narrower viewports.

> Note: semantic (embedding-based) caching is out of scope; only exact-match caching of web-search-backed calls is implemented (`TOOL_CACHE_ENABLED`, `TOOL_CACHE_TTL_HOURS`).
