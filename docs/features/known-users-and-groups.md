# Users and groups

**Feature ids:** `known-users`, `known-groups`, `person-links`,
`mcp-tools-known-users` ·
**Dashboard:** `/users`, `/groups` · **SSE topics:** `users`, `groups`

Who the bot knows. Two mirror-image features — the groups service, repository,
schema and UI deliberately mirror the users ones — feeding one thing: the chat
context injected into every reply, plus the per-chat reply language.

## Passive capture

Every incoming message upserts:

| Table | From |
| --- | --- |
| `known_users` | The sender's Telegram profile (`username`, `first_name`, `last_name`) |
| `known_groups` | The chat's `title` and `type`, in a group |
| `group_members` | The `(chat, user)` pair, with `first_seen_at` / `last_seen_at` |

Capture is a **high-frequency passive upsert and is not traced**. Editing curated
fields is an operator action and **is** traced.

## Curated fields

| Field | On | Effect |
| --- | --- | --- |
| `aliases` | Users | Additional names/nicknames. Feed the addressing check and person resolution in memory/tools |
| `language` | Users | The bot's reply language in that person's **private** chat |
| `language` | Groups | The bot's reply language in that group |
| `notes` | Groups | Operator notes (≤2000 chars) injected into the group's chat context |

Bounds: 20 aliases, 60 chars each, case-insensitively deduplicated and blank-stripped
by the zod transform before the length rules are applied.

### Aliases and the model

`update_user_aliases` (MCP, under `mcp-tools-known-users`) lets the model record a
nickname it observes — "people call Alice 'Ali'" — so the bot recognizes that name
later. Chat-scoped via the tool context: the model identifies the person by a name it
**already sees** (first name, `@username`, or an existing nickname), never a numeric
id, and only people who have messaged in the current chat can be updated.

`features/known-users/match.ts` (pure) resolves that free-text reference against a
candidate set of the user's own names — case-insensitively and exactly. A model refers
to people by the names it sees in the conversation, never by ids, so this is the
translation layer.

## Reply language

`lib/language.ts` (pure, only depends on zod, so the same helpers back the persistence
schemas, the Route Handlers, the dashboard, and the reply runtime).

| Chat | Language used |
| --- | --- |
| Group / supergroup | The group's `known_groups.language` |
| Private | The person's `known_users.language` (a private chat's id equals the user id) |
| Neither set | `DEFAULT_CHAT_LANGUAGE` — **English** |

The resolved language always becomes a strict system directive
(`buildLanguageInstruction`), injected as the **last** system message before the
current turn — maximum recency, so it overrides the language of the incoming message,
the history, any tool output, and the personality. The runtime always resolves a value,
so reply language is controlled by configuration rather than by whatever language the
user happened to write in.

The directive also sets a quality bar, because picking the right language is not the
same as writing it well: natural modern prose in that language's own orthography and
vocabulary, no literal translations / calques / invented words / bureaucratic phrasing,
the established term for technical vocabulary (and the original English term in Latin
script when no reliable one exists, rather than a coinage), code / commands / filenames
/ identifiers preserved verbatim, and a silent self-review of the final text that is
never narrated to the user. Every rule is phrased over the configured language name —
there are no per-language tables or transliteration rules in the code, since judging
what reads naturally is the model's job.

Values are free text (a language name, ≤100 chars) with internal whitespace collapsed:
`"  Brazilian   Portuguese "` → `"Brazilian Portuguese"`. An empty value clears to
null, which means "use the default".

## Chat context

The reply pipeline injects a system message describing who the bot is talking to:

| Chat | Contents |
| --- | --- |
| Group | The roster of known participants, plus the operator notes for that group |
| Private | The identity of the person and their known names |

Skipped entirely when there is nothing to inject. Long-term memory is injected right
after it: the roster says *who* is here, memory says what is known *about* them.

## The aggregated directory

