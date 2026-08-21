// Stub for the `server-only` import guard during tests. The real package throws
// when imported outside a React Server Component bundle, which would break unit
// tests of server modules; aliasing to this empty module neutralizes it.
export {};
