import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/server/service", () => ({
  getLlmRuntime: vi.fn(),
  getVisionRuntime: vi.fn(),
  getAudioRuntime: vi.fn(),
  getTimezone: vi.fn(),
}));
vi.mock("@/db/drizzle", () => ({ getDb: () => ({}) }));

const settings = await import("@/features/settings/server/service");
const mockedChat = vi.mocked(settings.getLlmRuntime);
const mockedVision = vi.mocked(settings.getVisionRuntime);

const { chatModelReadsImages } = await import("./service");

/**
 * The gate on attaching raw image parts to a reply request: only when the chat
 * model IS the vision model. Getting this wrong 400s the whole reply on a
 * text-only chat provider (trace `f37d84b9…`, 2026-08-15).
 */
describe("chatModelReadsImages", () => {
  beforeEach(() => {
    mockedChat.mockReset();
    mockedVision.mockReset();
  });

  const runtime = (baseUrl: string, model: string) =>
    ({ baseUrl, model, apiKey: null, backend: "llamacpp" }) as never;

  it("is true when the vision role resolves to the chat connection (no override)", async () => {
    mockedChat.mockResolvedValue(runtime("https://llm.test/v1", "gemma"));
    mockedVision.mockResolvedValue(runtime("https://llm.test/v1", "gemma"));
    await expect(chatModelReadsImages()).resolves.toBe(true);
  });

  it("is false when vision points at a different model — the operator's split setup", async () => {
    // The live failure: chat on Z.ai glm-4.7-flash (text-only), vision on a
    // local multimodal model. The describe pass works; attaching raw images to
    // the chat request is what broke.
    mockedChat.mockResolvedValue(runtime("https://api.z.ai/api/paas/v4", "glm-4.7-flash"));
    mockedVision.mockResolvedValue(runtime("https://llama.test", "gemma4-26b"));
    await expect(chatModelReadsImages()).resolves.toBe(false);
  });

  it("is false when vision shares the endpoint but not the model", async () => {
    mockedChat.mockResolvedValue(runtime("https://llm.test/v1", "chat-model"));
    mockedVision.mockResolvedValue(runtime("https://llm.test/v1", "vision-model"));
    await expect(chatModelReadsImages()).resolves.toBe(false);
  });

  it("is false when either role is unconfigured or unreadable", async () => {
    mockedChat.mockResolvedValue(runtime("https://llm.test/v1", "gemma"));
    mockedVision.mockResolvedValue(null as never);
    await expect(chatModelReadsImages()).resolves.toBe(false);

    mockedChat.mockRejectedValue(new Error("db down"));
    mockedVision.mockResolvedValue(runtime("https://llm.test/v1", "gemma"));
    await expect(chatModelReadsImages()).resolves.toBe(false);
  });
});
