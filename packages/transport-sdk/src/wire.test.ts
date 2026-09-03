import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { wireContractFiles } from "../scripts/generate-wire-contract";
import { CONTRACT_MAJOR } from "./index";

/**
 * The committed wire contract must be what the code generates.
 *
 * `docs/api/transport/` is what a transport author in another language reads,
 * and a contract that quietly stops describing the schemas is worse than none
 * at all — it is a document that lies. So the check is not "does it parse":
 * the generator runs here and its output is compared byte for byte with the
 * files on disk. This runs in `npm run test`, which is what CI runs before it
 * releases anything.
 */

describe("the generated wire contract", () => {
  for (const file of wireContractFiles()) {
    const name = basename(file.path);

    it(`${name} matches the schemas it was generated from`, () => {
      let committed: string;
      try {
        committed = readFileSync(file.path, "utf8");
      } catch {
        throw new Error(
          `${name} is missing. Run: npm run wire:generate -w @assistant-hub-swarm/transport-sdk`,
        );
      }
      // Line endings are the working tree's business, not the contract's.
      const normalize = (text: string) => text.replace(/\r\n/g, "\n");
      expect(
        normalize(committed),
        `${name} is out of date. Run: npm run wire:generate -w @assistant-hub-swarm/transport-sdk`,
      ).toBe(normalize(file.content));
    });
  }

  it("states the contract major both sides handshake on", () => {
    const events = wireContractFiles().find((f) => f.path.endsWith(".json"));
    expect(JSON.parse(events!.content)["x-contract-major"]).toBe(CONTRACT_MAJOR);
  });
});
