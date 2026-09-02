"use client";

import { useEffect, useState } from "react";

import { fetchTransports, type TransportSummary } from "./api";
import { TransportConnectionSection } from "./TransportConnectionSection";

/**
 * One connection section per registered transport, for the assistant editor.
 * The roster comes from the registration table, so a freshly deployed
 * transport appears here without any core change — the whole point of the
 * schema-driven design.
 */
export function TransportSections({
  assistantId,
  refreshSignal,
}: {
  assistantId: string;
  refreshSignal: number;
}) {
  const [transports, setTransports] = useState<TransportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTransports()
      .then((rows) => {
        if (!cancelled) setTransports(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load transports");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!transports) return <p className="text-sm text-faint">Loading transports…</p>;
  if (transports.length === 0) {
    return (
      <p className="text-sm text-muted">
        No transport has registered with this core yet — start one (the telegram service) and
        it appears here by itself.
      </p>
    );
  }

  return (
    <>
      {transports.map((transport) => (
        <div key={transport.id} className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold tracking-tight">
            {transport.name} connection
          </h3>
          {transport.compatible ? (
            <TransportConnectionSection
              transport={transport}
              assistantId={assistantId}
              refreshSignal={refreshSignal}
            />
          ) : (
            <p className="text-sm text-danger">
              Refused: {transport.refusedReason}. Nothing can connect through it until the
              versions agree.
            </p>
          )}
        </div>
      ))}
    </>
  );
}
