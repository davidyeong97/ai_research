// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SoundToggle } from "./SoundToggle";
import { MUTE_KEY, _resetSoundForTests } from "@/lib/client/sound";

beforeEach(() => {
  localStorage.clear();
  _resetSoundForTests();
});
afterEach(cleanup);

describe("SoundToggle", () => {
  it("defaults to unmuted and persists toggling", () => {
    const { unmount } = render(<SoundToggle />);
    const btn = screen.getByTestId("sound-toggle");
    expect(btn.textContent).toBe("🔊");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("🔇");
    expect(localStorage.getItem(MUTE_KEY)).toBe("1");
    unmount();
    _resetSoundForTests();
    render(<SoundToggle />);
    expect(screen.getByTestId("sound-toggle").textContent).toBe("🔇");
    fireEvent.click(screen.getByTestId("sound-toggle"));
    expect(localStorage.getItem(MUTE_KEY)).toBe("0");
  });
});
