import { describe } from "vitest";

/**
 * Platform guard for the handful of suites that spawn a **real** stub binary.
 *
 * Almost everything here is pure and runs anywhere. The exceptions are the two
 * yt-dlp suites: what they prove is that the app executes the right file — which
 * copy of the binary a download runs, and that a downloaded one is executed
 * before it is allowed to replace a working install. A stub for that has to be
 * an actual executable, and the portable way to write one is a shebang script.
 *
 * Windows cannot spawn those: `CreateProcess` runs PE binaries, and Node
 * deliberately refuses `.bat`/`.cmd` without a shell. So on a Windows host these
 * cases are not failing tests, they are tests that cannot mean anything — and the
 * platform they describe is Linux either way, since that is what the image runs
 * (and where `ytDlpAssetName` even has a build to install; Windows keeps whatever
 * is on `PATH` by design).
 *
 * Skipped rather than rewritten around a mocked `spawn`, which would drop exactly
 * the guarantee they exist for. Run them with `npm run test:linux`, which runs
 * the suite in the container the app ships in.
 */
export const describeOnPosix = describe.skipIf(process.platform === "win32");
