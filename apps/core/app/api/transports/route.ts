import { defineRoute, ok } from "@/server/http";
import { listTransports, previewConfig } from "@/server/transports/service";

/**
 * The registered transports, for the dashboard's schema-driven sections:
 * each row carries the config field schemas the forms render from. Secret
 * config values are reduced to hints.
 */
export const GET = defineRoute(async () => {
  const rows = await listTransports();
  return ok({
    transports: rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      /** Whether the transport has announced itself (an empty URL = never). */
      registered: row.baseUrl !== "",
      lastSeenAt: row.lastSeenAt.toISOString(),
      connectionConfigSchema: row.connectionConfigSchema,
      transportConfigSchema: row.transportConfigSchema,
      configPreview: previewConfig(row.config, row.transportConfigSchema),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
});
