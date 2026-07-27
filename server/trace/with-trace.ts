import "server-only";

import { startTrace, type StartTraceInput, type TraceRecorder } from "./recorder";

/**
 * Run one traced unit of work, owning the try/fail/rethrow contract that every
 * traced mutation used to repeat by hand: open the trace, run the body, and —
 * exactly once — settle it. A thrown error settles the trace as failed and is
 * rethrown; a body that returns without settling is settled as a plain success.
 *
 * The body may still settle explicitly (`trace.succeed({ outputSummary, … })`,
 * `trace.skip(…)`) to control the summary — the wrapper only fills in whichever
 * settle did not happen, so double-settles are impossible by construction.
 */
export async function withTrace<T>(
  input: StartTraceInput,
  body: (trace: TraceRecorder) => Promise<T>,
): Promise<T> {
  const inner = await startTrace(input);
  let settled = false;
  const trace: TraceRecorder = {
    id: inner.id,
    event: (event) => inner.event(event),
    setInputSummary: (summary) => inner.setInputSummary(summary),
    async succeed(finish) {
      settled = true;
      await inner.succeed(finish);
    },
    async skip(reason, finish) {
      settled = true;
      await inner.skip(reason, finish);
    },
    async fail(error, finish) {
      settled = true;
      await inner.fail(error, finish);
    },
  };

  try {
    const result = await body(trace);
    if (!settled) await trace.succeed();
    return result;
  } catch (err) {
    if (!settled) {
      settled = true;
      await inner.fail(err);
    }
    throw err;
  }
}
