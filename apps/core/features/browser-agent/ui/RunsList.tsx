"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Download,
  Globe,
  Loader2,
  X,
} from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { cn } from "@/lib/cn";

import { formatBytes } from "../files";
import type {
  BrowserAgentRun,
  BrowserAgentRunDetail,
  BrowserRunStep,
} from "../types";
import { runStatusBadge } from "./statusTone";

/** One activity-feed row: tool, action, outcome. */
function StepRow({ step }: { step: BrowserRunStep }) {
  return (
    <li className="flex items-start gap-2 py-1 text-sm">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {step.ok ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <X className="h-4 w-4 text-danger" />
        )}
      </span>
      <span className="w-6 shrink-0 text-right font-mono text-xs text-faint">
        {step.seq}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <code className="rounded bg-surface-2 px-1 py-0.5 text-xs text-muted">
            {step.tool}
          </code>
          <span className="text-foreground">{step.action}</span>
        </div>
        {step.summary ? (
          <p
            className={cn(
              "truncate text-xs",
              step.ok ? "text-muted" : "text-danger",
            )}
          >
            {step.summary}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The expanded, live detail for one run: a current-action banner with download
 * progress while it runs, the step-by-step activity feed, the report, downloads,
 * and screenshots. While the run is queued/running it polls the run-detail API so
 * steps and progress stream in without a page reload; polling stops on settle.
 */
function RunDetail({ run }: { run: BrowserAgentRun }) {
  const [detail, setDetail] = useState<BrowserAgentRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`/api/browser/${run.id}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
        const body = (await res.json()) as { data: BrowserAgentRunDetail };
        if (!activeRef.current) return;
        setDetail(body.data);
        setError(null);
        // Keep polling only while the run is in flight; ~1.2s is live enough for
        // steps and a download progress line without hammering the server.
        if (body.data.status === "queued" || body.data.status === "running") {
          timer = setTimeout(tick, 1200);
        }
      } catch (err) {
        if (!activeRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load run");
        timer = setTimeout(tick, 3000);
      }
    };
    void tick();

    return () => {
      activeRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [run.id]);

  const view = detail ?? run;
  const activity = detail?.activity ?? [];
  const screenshotSeqs = detail?.screenshotSeqs ?? [];
  const live = detail?.live ?? null;
  const running = view.status === "running" || view.status === "queued";

  return (
    <div className="space-y-4 bg-surface-2/40 px-4 py-4">
      {/* Live banner: what the agent is doing right now + download progress. */}
      {running ? (
        <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2">
          <Loader2
            className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-info motion-reduce:animate-none"
            aria-hidden
          />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-info">
              {view.status === "queued"
                ? "Queued — waiting for a runner…"
                : (live?.currentAction ?? "Working…")}
            </p>
            {live?.progress ? (
              <p className="mt-0.5 font-mono text-xs text-muted">
                {live.progress}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {view.error ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">
            Error
          </p>
          <p className="mt-1 text-sm text-danger">{view.error}</p>
        </div>
      ) : null}

      {/* Activity feed — every action the agent took, in order. */}
      {activity.length > 0 ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">
            Activity ({activity.length} step{activity.length === 1 ? "" : "s"})
          </p>
          <ScrollArea className="mt-1">
            <ul className="divide-y divide-border/60">
              {activity.map((step) => (
                <StepRow key={step.seq} step={step} />
              ))}
            </ul>
          </ScrollArea>
        </div>
      ) : running ? (
        <p className="text-sm text-muted">No actions yet…</p>
      ) : null}

      {view.report ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">
            Report
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
            {view.report}
          </p>
        </div>
      ) : null}

      {view.downloads.length > 0 ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">
            Downloads
          </p>
          <ul className="mt-1 space-y-1">
            {view.downloads.map((file, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <Download className="h-3.5 w-3.5 text-muted" aria-hidden />
                <span>{file.filename}</span>
                <span className="text-muted">
                  · {formatBytes(file.sizeBytes)} ·{" "}
                  {file.deliveredToChat ? "sent to chat" : "downloads folder"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {screenshotSeqs.length > 0 ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">
            Screenshots ({screenshotSeqs.length})
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {screenshotSeqs.map((seq) => (
              <a
                key={seq}
                href={`/api/browser/${run.id}/screenshot/${seq}`}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- run screenshots are dynamic bytea served from our API, not build-time assets */}
                <img
                  src={`/api/browser/${run.id}/screenshot/${seq}`}
                  alt={`Screenshot ${seq + 1}`}
                  className="h-32 w-full object-cover object-top"
                />
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live-refreshing table of browser-agent runs. Each row expands to show the
 * report, downloads, and screenshots (fetched lazily on expand). The page as a
 * whole re-renders on the `browser` SSE topic, so status/step counts advance
 * without a manual reload; this component only owns the expand state.
 */
export function RunsList({ runs }: { runs: BrowserAgentRun[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useCallback(
    (id: string) => setOpenId((current) => (current === id ? null : id)),
    [],
  );

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="No runs yet"
        description="Start a run above, or ask the bot in Telegram to browse the web for you."
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table minWidth={640}>
          <TableHead>
            <TableRow header>
              <TableHeaderCell className="w-8" />
              <TableHeaderCell>Goal</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell align="right">Steps</TableHeaderCell>
              <TableHeaderCell align="right">Files</TableHeaderCell>
              <TableHeaderCell>Started</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {runs.map((run) => {
              const open = openId === run.id;
              const badge = runStatusBadge(run.status);
              return (
                <Fragment key={run.id}>
                  <TableRow
                    interactive
                    onClick={() => toggle(run.id)}
                    aria-expanded={open}
                  >
                    <TableCell valign="middle" className="text-muted">
                      {open ? (
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      )}
                    </TableCell>
                    <TableCell valign="middle" className="max-w-md">
                      <span className={cn("line-clamp-2", !open && "truncate")}>
                        {run.goal}
                      </span>
                    </TableCell>
                    <TableCell valign="middle">
                      <Badge tone={badge.tone} dot={run.status === "running"}>
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell valign="middle" align="right">
                      {run.steps}
                    </TableCell>
                    <TableCell valign="middle" align="right">
                      {run.downloads.length}
                    </TableCell>
                    <TableCell
                      valign="middle"
                      className="whitespace-nowrap text-muted"
                    >
                      <Timestamp iso={run.startedAt ?? run.createdAt} />
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <tr>
                      <td colSpan={6} className="border-b border-border p-0">
                        <RunDetail run={run} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
