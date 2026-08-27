import "server-only";

import {
  operatorChatMembersResponseSchema,
  operatorChatResponseSchema,
  operatorChatsResponseSchema,
  operatorUserResponseSchema,
  operatorUsersResponseSchema,
  type OperatorChat,
  type OperatorChatMember,
  type OperatorUser,
  type SourceId,
} from "@assistant-hub/contracts";

import { isApiError } from "@/lib/api-error";

import { internalRequester, sourceApiConfig, type InternalRequest } from "./internal-client";

/**
 * The source-neutral half of the operator contract: every source app serves
 * the same listing/CRUD endpoints for its people and conversations, so the
 * client that reads them is written once and parameterized by which app
 * answers (PLAN.md — the dashboard aggregates sources through one contract).
 *
 * A source's own extras (tg's connections and owner settings) live in that
 * app's client module and compose with this.
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

/** Status probes and listings must stay snappy — the dashboard awaits them. */
export const OPERATOR_TIMEOUT_MS = 5_000;

export function createDirectoryClient(
  request: InternalRequest,
  label: string,
): SourceDirectoryClient {
  return {
    async listUsers() {
      const body = operatorUsersResponseSchema.parse(await request("/internal/users"));
      return body.users;
    },
    async listChats() {
      const body = operatorChatsResponseSchema.parse(await request("/internal/chats"));
      return body.chats;
    },
    async getChat(chatId) {
      try {
        const body = operatorChatResponseSchema.parse(
          await request(`/internal/chats/${encodeURIComponent(chatId)}`),
        );
        return body.chat;
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    async listChatMembers(chatId) {
      const body = operatorChatMembersResponseSchema.parse(
        await request(`/internal/chats/${encodeURIComponent(chatId)}/members`),
      );
      return body.members;
    },
    async updateUser(id, input) {
      const body = operatorUserResponseSchema.parse(
        await request(`/internal/users/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      );
      if (!body.user) throw new Error(`${label} returned no user`);
      return body.user;
    },
    async updateChat(id, input) {
      const body = operatorChatResponseSchema.parse(
        await request(`/internal/chats/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      );
      if (!body.chat) throw new Error(`${label} returned no chat`);
      return body.chat;
    },
  };
}

/**
 * The operator requester for one source, or null when this deployment does
 * not run that app.
 */
export function operatorRequester(
  source: SourceId,
): { request: InternalRequest; label: string } | null {
  const config = sourceApiConfig(source);
  if (!config) return null;
  const label = `${source} operator API`;
  return {
    label,
    request: internalRequester({ ...config, label, timeoutMs: OPERATOR_TIMEOUT_MS }),
  };
}
