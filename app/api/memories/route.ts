import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { MAX_MEMORY_CHARS, publicMemory } from "@/lib/council/memory/api";
import { memoryEnabled } from "@/lib/council/memory/config";
import {
  MEMORY_KINDS,
  deleteBySourceQuest,
  insertMemory,
  listMemories,
  type MemoryKind,
} from "@/lib/council/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KindSchema = z.enum(MEMORY_KINDS);
const CreateSchema = z.object({ content: z.string().trim().min(1).max(MAX_MEMORY_CHARS) });

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kindRaw = sp.get("kind");
  if (kindRaw && !KindSchema.safeParse(kindRaw).success) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }
  const limitRaw = Number.parseInt(sp.get("limit") ?? "", 10);
  const memories = listMemories({
    kind: (kindRaw as MemoryKind | null) ?? undefined,
    q: sp.get("q") ?? undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : 100,
    sourceQuestId: sp.get("sourceQuest") ?? undefined,
  });
  return NextResponse.json({ enabled: memoryEnabled(), memories: memories.map(publicMemory) });
}

export async function POST(req: NextRequest) {
  if (!memoryEnabled()) {
    return NextResponse.json({ error: "Memory is disabled (MEMORY_ENABLED=false)" }, { status: 409 });
  }
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `content is required (1-${MAX_MEMORY_CHARS} chars)` },
      { status: 400 },
    );
  }
  const res = await insertMemory({
    kind: "preference",
    content: parsed.data.content,
    confidence: 1,
    sourceQuestId: null,
  });
  if (!res) return NextResponse.json({ error: "Could not store memory" }, { status: 500 });
  return NextResponse.json(
    { memory: publicMemory(res.memory), merged: res.merged },
    { status: res.merged ? 200 : 201 },
  );
}

export async function DELETE(req: NextRequest) {
  const questId = req.nextUrl.searchParams.get("sourceQuest");
  if (!questId) {
    return NextResponse.json({ error: "sourceQuest query parameter is required" }, { status: 400 });
  }
  return NextResponse.json({ deleted: deleteBySourceQuest(questId) });
}
