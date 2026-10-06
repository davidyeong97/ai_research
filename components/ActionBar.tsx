const BTN =
  "min-h-11 min-w-11 flex-1 border-2 border-black bg-amber-300 px-3 text-xs font-bold uppercase text-black shadow-[2px_2px_0_0_#000] disabled:cursor-not-allowed disabled:opacity-50";

export function ActionBar() {
  return (
    <form
      aria-label="Quest actions"
      onSubmit={(e) => e.preventDefault()}
      className="flex-none space-y-2 border-t-4 border-amber-200/80 bg-indigo-950 px-3 pt-2 pb-2"
    >
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="Quest"
          placeholder="Enter your quest…"
          enterKeyHint="send"
          className="min-h-11 min-w-0 flex-1 border-2 border-black bg-black/50 px-3 text-base text-white placeholder:text-indigo-300"
        />
        <button type="submit" disabled className={`${BTN} flex-none`}>
          Go
        </button>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled className={BTN}>
          Pause
        </button>
        <button type="button" disabled className={BTN}>
          Inject
        </button>
        <button type="button" disabled className={BTN}>
          Approve
        </button>
      </div>
    </form>
  );
}
