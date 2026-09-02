import { defineRoute, ok } from "@/server/http";
import {
  incompatibilityReason,
  listTransports,
  previewConfig,
  transportCompatible,
} from "@/server/transports/service";

/**
 * The registered transports, for the dashboard's schema-driven sections:
 * each row carries the config field schemas the forms render from. Secret
 * config values are reduced to hints.
 */
// Account level (Phase 9): the assistant editor renders these sections for
// every owner; secrets are already reduced to hints.
export const GET = defineRoute(async () => {
  const rows = await listTransports();
  return ok({
    transports: rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      /** Whether the transport has announced itself (an empty URL = never). */
      registered: row.baseUrl !== "",
      contractMajor: row.contractMajor,
      /** False when the transport speaks another contract major — `refusedReason` says so. */
      compatible: transportCompatible(row),
      refusedReason: transportCompatible(row) ? null : incompatibilityReason(row.id, row.contractMajor),
      lastSeenAt: row.lastSeenAt.toISOString(),
      connectionConfigSchema: row.connectionConfigSchema,
      transportConfigSchema: row.transportConfigSchema,
      configPreview: previewConfig(row.config, row.transportConfigSchema),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}, { access: "account" });
