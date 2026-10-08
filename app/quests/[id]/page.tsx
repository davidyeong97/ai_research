import { redirect } from "next/navigation";

export default async function QuestRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/?quest=${encodeURIComponent(id)}`);
}
