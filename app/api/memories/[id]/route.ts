import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  DuplicateMemoryError,
  MEMORY_KINDS,
  deleteMemory,
  updateMemory,
} from "@/lib/council/memory/store";
import { MAX_MEMORY_CHARS, publicMemory } from "@/lib/council/memory/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z
  .object({
    content: z.string().trim().min(1).max(MAX_MEMORY_CHARS).optional(),
    pinned: z.boolean().optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
  })
  .strict();

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid patch" }, { status: 400 });
  try {
    const m = await updateMemory(id, parsed.data, { rejectDuplicates: true });
    if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ memory: publicMemory(m) });
  } catch (e) {
    if (e instanceof DuplicateMemoryError) {
      return NextResponse.json({ error: e.message, existingId: e.existingId }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!deleteMemory(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: 1 });
}
