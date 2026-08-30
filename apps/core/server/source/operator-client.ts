import "server-only";

import type {
  OperatorChat,
  OperatorChatMember,
  OperatorUser,
} from "@assistant-hub/contracts";

/**
 * The source-neutral listing/CRUD contract the dashboard's aggregation
 * consumes (PLAN.md). Every source implements it in-process since Phase 7 —
 * the web chat over its `web_*` tables, the transports over the
 * conversation store — so what remains here is the interface itself.
 */

/** The listing/CRUD slice the dashboard's aggregation needs. */
export interface SourceDirectoryClient {
  /** Every person the source knows (its directory). */
  listUsers(): Promise<OperatorUser[]>;
  /** Every conversation the source carries (mirror aggregates + metadata). */
  listChats(): Promise<OperatorChat[]>;
  /** One conversation, or null when the source does not carry it. */
  getChat(chatId: string): Promise<OperatorChat | null>;
  /** One chat's roster with membership times. */
  listChatMembers(chatId: string): Promise<OperatorChatMember[]>;
  /** Curated user fields — the source is the authority for its directory. */
  updateUser(
    id: string,
    input: { aliases: string[] } | { language: string | null },
  ): Promise<OperatorUser>;
  /** Curated chat fields (notes / reply language). */
  updateChat(
    id: string,
    input: { notes: string | null } | { language: string | null },
  ): Promise<OperatorChat>;
}