Since the source split, the source apps own their directories: the dashboard
pages do not read a local table, they **aggregate** every registered source's
operator listing (`server/source/directory.ts`) and tag each row with its
origin and its scoped ref (`tg:user:123`). `apps/chat` joins by adding one
entry to the registry.

A source that is unconfigured or unreachable does not fail the read and is
never silently dropped: it comes back under `unavailable` and
`SourceUnavailableNotice` names it above the tables. A short list must never be
mistaken for "nobody has messaged the bot".

The core still keeps a **transitional shadow** of the directory
(`known_users` / `known_groups` / `group_members`, written by the queue
consumer) so v1 foreign keys, labels and rosters on the message path keep
working. It is telegram-shaped and the Phase 6 cutover collapses it; the
dashboard no longer reads it.

## Dashboard

| Page | Contents |
| --- | --- |
| `/users` → **Directory** | Every person every source knows, with its source, plus inline alias and language editing |
| `/users` → **Linked people** | Person links (below) |
| `/groups` | Every shared conversation the sources carry, with roster and message counts, each linking to its detail |
| `/groups/{ref}` | The chat's notes editor, language editor, and the roster its source knows. `notFound()` for a ref no source carries |

Each editor saves **one field at a time** and replaces local state with the returned
record, so the input always reflects what was actually stored (the server trims,
normalizes, and clears empties to null). Aliases are edited as a comma-separated list.
Every edit lands at the owning **source first** — an edit that did not reach the
authority must not pretend by updating only the shadow.

Member aliases are shown on the group page but edited on `/users` — one place per
concern.

## Person links

`person-links` (`relatedIdsKey`: `person_links`, v2 core store tables
`person_links` / `person_link_members`) is the operator's declaration that
several identities are the **same human**: two accounts on one source, or a
telegram user and a web-chat user. Memory reads resolve through it
(`resolveLinkedRefs`), so what the bot durably knows about someone follows the
person rather than the account; unlinked identities stay separate.

| Rule | Why |
| --- | --- |
| An identity belongs to **at most one** link | Keeps resolution a lookup, not a graph walk. A claimed identity is refused with a conflict naming it, and the picker disables it |
| A link needs **at least two** identities | A link of one says nothing; breaking a person apart is a delete |
| Reads are best-effort | Without the v2 store (or with it unreadable) every identity resolves to itself and memory behaves as it did before links existed. Writes are not forgiving this way |

Reads only: a fact is still stored under the identity that was named, and the
merged result is attributed to the identity present in the conversation. Two
linked identities in one group are one person in the prompt, named once.

## API

`GET /api/users`, `PATCH /api/users/{ref}` (body carries **one** of `language` or
`aliases`, dispatched to the matching traced action), `GET /api/groups`,
`PATCH /api/groups/{ref}` (one of `language` or `notes`).
`GET|POST /api/person-links`, `PATCH|DELETE /api/person-links/{id}` (the PATCH
body carries one of `note` or `members`).

## Owner selection

`settings.owner_user_id` is chosen from known users, which means the owner can only be
set **after** that person has messaged the bot at least once. `owner_username` is
stored denormalized for display.

## Tracing

`known-users` (`relatedIdsKey`: `known_users`), `known-groups`
(`relatedIdsKey`: `known_groups`) and `person-links`
(`relatedIdsKey`: `person_links`). Alias, language, notes and link edits are
traced; capture is not.

## Tests

Unit: `known-users/format.test.ts`, `known-users/match.test.ts`,
`known-users/server/schema.test.ts`, `known-groups/format.test.ts`,
`known-groups/server/schema.test.ts`, `person-links/server/schema.test.ts`,
`server/source/directory.test.ts`, `lib/language.test.ts`.
Integration: `known-users/server/known-users.integration.test.ts`,
`known-groups/server/known-groups.integration.test.ts`,
`known-users/server/tool-selection.integration.test.ts`,
`person-links/server/person-links.integration.test.ts`,
`memory/server/memory-links.integration.test.ts` (memory read through links),
and the tg side's `operator-api.integration.test.ts`.
