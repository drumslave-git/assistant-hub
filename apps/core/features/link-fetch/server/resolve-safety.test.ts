import { describe, expect, it } from "vitest";

import { hostResolvesPublic } from "./resolve-safety";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }));

const failLookup = async (): Promise<{ address: string }[]> => {
  throw new Error("ENOTFOUND");
};

describe("hostResolvesPublic", () => {
  it("judges literal IPs without a lookup", async () => {
    // Lookup would throw — proving literals never resolve.
    expect(await hostResolvesPublic("93.184.216.34", undefined, failLookup)).toBe(true);
    expect(await hostResolvesPublic("10.0.0.5", undefined, failLookup)).toBe(false);
    expect(await hostResolvesPublic("[::1]", undefined, failLookup)).toBe(false);
  });

  it("allows a name whose every address is public", async () => {
    expect(
      await hostResolvesPublic("site.example", undefined, resolvesTo("93.184.216.34", "2606:4700::1")),
    ).toBe(true);
  });

  it("blocks a name when any resolved address is private", async () => {
    expect(
      await hostResolvesPublic("evil.example", undefined, resolvesTo("93.184.216.34", "10.0.0.5")),
    ).toBe(false);
    expect(
      await hostResolvesPublic("rebind.example", undefined, resolvesTo("169.254.169.254")),
    ).toBe(false);
  });

  it("blocks an unresolvable name — unverifiable must not mean allowed", async () => {
    expect(await hostResolvesPublic("nope.invalid", undefined, failLookup)).toBe(false);
  });

  it("caches verdicts per hostname", async () => {
    const cache = new Map<string, boolean>();
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return [{ address: "93.184.216.34" }];
    };
    expect(await hostResolvesPublic("site.example", cache, counting)).toBe(true);
    expect(await hostResolvesPublic("SITE.example", cache, counting)).toBe(true);
    expect(calls).toBe(1);
  });
});
