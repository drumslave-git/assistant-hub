"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import { LiveIndicator as SharedLiveIndicator } from "@assistant-hub-swarm/ui";
import type { RealtimeTopic } from "@/lib/realtime";

/**
 * The shell's live pill: the shared indicator wired to a Server Component
 * refresh, which is how every page in this app holds its data. A page that
 * fetches on the client uses the shared component directly and hands it a
 * re-fetch — `router.refresh()` cannot reach state a `fetch` put in the
 * client.
 */
export function LiveIndicator({ topic }: { topic: RealtimeTopic | RealtimeTopic[] }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  return <SharedLiveIndicator topic={topic} onEvent={refresh} />;
}
