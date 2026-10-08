import { afterEach, describe, expect, it } from "vitest";
import { cacheKey } from "../cache";
import {
  estimatePromptTokens,
  hasMedia,
  loadCapabilities,
  setCapabilitiesFetch,
  supportsPdf,
  supportsVision,
  textOf,
  type ChatMessage,
} from "./index";
import { buildPlugins, toModelMessages } from "./openrouter";
import { MockLLMClient } from "./mock";

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const png2 = new Uint8Array([137, 80, 78, 71, 9, 9, 9]);
const pdf = new Uint8Array(120_000);

const msgs = (img: Uint8Array): ChatMessage[] => [
  { role: "system", content: "sys" },
  {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", data: img, mediaType: "image/png" },
    ],
  },
];

afterEach(() => {
  setCapabilitiesFetch(undefined);
  delete process.env.PDF_ENGINE;
});

describe("helpers", () => {
  it("textOf / hasMedia", () => {
    expect(textOf("a")).toBe("a");
    expect(textOf(msgs(png)[1].content)).toBe("look");
    expect(hasMedia(msgs(png))).toBe(true);
    expect(hasMedia([{ role: "user", content: "x" }])).toBe(false);
    expect(hasMedia([{ role: "user", content: [{ type: "text", text: "x" }] }])).toBe(false);
  });
});

describe("part mapping", () => {
  it("maps image and file parts, keeps strings", () => {
    const out = toModelMessages([
      ...msgs(png),
      {
        role: "user",
        content: [
          { type: "file", data: pdf, mediaType: "application/pdf", filename: "a.pdf" },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1].content).toEqual([
      { type: "text", text: "look" },
      { type: "image", image: png, mediaType: "image/png" },
    ]);
    expect(out[2].content).toEqual([
      { type: "file", data: pdf, mediaType: "application/pdf", filename: "a.pdf" },
    ]);
  });

  it("enables file-parser only with PDFs; engine configurable", () => {
    const pdfMsgs: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "file", data: pdf, mediaType: "application/pdf", filename: "a.pdf" }],
      },
    ];
    expect(buildPlugins({ messages: msgs(png) })).toEqual([]);
    expect(buildPlugins({ messages: pdfMsgs })).toEqual([
      { id: "file-parser", pdf: { engine: "pdf-text" } },
    ]);
    process.env.PDF_ENGINE = "mistral-ocr";
    expect(buildPlugins({ messages: pdfMsgs, webSearch: { maxResults: 2 } })).toEqual([
      { id: "web", max_results: 2 },
      { id: "file-parser", pdf: { engine: "mistral-ocr" } },
    ]);
    process.env.PDF_ENGINE = "bogus";
    expect(buildPlugins({ messages: pdfMsgs })[0]).toMatchObject({ pdf: { engine: "pdf-text" } });
  });
});

describe("mock", () => {
  it("records multimodal messages", async () => {
    const llm = new MockLLMClient("ok");
    for await (const _ of llm.streamChat({ messages: msgs(png), models: ["m"], maxTokens: 10 })) void _;
    expect(llm.calls[0].messages[1].content).toHaveLength(2);
  });
});

describe("capabilities", () => {
  it("uses static fallback offline", async () => {
    setCapabilitiesFetch(async () => {
      throw new Error("offline");
    });
    await loadCapabilities();
    expect(supportsVision("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(supportsVision("google/gemini-2.5-flash")).toBe(true);
    expect(supportsVision("x-ai/grok-4.1-fast")).toBe(true);
    expect(supportsVision("openai/gpt-5")).toBe(true);
    expect(supportsVision("deepseek/deepseek-chat")).toBe(false);
    expect(supportsVision("moonshotai/kimi-k2")).toBe(false);
    expect(supportsVision("qwen/qwen3-max")).toBe(false);
    expect(supportsPdf("deepseek/deepseek-chat")).toBe(false);
    expect(supportsVision("unknown/model")).toBe(false);
  });

  it("prefers endpoint metadata, fetched once", async () => {
    let n = 0;
    setCapabilitiesFetch(async () => {
      n++;
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "deepseek/deepseek-chat", architecture: { input_modalities: ["text", "image"] } },
            { id: "openai/gpt-5", architecture: { input_modalities: ["text"] } },
            { id: "google/gemini-2.5-pro", architecture: { input_modalities: ["text", "image", "file"] } },
          ],
        }),
      };
    });
    await Promise.all([loadCapabilities(), loadCapabilities()]);
    await loadCapabilities();
    expect(n).toBe(1);
    expect(supportsVision("deepseek/deepseek-chat")).toBe(true);
    expect(supportsVision("openai/gpt-5")).toBe(false);
    expect(supportsPdf("google/gemini-2.5-pro")).toBe(true);
    expect(supportsVision("anthropic/claude-sonnet-4.6")).toBe(true); // fallback
  });
});

describe("estimatePromptTokens", () => {
  it("counts text and media", () => {
    expect(estimatePromptTokens([{ role: "user", content: "abcdefgh" }])).toBe(2);
    expect(estimatePromptTokens(msgs(png))).toBe(1 + 1 + 1500);
    const withPdf = estimatePromptTokens([
      { role: "user", content: [{ type: "file", data: pdf, mediaType: "application/pdf", filename: "a.pdf" }] },
    ]);
    expect(withPdf).toBeGreaterThanOrEqual(2000);
    const b64 = Buffer.from(pdf).toString("base64");
    expect(
      estimatePromptTokens([
        { role: "user", content: [{ type: "file", data: b64, mediaType: "application/pdf", filename: "a.pdf" }] },
      ]),
    ).toBe(withPdf);
  });
});

describe("cacheKey", () => {
  const key = (m: ChatMessage[]) => cacheKey({ tool: "t", maxResults: 1, models: ["m"], messages: m });
  it("differs per image, stable for same bytes (bytes or base64)", () => {
    expect(key(msgs(png))).not.toBe(key(msgs(png2)));
    expect(key(msgs(png))).toBe(key(msgs(new Uint8Array(png))));
    const b64: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: Buffer.from(png).toString("base64"), mediaType: "image/png" },
        ],
      },
    ];
    expect(key(b64)).toBe(key(msgs(png)));
  });
  it("string content key unchanged in shape", () => {
    const a = key([{ role: "user", content: "Hi  there" }]);
    expect(a).toBe(key([{ role: "user", content: " hi there " }]));
  });
});
