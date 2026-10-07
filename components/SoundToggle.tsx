"use client";

import { useEffect, useState } from "react";
import { isMuted, setMuted, unlockAudio } from "@/lib/client/sound";

export function SoundToggle() {
  const [muted, setLocal] = useState(false);
  useEffect(() => {
    // Read persisted value after mount to avoid hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocal(isMuted());
  }, []);
  return (
    <button
      type="button"
      data-testid="sound-toggle"
      aria-pressed={muted}
      aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
      title={muted ? "Unmute" : "Mute"}
      onClick={() => {
        const next = !muted;
        setMuted(next);
        setLocal(next);
        if (!next) unlockAudio();
      }}
      className="flex-none px-1 text-sm leading-none"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
