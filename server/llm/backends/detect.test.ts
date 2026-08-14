import { afterEach, describe, expect, it, vi } from "vitest";

import { detectBackend } from "./detect";

/**
 * Endpoint fingerprinting. The probe paths are the ones a real server answers —
 * `/api/version` was confirmed against a live Ollama 0.32.6, which replies
 * `{"version":"0.32.6"}` — and the responses below are those shapes.
 *
 * What these defend is the *ordering* and the failure behavior, which is where
 * a fingerprint goes wrong: Ollama and vLLM both serve a `version` endpoint, and
 * a probe that cannot identify a server must leave the operator's choice alone
 * rather than guess.
 */

/** Answer `routes` by path; 404 anything else. */
function stubRoutes(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(String(url)).pathname;
    if (!(path in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("detectBackend", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("identifies Ollama from its namespaced version route", async () => {
    stubRoutes({ "/api/version": { version: "0.32.6" } });
    expect(await detectBackend("https://host.invalid/v1")).toEqual({
      backend: "ollama",
      detail: "Ollama 0.32.6",
    });
  });

  it("identifies llama.cpp from /props, which carries no version field", async () => {
    stubRoutes({ "/props": { chat_template: "{{ ... }}", model_path: "/models/m.gguf" } });
    const result = await detectBackend("https://host.invalid/v1");
    expect(result.backend).toBe("llamacpp");
    expect(result.detail).toContain("m.gguf");
  });

  it("identifies vLLM from its bare version route", async () => {
    stubRoutes({ "/version": { version: "0.8.2" } });
    expect(await detectBackend("https://host.invalid/v1")).toEqual({
      backend: "vllm",
      detail: "vLLM 0.8.2",
    });
  });

  it("prefers Ollama when both version routes answer, since /version is generic", async () => {
    // An Ollama host serving both would otherwise be reported as vLLM.
    stubRoutes({ "/api/version": { version: "0.32.6" }, "/version": { version: "0.8.2" } });
    expect((await detectBackend("https://host.invalid/v1")).backend).toBe("ollama");
  });

  it("identifies Anthropic by hostname alone, without sending a single probe", async () => {
    // Anthropic serves no unauthenticated fingerprint route, so a probe could
    // only fail; the hostname is the signature.
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response("nope", { status: 404 });
    });
    const result = await detectBackend("https://api.anthropic.com/v1");
    expect(result.backend).toBe("anthropic");
    expect(seen).toEqual([]);
  });

  it("identifies Gemini by hostname alone, without sending a single probe", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response("nope", { status: 404 });
    });
    const result = await detectBackend("https://generativelanguage.googleapis.com/v1beta");
    expect(result.backend).toBe("google");
    expect(seen).toEqual([]);
  });

  it("suggests nothing when no server names itself, leaving the choice alone", async () => {
    stubRoutes({});
    const result = await detectBackend("https://host.invalid/v1");
    expect(result.backend).toBeNull();
    expect(result.detail).toMatch(/Generic/i);
  });

  it("probes the origin, not the /v1 path the model routes live under", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response("nope", { status: 404 });
    });
    await detectBackend("https://host.invalid/some/deep/v1");
    // These are native admin routes that sit beside /v1, never under it.
    expect(seen).toContain("https://host.invalid/api/version");
    expect(seen.every((u) => !u.includes("/some/deep"))).toBe(true);
  });

  it("reports a bad URL instead of throwing", async () => {
    expect(await detectBackend("not a url")).toEqual({
      backend: null,
      detail: "Not a valid URL",
    });
  });

  it("treats an unreachable endpoint as unidentified, never as an error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await detectBackend("https://host.invalid/v1")).backend).toBeNull();
  });
});
