import { CONTRACT_MAJOR, type SourceId } from "@assistant-hub-swarm/contracts";

import { registerTransport } from "@/server/transports/service";
import type { StoreDb } from "@/server/store/db";

/**
 * Register a transport in a test store, the way a real one announces itself
 * at boot. Every read that walks the registered roster — the content plane,
 * the directory, the media sources — sees nothing until one exists, so an
 * integration suite that seeds `source_*` rows under a source id registers
 * that id first.
 */
export async function registerTestTransport(
  db: StoreDb,
  id: SourceId = "tg",
  name = "Telegram",
): Promise<void> {
  await registerTransport(
    {
      id,
      name,
      baseUrl: `http://${id}.test:3220`,
      mcpPath: "/mcp",
      contractMajor: CONTRACT_MAJOR,
      connectionConfigSchema: [],
      transportConfigSchema: [],
    },
    db,
  );
}
