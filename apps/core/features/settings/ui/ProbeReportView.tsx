"use client";

import { ArrowRight } from "lucide-react";

import type { ProbePart, ProbeReport } from "../server/schema";

/**
 * What a "Test …" button produced, rendered the same way for every role: what
 * was sent on the left, what came back on the right.
 *
 * The roles exchange very different things — a phrase and a vector, a prompt
 * and an image, silence and a transcript — but an operator is asking the same
 * question of each ("did this actually work, and does the answer look right?"),
 * so there is one component rather than seven bespoke result panels. Each probe
 * describes its exchange in {@link ProbePart}s and this decides how they look.
 */
export function ProbeReportView({ report }: { report: ProbeReport }) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{report.model}</span>
        <span className="text-faint">answered in {formatDuration(report.latencyMs)}</span>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-start">
        <ProbeSide title="Sent" parts={report.input} />
        <ArrowRight className="hidden h-4 w-4 self-center text-faint md:block" aria-hidden />
        <ProbeSide title="Received" parts={report.output} />
      </div>
    </div>
  );
}

function ProbeSide({ title, parts }: { title: string; parts: ProbePart[] }) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium tracking-wide text-faint uppercase">{title}</h4>
      {parts.map((part, index) => (
        <div key={`${part.label}-${index}`} className="space-y-1">
          <p className="text-xs text-muted">{part.label}</p>
          <ProbePartValue part={part} />
        </div>
      ))}
    </div>
  );
}

function ProbePartValue({ part }: { part: ProbePart }) {
  switch (part.kind) {
    case "text":
      // Long answers scroll rather than pushing the Save button off-screen;
      // `whitespace-pre-wrap` keeps a model's own line breaks.
      return (
        <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">
          {part.text}
        </p>
      );
    case "image":
      return (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the probe, not a served asset
        <img
          src={part.dataUrl}
          alt={part.label}
          className="max-h-64 w-auto max-w-full rounded border border-border"
        />
      );
    case "audio":
      return <audio controls src={part.dataUrl} className="w-full max-w-sm" />;
    case "vector":
      return (
        <div className="space-y-1">
          <p className="text-sm text-foreground">{part.dimensions} dimensions</p>
          <p className="font-mono text-xs break-all text-muted">
            [{part.preview.map((n) => n.toFixed(4)).join(", ")}
            {part.preview.length < part.dimensions ? ", …" : ""}]
          </p>
        </div>
      );
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
