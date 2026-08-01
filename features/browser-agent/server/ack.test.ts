import { afterEach, describe, expect, it } from "vitest";

import { __resetRunAcksForTests, registerRunAck, takeRunAck } from "./ack";

afterEach(() => {
  __resetRunAcksForTests();
});

describe("browser-agent run acks", () => {
  it("hands a registered ack to the runner exactly once", () => {
    expect(registerRunAck("run-1", "42", 100)).toBe("stored");
    expect(registerRunAck("run-1", "42", 101)).toBe("stored");

    expect(takeRunAck("run-1")).toEqual({ chatId: "42", messageIds: [100, 101] });
    // Taken means gone — a second settle sweep must not delete anything again.
    expect(takeRunAck("run-1")).toBeNull();
  });

  it("tells a late registration the run already settled", () => {
    // The run finished before the reply carrying the ack was delivered.
    expect(takeRunAck("run-2")).toBeNull();

    // Every late chunk learns the same thing — the caller deletes immediately.
    expect(registerRunAck("run-2", "42", 200)).toBe("settled");
    expect(registerRunAck("run-2", "42", 201)).toBe("settled");
  });

  it("keeps runs independent", () => {
    registerRunAck("run-a", "1", 1);
    registerRunAck("run-b", "2", 2);

    expect(takeRunAck("run-a")).toEqual({ chatId: "1", messageIds: [1] });
    expect(takeRunAck("run-b")).toEqual({ chatId: "2", messageIds: [2] });
  });
});
