/**
 * Async coordination helpers for tests that hold work mid-flight or prove two
 * operations genuinely overlapped.
 */

/** A deferred promise for pausing a run mid-flight. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A rendezvous point: every caller of the returned function blocks until `n`
 * callers have arrived, then all proceed. Proves true overlap — if the callers
 * were secretly serialized, the first would never be released and the test
 * times out instead of passing vacuously.
 */
export function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  const all = deferred();
  return () => {
    arrived += 1;
    if (arrived >= n) all.resolve();
    return all.promise;
  };
}
