export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __councilRecovered?: boolean };
  if (g.__councilRecovered) return;
  g.__councilRecovered = true;
  const { recoverStrandedQuests } = await import("./lib/council/recovery");
  recoverStrandedQuests();
  const { purgeExpired } = await import("./lib/council/cache");
  purgeExpired();
  const { purgeStaleUploads } = await import("./lib/council/attachments");
  purgeStaleUploads().catch(() => {});
  const { consolidateOnStartup } = await import("./lib/council/memory/consolidate");
  consolidateOnStartup();
}
