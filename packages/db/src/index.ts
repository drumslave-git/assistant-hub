// No "server-only" guard here on purpose: this package serves plain-Node
// services as well as the Next core. The guard against
// client-bundle leaks lives at the app boundary (apps/core/db/pool.ts keeps
// its own `import "server-only"`).
export { getProcessPool, closeProcessPool } from "./pool";
