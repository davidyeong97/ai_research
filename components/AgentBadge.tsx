/** "Started by agent" marker for quests created through the MCP server. */
export function AgentBadge({ source }: { source: string | null | undefined }) {
  if (source !== "mcp") return null;
  return (
    <span
      data-testid="agent-badge"
      title="Started by an agent via MCP"
      className="flex-none whitespace-nowrap border border-black bg-cyan-300 px-1.5 py-0.5 text-[10px] font-bold uppercase text-black"
    >
      🤖 Agent
    </span>
  );
}
