import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Poller supervision: what happens when the network goes away underneath a
 * running bot. Written against the 2026-08-01 incident — a few hours without a
 * connection left the bot dead long after it came back, and Stop from the
 * dashboard did nothing at all.
 *
 * Everything below the manager is mocked: this is about the lifecycle state
 * machine (reconnect, transition lock, runner identity), not about grammy.
 */

const mocks = vi.hoisted(() => {
  class MockHttpError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "HttpError";
    }
  }
  class MockGrammyError extends Error {
    readonly description: string;
    constructor(message: string) {
      super(message);
      this.name = "GrammyError";
      this.description = message;
    }
  }
  return {
    HttpError: MockHttpError,
    GrammyError: MockGrammyError,
    init: vi.fn<(signal?: AbortSignal) => Promise<void>>(async () => undefined),
    getTelegramBotToken: vi.fn<() => Promise<string | null>>(async () => "token"),
    run: vi.fn(),
  };
});

/** One `run()` result, with the task rejection and the stop drain under test control. */
interface MockHandle {
  task: () => Promise<void> | undefined;
  stop: () => Promise<void>;
  isRunning: () => boolean;
  size: () => number;
  /** Reject the polling task, as the runner does when its fetch loop gives up. */
  crash: (err: unknown) => void;
  /** Whether `stop()` ever settles — a loop asleep in a backoff does not. */
  stopHangs: boolean;
  stopCalls: number;
  options: unknown;
}

const handles: MockHandle[] = [];

function makeHandle(options: unknown): MockHandle {
  let crash!: (err: unknown) => void;
  const task = new Promise<void>((_resolve, reject) => {
    crash = reject;
  });
  const handle: MockHandle = {
    task: () => task,
    stop: () => (handle.stopHangs ? new Promise<void>(() => {}) : Promise.resolve()),
    isRunning: () => true,
    size: () => 0,
    crash,
    stopHangs: false,
    stopCalls: 0,
    options,
  };
  const stop = handle.stop;
  handle.stop = () => {
    handle.stopCalls += 1;
    return stop();
  };
  return handle;
}

vi.mock("grammy", () => ({
  Bot: class {
    botInfo = { id: 1, username: "testbot", first_name: "Test" };
    api = {};
    constructor(public token: string) {}
    use(): void {}
    on(): void {}
    catch(): void {}
    init(signal?: AbortSignal): Promise<void> {
      return mocks.init(signal);
    }
  },
  GrammyError: mocks.GrammyError,
  HttpError: mocks.HttpError,
  InputFile: class {},
}));

vi.mock("@grammyjs/runner", () => ({
  run: mocks.run,
  sequentialize: () => () => undefined,
}));

vi.mock("@/features/settings/server/service", () => ({
  getTelegramBotToken: mocks.getTelegramBotToken,
}));
vi.mock("./process-update", () => ({ processUpdate: vi.fn(), processEditedUpdate: vi.fn() }));
vi.mock("./process-callback", () => ({ processCallbackUpdate: vi.fn() }));
vi.mock("./process-reaction", () => ({ processReactionUpdate: vi.fn() }));

import { getBotStatus, startBot, stopBot } from "./bot-manager";

/** Comfortably past both the reconnect delay and the stop drain timeout. */
const PAST_EVERY_TIMER_MS = 60_000;

const STORE_KEY = Symbol.for("llm-tg-bot.telegram.bot-manager");

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  handles.length = 0;
  mocks.run.mockReset();
  mocks.init.mockReset();
  mocks.getTelegramBotToken.mockReset();
  mocks.init.mockImplementation(async () => undefined);
  mocks.getTelegramBotToken.mockImplementation(async () => "token");
  mocks.run.mockImplementation((_bot: unknown, options: unknown) => {
    const handle = makeHandle(options);
    handles.push(handle);
    return handle;
  });
  // The manager is a `globalThis` singleton so it survives bundle boundaries;
  // drop it so each case starts from a stopped bot.
  delete (globalThis as Record<symbol, unknown>)[STORE_KEY];
});

afterEach(async () => {
  await stopBot();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startBot", () => {
  it("bounds the runner's own retry window instead of its 15-hour default", async () => {
    await startBot();
    expect(handles).toHaveLength(1);
    const runnerOpts = (handles[0].options as { runner: { maxRetryTime?: number } }).runner;
    expect(runnerOpts.maxRetryTime).toBeGreaterThan(0);
    expect(runnerOpts.maxRetryTime).toBeLessThanOrEqual(60_000);
  });

  it("bounds the handshake so a stalled connection cannot wedge a start", async () => {
    // grammy's own client timeout is 500s; a start must not hold the transition
    // lock (and the dashboard request behind it) for anything like that.
    mocks.init.mockImplementation(() => new Promise<void>(() => {}));
    const starting = startBot();
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);

    const status = await starting;
    expect(status.state).toBe("error");
    expect(status.error).toContain("reconnecting automatically");
  });

  it("stays stopped, and does not retry, when no token is configured", async () => {
    mocks.getTelegramBotToken.mockImplementation(async () => null);
    expect((await startBot()).state).toBe("stopped");
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("a lost connection", () => {
  it("reconnects on its own once the network is back", async () => {
    expect((await startBot()).state).toBe("running");

    handles[0].crash(new mocks.HttpError("Network request for 'getUpdates' failed!"));
    await vi.advanceTimersByTimeAsync(0);
    const down = getBotStatus();
    expect(down.state).toBe("error");
    expect(down.error).toContain("reconnecting automatically");

    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    expect(getBotStatus().state).toBe("running");
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying while the outage lasts, one attempt at a time", async () => {
    await startBot();
    handles[0].crash(new mocks.HttpError("network down"));
    await vi.advanceTimersByTimeAsync(0);
    // Every reconnect attempt fails the same way for as long as the link is out.
    mocks.init.mockImplementation(async () => {
      throw new mocks.HttpError("network still down");
    });

    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    const attempts = mocks.init.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    expect(getBotStatus().state).toBe("error");

    mocks.init.mockImplementation(async () => undefined);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    expect(getBotStatus().state).toBe("running");
  });

  it("does not spin when Telegram itself refused the token", async () => {
    await startBot();
    handles[0].crash(new mocks.GrammyError("Unauthorized"));
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);

    const status = getBotStatus();
    expect(status.state).toBe("error");
    expect(status.error).not.toContain("reconnecting");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("ignores a late rejection from a runner that was already replaced", async () => {
    await startBot();
    const stale = handles[0];
    await startBot(); // restart — the first runner is detached
    expect(getBotStatus().state).toBe("running");

    stale.crash(new mocks.HttpError("the old loop unwinding"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotStatus().state).toBe("running");
  });
});

describe("stopBot", () => {
  it("answers even while the fetch loop is asleep in a retry backoff", async () => {
    await startBot();
    // The incident's shape: `stop()` aborts, but its promise cannot settle until
    // the un-interruptible backoff sleep expires — hours, after a long outage.
    handles[0].stopHangs = true;

    const stopping = stopBot();
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    expect((await stopping).state).toBe("stopped");
    expect(handles[0].stopCalls).toBe(1);
  });

  it("leaves the manager startable after such a stop", async () => {
    await startBot();
    handles[0].stopHangs = true;
    const stopping = stopBot();
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    await stopping;

    expect((await startBot()).state).toBe("running");
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending reconnect", async () => {
    await startBot();
    handles[0].crash(new mocks.HttpError("network down"));
    await vi.advanceTimersByTimeAsync(0);

    expect((await stopBot()).state).toBe("stopped");
    await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMER_MS);
    expect(getBotStatus().state).toBe("stopped");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
