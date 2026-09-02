# Users and groups

**Feature ids:** `known-users`, `known-groups`, `person-links`,
`mcp-tools-known-users` ·
**Dashboard:** `/users`, `/groups` · **SSE topics:** `users`, `groups`

Who the bot knows. Two mirror-image features — the groups service, repository,
schema and UI deliberately mirror the users ones — feeding one thing: the chat
context injected into every reply, plus the per-chat reply language. A third,
person links, declares which of those identities are the same human.

## Passive capture

The ingest (`server/ingest/consumer.ts`) upserts on every message a transport
forwards, addressed or not:

| Table | From |
| --- | --- |
| `source_users` | The sender's platform profile (`username`, `first_name`, `last_name`), keyed `(source, user_id)` |
| `source_chats` | The chat's `title` and `type`, in a group — a direct chat has no chat row |
| `source_chat_members` | The `(source, chat, user)` pair, with `first_seen_at` / `last_seen_at` |
| `source_chat_assistants` | Which assistant the platform delivered the chat's traffic to — the presence the group fan-out and the cross-feed read |

Every table is keyed by a `source` discriminator (`tg`, `chat`) plus
source-local text ids, so a second transport's people land beside Telegram's
without a schema change. The upsert never touches the operator-curated fields.
Capture is a **high-frequency passive upsert and is not traced**. Editing
curated fields is an operator action and **is** traced.

The known-users and known-groups features are adapters over these rows with
`source = 'tg'` (`features/known-users/server/repository.ts`,
`features/known-groups/server/repository.ts`): the record shapes the rest of
the brain consumes — labels, rosters, aliases — did not move when the tables
did. Web-chat identities are **accounts**: their aliases and language live on
the `accounts` row, served to the same directory by
`features/web-chat/server/directory.ts` ([Web chat](web-chat.md)).

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
| Group / supergroup | The group's `source_chats.language` |
| Private (Telegram) | The person's `source_users.language` (a private chat's id equals the user id) |
| Web thread | The thread's own `web_threads.language` |
| Neither set | `DEFAULT_CHAT_LANGUAGE` — **English** |

The source composes the resolved value onto the inbound event's `chat.language`;
the turn reads it from there. It always becomes a strict system directive
(`buildLanguageInstruction`), injected as the **last** system message before the
current turn — maximum recency, so it overrides the language of the incoming message,
the history, any tool output, and the persona. The runtime always resolves a value,
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

The reply pipeline injects a system message describing who the bot is talking to
(`server/turn/render.ts`, from the roster the source put on the event):

| Chat | Contents |
| --- | --- |
| Group | The roster of known participants, plus the operator notes for that group |
| Private | The identity of the person and their known names |

Skipped entirely when there is nothing to inject. Long-term memory is injected right
after it: the roster says *who* is here, memory says what is known *about* them.

## The aggregated directory

The dashboard pages do not read one table: they **aggregate** every registered
source's operator listing (`server/source/directory.ts`, `DIRECTORY_SOURCES`)
and tag each row with its origin and its scoped ref (`tg:user:123`,
`chat:user:<accountId>`). Both entries answer from the core's own tables — the
transports' rows through `server/source-store/directory-client.ts`, the web
chat's through `features/web-chat/server/directory.ts` — over the same
listing/CRUD contract (`packages/contracts`, `operator-api`), so nothing on the
pages knows what Telegram is. A new transport adds one entry to
`DIRECTORY_SOURCES`
([Adding a transport](../development/adding-a-transport.md#before-you-start-the-core-touchpoints)).

A source whose read fails does not fail the page and is never silently dropped:
it comes back under `unavailable` and `SourceUnavailableNotice` names it above
the tables. A short list must never be mistaken for "nobody has messaged the
bot".

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
The ref names the source that owns the edit, so a web user's alias lands on the
account row and a Telegram user's on `source_users`.

Member aliases are shown on the group page but edited on `/users` — one place per
concern.

## Person links

`person-links` (`relatedIdsKey`: `person_links`, tables `person_links` /
`person_link_members`) is the declaration that several identities are the
**same human**: two accounts on one source, or a telegram user and a dashboard
account. An account's own identity is its web-chat ref
(`chat:user:<accountId>`), so a link joining a platform identity to that ref is
what makes a person's messages carry their account's rights. Memory reads
resolve through links (`resolveLinkedRefs`), so what the bot durably knows
about someone follows the person rather than the account; unlinked identities
stay separate.

| Rule | Why |
| --- | --- |
| An identity belongs to **at most one** link | Keeps resolution a lookup, not a graph walk. A claimed identity is refused with a conflict naming it, and the picker disables it |
| A link needs **at least two** identities | A link of one says nothing; breaking a person apart is a delete |

Reads only: a fact is still stored under the identity that was named, and the
merged result is attributed to the identity present in the conversation. Two
linked identities in one group are one person in the prompt, named once.

Two ways to make a link: an admin on `/users` → Linked people, or the person
themselves — a one-time code minted on `/profile` and sent to any bot links
that platform identity to the account without an admin ([Accounts](accounts.md)).

## Owner rights

There is no global owner. A sender holds owner rights in a turn when their
account — resolved through person links — is the receiving assistant's owning
account, or is an admin (`server/owner-rights.ts`). The ingest stamps the
verdict on every inbound event as `sender.isOwner`, per receiving assistant,
and everything owner-gated (maintenance mode, the chat-side task gates, the
browser agent's downloads) reads that stamp. An identity nobody has linked to
an account holds no rights, whoever it belongs to on the platform. See
[Accounts](accounts.md#owner-rights).

## API

`GET /api/users`, `PATCH /api/users/{ref}` (body carries **one** of `language` or
`aliases`, dispatched to the matching traced action), `GET /api/groups`,
`PATCH /api/groups/{ref}` (one of `language` or `notes`).
`GET|POST /api/person-links`, `PATCH|DELETE /api/person-links/{id}` (the PATCH
body carries one of `note` or `members`).

## Tracing

`known-users` (`relatedIdsKey`: `known_users`), `known-groups`
(`relatedIdsKey`: `known_groups`) and `person-links`
(`relatedIdsKey`: `person_links`) — the registry keys kept their v1 names.
Alias, language, notes and link edits are traced; capture is not. Alias
recordings by the model are traced under `mcp-tools-known-users`.

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
`server/source-store/source-store.integration.test.ts` (the rows themselves),
`server/ingest/ingest.integration.test.ts` (capture and presence from live
events), and `web-chat/server/web-chat.integration.test.ts` (the web chat's
directory entry).
