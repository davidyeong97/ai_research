# Using Council from OpenClaw

Council exposes a stateless remote MCP server (Streamable HTTP) at `/api/mcp`, so an [OpenClaw](https://docs.openclaw.ai) agent can run debates as a tool. A bundled skill teaches the agent when and how to use it.

Tools: `council_ask`, `council_start`, `council_status`, `council_result`, `council_control`, `council_approve`, `council_list`, `council_export`. No call blocks longer than ~50 s; long debates are polled with `council_status` (`waitSeconds` up to 50).

## 1. Generate a token

```bash
npm run mcp:token        # prints a random token
```

Put it in `.env.local` as `MCP_TOKEN` and restart Council. Until it is set, `/api/mcp` returns 503. The token is accepted only on `/api/mcp` (cookie sessions are not), and `/api/mcp` is the only route reachable with it.

## 2. Environment variables (Council host)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_TOKEN` | unset (endpoint disabled) | Bearer token, min 32 chars |
| `MCP_MAX_CONCURRENT` | `2` | Max running / awaiting-approval MCP quests |
| `MCP_DAILY_COST_USD` | `2.00` | Max spend by MCP quests in the last 24 h |
| `MCP_DEFAULT_MAX_COST_USD` | `0.30` | Default per-quest cap (never above `MAX_COST_USD_PER_QUEST`) |
| `PUBLIC_BASE_URL` | unset | Base URL used for the `viewUrl` "watch live" links, e.g. `http://100.64.0.5:3000` |

See `.env.example` for the full list (e.g. `MCP_RATE_LIMIT_PER_MIN`).

## 3. Network options

- **Same machine as OpenClaw:** `http://127.0.0.1:3000/api/mcp` (run `npm start`, localhost only).
- **Different machine:** run `npm run start:lan` and connect over Tailscale or another VPN: `http://<tailscale-ip>:3000/api/mcp`. For HTTPS, use `tailscale serve` (e.g. `tailscale serve --bg 3000`) and `https://<machine>.<tailnet>.ts.net/api/mcp`.
- **Never expose Council to the public internet without TLS**, and keep the token secret. Set `PUBLIC_BASE_URL` to the address your phone/browser uses.

## 4. Add the server to OpenClaw

Export the token where the OpenClaw Gateway runs:

```bash
export COUNCIL_MCP_TOKEN=<same value as MCP_TOKEN>
```

Add the server:

```bash
openclaw mcp add council --url http://<host>:3000/api/mcp --transport streamable-http
```

The Authorization header is set in config. Equivalent `~/.openclaw/openclaw.json` block (also in [`integrations/openclaw/openclaw.example.json5`](../integrations/openclaw/openclaw.example.json5)):

```json5
{
  mcp: {
    servers: {
      council: {
        url: "http://<host>:3000/api/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${COUNCIL_MCP_TOKEN}" },
        requestTimeoutMs: 60000,
      },
    },
  },
}
```

Recommended: require confirmation for tool calls (at minimum `council_approve`):

```bash
openclaw mcp configure council --approval prompt
```

Verify connectivity and tool discovery:

```bash
openclaw mcp doctor council --probe
```

You should see the 8 tools. Use `toolFilter.include` / `exclude` to restrict them if wanted.

## 5. Install the skill

Copy or symlink `integrations/openclaw/council` into the managed skills directory. The directory name must match the skill `name` (`council`):

```bash
ln -s "$PWD/integrations/openclaw/council" ~/.openclaw/skills/council
# or: cp -r integrations/openclaw/council ~/.openclaw/skills/council
```

(Alternatively place it in `<workspace>/skills/council` for a single agent.) Then start a new OpenClaw session (`/new` in chat, or `openclaw gateway restart`) and check `openclaw skills list`. The skill is only eligible when `COUNCIL_MCP_TOKEN` is set.

## How the agent uses it

1. `council_ask` with `waitSeconds: 45`; if unfinished it returns a `questId`.
2. `council_status` with `waitSeconds: 50` repeatedly (max ~10), then `council_result`.
3. Plan approval for expensive quests: the agent shows the plan and max cost and calls `council_approve` only after you agree.
4. `viewUrl` opens the quest in the Council arena to watch or replay it. MCP quests are tagged `mcp` in the recent quests list.
