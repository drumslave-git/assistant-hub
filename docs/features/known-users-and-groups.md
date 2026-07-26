# Users and groups

**Feature ids:** `known-users`, `known-groups`, `mcp-tools-known-users` ·
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

## Dashboard

| Page | Contents |
| --- | --- |
| `/users` | Every user who has messaged the bot, with inline alias and language editing |
| `/groups` | Every group the bot is active in, each linking to its detail |
| `/groups/{chatId}` | The group's notes editor, language editor, and the roster of known members. `notFound()` for an unknown id |

Each editor saves **one field at a time** and replaces local state with the returned
record, so the input always reflects what was actually stored (the server trims,
normalizes, and clears empties to null). Aliases are edited as a comma-separated list.

Member aliases are shown on the group page but edited on `/users` — one place per
concern.

## API

`GET /api/users`, `PATCH /api/users/{id}` (body carries **one** of `language` or
`aliases`, dispatched to the matching traced action), `GET /api/groups`,
`PATCH /api/groups/{id}` (one of `language` or `notes`).

## Owner selection

`settings.owner_user_id` is chosen from known users, which means the owner can only be
set **after** that person has messaged the bot at least once. `owner_username` is
stored denormalized for display.

## Tracing

`known-users` (`relatedIdsKey`: `known_users`) and `known-groups`
(`relatedIdsKey`: `known_groups`). Alias, language and notes edits are traced; capture
is not.

## Tests

Unit: `known-users/format.test.ts`, `known-users/match.test.ts`,
`known-users/server/schema.test.ts`, `known-groups/format.test.ts`,
`known-groups/server/schema.test.ts`, `lib/language.test.ts`.
Integration: `known-users/server/known-users.integration.test.ts`,
`known-groups/server/known-groups.integration.test.ts`,
`known-users/server/tool-selection.integration.test.ts`.
