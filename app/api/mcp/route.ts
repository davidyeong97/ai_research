import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createCouncilMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stateless Streamable HTTP: a fresh server + transport per request, JSON responses.
export async function POST(req: Request): Promise<Response> {
  const server = createCouncilMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Defer close so the response body is fully produced first.
    queueMicrotask(() => void server.close().catch(() => {}));
  }
}

const notAllowed = () =>
  Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );

export const GET = notAllowed;
export const DELETE = notAllowed;
