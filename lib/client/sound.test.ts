// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MUTE_KEY,
  _resetSoundForTests,
  playSound,
  setMuted,
  soundForAction,
  unlockAudio,
} from "./sound";

let created: number;
let resume: () => Promise<void>;

class FakeCtx {
  currentTime = 0;
  state = "suspended";
  destination = {};
  constructor() {
    resume = vi.fn(() => Promise.resolve());
  }
  resume() {
    return resume();
  }
  createOscillator() {
    created++;
    return {
      type: "",
      frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }
}

beforeEach(() => {
  created = 0;
  localStorage.clear();
  _resetSoundForTests();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
});

describe("sound", () => {
  it("maps actions to sounds", () => {
    expect(soundForAction("SPEAKING")).toHaveLength(1);
    expect(soundForAction("SEARCHING")).toBe(soundForAction("FACT_CHECKING"));
    expect(soundForAction("CONSENSUS")).toBe(soundForAction("DONE"));
    expect(soundForAction("PAUSED")).toHaveLength(2);
    expect(soundForAction("FALLBACK")?.[0].freq).toBeLessThan(100);
    expect(soundForAction("ERROR")?.[2].endFreq).toBeLessThan(soundForAction("ERROR")![0].freq);
    expect(soundForAction("THINKING")).toBeUndefined();
  });

  it("is silent before a user gesture unlocks audio", () => {
    playSound("DONE");
    expect(created).toBe(0);
    unlockAudio();
    expect(resume).toHaveBeenCalled();
    playSound("DONE");
    expect(created).toBe(6);
  });

  it("throttles SPEAKING to one per 120ms", () => {
    unlockAudio();
    playSound("SPEAKING", 1000);
    playSound("SPEAKING", 1050);
    playSound("SPEAKING", 1119);
    expect(created).toBe(1);
    playSound("SPEAKING", 1120);
    expect(created).toBe(2);
  });

  it("does nothing when muted and persists the setting", () => {
    unlockAudio();
    setMuted(true);
    expect(localStorage.getItem(MUTE_KEY)).toBe("1");
    playSound("ERROR");
    expect(created).toBe(0);
  });

  it("no-ops without Web Audio", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    unlockAudio();
    expect(() => playSound("DONE")).not.toThrow();
    expect(created).toBe(0);
  });
});
