"use client";

import { useState, type ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  Spinner,
} from "@/components/ui";

import { CHART_PERIOD_UNITS, PERIOD_UNITS, type CardFilters, type MetricSource, type PeriodUnit } from "../types";
import { PeriodPicker } from "./PeriodPicker";

/**
 * The dashboard's one filtered-card shell.
 *
 * Every analytics card carries its own period and chat/user scope — there is no
 * page-level filter — so this owns that whole contract in one place: the controls,
 * the per-card state, the loading and error affordances, and the layout that keeps a
 * header readable once several controls sit in it. A card supplies its title, which
 * filters it actually honours, and how to render its data; nothing else.
 *
 * Which filters a card gets is deliberate, not incidental. A control that changes
 * nothing is worse than no control — it makes the reader believe they have sliced the
 * data when they have not — so `chats`/`users` are omitted by the cards those
 * dimensions are meaningless for rather than rendered inert.
 */

/** A selectable chat or user for the drill-down filter. */
export interface FilterOption {
  id: string;
  label: string;
}

export { CHART_PERIOD_UNITS, PERIOD_UNITS };

export interface FilterableCardProps {
  title: string;
  description?: string;
  /** Offer a chat filter. Omit entirely for cards where chat is meaningless. */
  chats?: FilterOption[];
  /** Offer a user filter. Omit entirely for cards where per-person is meaningless. */
  users?: FilterOption[];
  /**
   * Require a chat: the "All chats" option disappears and the first chat is
   * pre-selected. For the insight cards, whose numbers are scored per conversation
   * and whose cross-chat average describes nobody.
   */
  chatRequired?: boolean;
  /** Which period units to offer. Charts pass {@link CHART_PERIOD_UNITS}. */
  units?: PeriodUnit[];
  /** The card's data source — drives the calendar's data marks. */
  source: MetricSource;
  /** Current period per unit, resolved server-side in the operator timezone. */
  todayAnchors: Record<PeriodUnit, string>;
  /** Starting period unit — e.g. the insight cards open on the day, not the year. */
  defaultUnit?: PeriodUnit;
  /** Renders the card body for the current filters. */
  children: (filters: CardFilters) => ReactNode;
}

export function FilterableCard({
  title,
  description,
  chats,
  users,
  chatRequired = false,
  units = PERIOD_UNITS,
  source,
  todayAnchors,
  defaultUnit = "day",
  children,
}: FilterableCardProps) {
  const [filters, setFilters] = useState<CardFilters>(() => ({
    unit: defaultUnit,
    anchor: todayAnchors[defaultUnit],
    chatId: chatRequired ? (chats?.[0]?.id ?? null) : null,
    userId: null,
  }));

  // Chat and user are mutually exclusive scopes: a chat is a conversation, a user is
  // a person across conversations, and intersecting them answers a question nobody
  // asked. Choosing one clears the other.
  function setChat(chatId: string | null) {
    setFilters((f) => ({ ...f, chatId, userId: null }));
  }
  function setUser(userId: string | null) {
    setFilters((f) => ({ ...f, userId, chatId: null }));
  }

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker
            unit={filters.unit}
            anchor={filters.anchor}
            units={units}
            source={source}
            chatId={filters.chatId}
            todayAnchors={todayAnchors}
            label={title}
            onChange={({ unit, anchor }) => setFilters((f) => ({ ...f, unit, anchor }))}
          />
          {chats ? (
            <Select
              aria-label={`Chat for ${title}`}
              className="h-8 w-auto min-w-32 max-w-44 text-xs"
              value={filters.chatId ?? ""}
              onChange={(e) => setChat(e.target.value || null)}
            >
              {chatRequired ? null : <option value="">All chats</option>}
              {chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          ) : null}
          {users ? (
            <Select
              aria-label={`User for ${title}`}
              className="h-8 w-auto min-w-32 max-w-44 text-xs"
              value={filters.userId ?? ""}
              onChange={(e) => setUser(e.target.value || null)}
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{children(filters)}</CardContent>
    </Card>
  );
}

/**
 * The shared body states for a card that fetches. Kept here so a slow query, a failed
 * one, and an empty one look the same on every card.
 */
export function CardBody({
  loading,
  error,
  hasData,
  emptyMessage,
  children,
}: {
  loading: boolean;
  error: string | null;
  hasData: boolean;
  emptyMessage: string;
  children: ReactNode;
}) {
  if (error) return <p className="py-8 text-center text-sm text-danger">{error}</p>;
  if (!hasData) {
    return loading ? (
      <div className="flex justify-center py-8" aria-label="Loading">
        <Spinner />
      </div>
    ) : (
      <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
    );
  }
  // Data is already on screen: dim it rather than replacing it, so changing period
  // never blanks the card.
  return <div className={loading ? "opacity-60 transition-opacity" : undefined}>{children}</div>;
}
