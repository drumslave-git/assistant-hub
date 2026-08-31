-- General memory becomes ONE merged document, injected into every reply, instead
-- of individually embedded fact rows retrieved by tool (operator decision).
--
-- Hand-edited beyond what drizzle-kit generated: the generated migration dropped
-- the columns but left every existing fact as its own uuid-keyed row, which the
-- singleton read (`id = 'singleton'`) would never find — silently orphaning the
-- whole store. The rows are collapsed into the document FIRST, oldest fact first,
-- so nothing is lost. The next nightly merge deduplicates and tidies the result.

-- Nothing ranks this scope any more: it is always in context, never searched.
DROP INDEX IF EXISTS "general_memories_embedding_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "general_memories_content_fts_idx";--> statement-breakpoint

-- Collapse the existing facts into one document, oldest first. Runs before
-- `created_at` is dropped, because it is what orders the document.
--
-- The aggregate spans EVERY row, including any row that already happens to be
-- keyed 'singleton' — excluding it would let the ON CONFLICT below overwrite that
-- row's own content with a document that omits it. `HAVING count(*) > 0` makes the
-- whole statement a no-op on an empty table (an unfiltered aggregate would
-- otherwise insert one row of NULL content and violate NOT NULL). Postgres
-- evaluates the SELECT against a snapshot, so inserting into the table being read
-- is safe.
INSERT INTO "general_memories" ("id", "content", "updated_at")
SELECT 'singleton', string_agg("content", E'\n' ORDER BY "created_at"), now()
FROM "general_memories"
HAVING count(*) > 0
ON CONFLICT ("id") DO UPDATE SET
  "content" = EXCLUDED."content",
  "updated_at" = now();--> statement-breakpoint

DELETE FROM "general_memories" WHERE "id" <> 'singleton';--> statement-breakpoint

ALTER TABLE "general_memories" ALTER COLUMN "id" SET DEFAULT 'singleton';--> statement-breakpoint
ALTER TABLE "general_memories" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "general_memories" DROP COLUMN "created_at";
