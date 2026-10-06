import { getBus } from "@/lib/council/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const raw = req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  const after = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsub = () => {};
      const timer = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(": heartbeat\n\n"));
      }, HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsub();
        clearInterval(timer);
        req.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) return cleanup();

      controller.enqueue(enc.encode("retry: 3000\n\n"));
      unsub = getBus().subscribe(id, after, (e) => {
        if (closed) return;
        controller.enqueue(enc.encode(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));
        if (e.action === "DONE" || e.action === "ERROR") queueMicrotask(cleanup);
      });
      // A terminal event may have been replayed during subscribe().
      if (closed) unsub();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
