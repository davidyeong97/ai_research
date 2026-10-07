import type { CouncilAction } from "@/lib/shared";

/** 8-bit style sound effects synthesized with the Web Audio API (no asset files). */

export const MUTE_KEY = "council:muted";
export const SPEAK_MIN_INTERVAL_MS = 120;

interface Note {
  freq: number;
  start: number; // seconds from now
  dur: number;
  type: OscillatorType;
  gain?: number;
  endFreq?: number;
}

const SOUNDS: Partial<Record<CouncilAction, Note[]>> = {
  SPEAKING: [{ freq: 520, start: 0, dur: 0.05, type: "square", gain: 0.05 }],
  SEARCHING: [523, 659, 784, 1047].map((freq, i) => ({
    freq,
    start: i * 0.07,
    dur: 0.07,
    type: "square" as const,
  })),
  FALLBACK: [{ freq: 80, start: 0, dur: 0.25, type: "square", gain: 0.12 }],
  CONSENSUS: [523, 659, 784, 1047, 784, 1047].map((freq, i) => ({
    freq,
    start: i * 0.1,
    dur: i >= 4 ? 0.3 : 0.1,
    type: "triangle" as const,
    gain: 0.15,
  })),
  ERROR: [
    { freq: 440, start: 0, dur: 0.15, type: "square" },
    { freq: 330, start: 0.15, dur: 0.15, type: "square" },
    { freq: 220, start: 0.3, dur: 0.3, type: "square", endFreq: 110 },
  ],
  PAUSED: [
    { freq: 660, start: 0, dur: 0.1, type: "triangle", gain: 0.15 },
    { freq: 440, start: 0.12, dur: 0.14, type: "triangle", gain: 0.15 },
  ],
};
SOUNDS.FACT_CHECKING = SOUNDS.SEARCHING;
SOUNDS.DONE = SOUNDS.CONSENSUS;

/** Pure mapping used by tests: which notes an action produces (undefined = silent). */
export function soundForAction(action: CouncilAction): readonly Note[] | undefined {
  return SOUNDS[action];
}

type AudioCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let muted: boolean | null = null;
let lastSpeakAt = -Infinity;

function audioCtor(): AudioCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

export function isMuted(): boolean {
  if (muted === null) {
    try {
      muted = typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      muted = false;
    }
  }
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** Create/resume the AudioContext. Call from a user gesture handler. Safe to call repeatedly. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const Ctor = audioCtor();
      if (!Ctor) return;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume()?.catch?.(() => {});
  } catch {
    ctx = null;
  }
}

/** Play the sound for an event action. No-op when muted, locked, throttled, or unsupported. */
export function playSound(action: CouncilAction, now: number = Date.now()): void {
  const notes = SOUNDS[action];
  if (!notes || !ctx || isMuted()) return;
  if (action === "SPEAKING") {
    if (now - lastSpeakAt < SPEAK_MIN_INTERVAL_MS) return;
    lastSpeakAt = now;
  }
  try {
    const t0 = ctx.currentTime;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type;
      const s = t0 + n.start;
      osc.frequency.setValueAtTime(n.freq, s);
      if (n.endFreq) osc.frequency.linearRampToValueAtTime(n.endFreq, s + n.dur);
      const peak = n.gain ?? 0.1;
      g.gain.setValueAtTime(peak, s);
      g.gain.exponentialRampToValueAtTime(0.0001, s + n.dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(s);
      osc.stop(s + n.dur + 0.02);
    }
  } catch {
    /* ignore audio failures */
  }
}

/** Test helper: reset module state. */
export function _resetSoundForTests(): void {
  ctx = null;
  muted = null;
  lastSpeakAt = -Infinity;
}
