# Accounts

**Feature ids:** `accounts` (management, profile, identity links), `auth`
(setup, login, password) · **Dashboard:** `/accounts` (admins), `/profile`
(every account), `/setup`, `/login`, `/password` · **SSE topic:** `accounts`

Who signs in, and as what. DB-backed accounts with a role replaced the single
operator password (v2 redesign, Phase 8); the operator password and the global
owner identity are retired and must not come back. An account is also an
**identity**: its ref `chat:user:<accountId>` is its web-chat identity and
joins the person-link graph, which is what ties platform identities — and the
memory held under them — to the person who owns the account.

## Model

`accounts`: `username` (unique case-insensitively), `display_name`, `aliases`
and `language` (the account as a chat participant — see
[Users and groups](known-users-and-groups.md)), `password_hash` (self-describing
scrypt), `role` (`admin` | `user`), `session_secret`, `must_change_password`,
`active`.

| Role | May |
| --- | --- |
| `admin` | Everything: every page, every account, every assistant, every trace |
| `user` | Its own surface: the web chat, `/profile`, and — with full parity — its own assistants, their bot connections, tasks, tool connections and traces. The admin pages redirect it to `/chat` |

There is no open registration. First-run `/setup` creates the first admin;
every further account is created by an admin on `/accounts` with a
**temporary password** handed over out of band, which the holder must replace
at first sign-in (`must_change_password` holds the session at `/password`
until it is). `active = false` blocks sign-in and invalidates live sessions
with the data intact; reactivation restores everything.

## Sessions and gates

Sessions are stateless cookies (`op_session`):
`<accountId>.<expiresMs>.<nonce>.<sig>`, the signature an HMAC-SHA256 keyed
by **that account's** `session_secret`, valid for 30 days. No session table —
a token is valid iff its signature checks out against the account it names,
the account is active, and it has not expired. Rotating one account's secret
(a password change, an admin's password reset) signs out that account's
sessions and nobody else's. `Secure` is deliberately omitted: the self-hosted
dashboard commonly runs over plain HTTP on a LAN, and behind a TLS proxy the
cookie is transported encrypted anyway.

| Gate | Where |
| --- | --- |
| Every API route | `defineRoute` (`server/http.ts`) with an access level: `admin` (the default), `account` (any active signed-in account), `public` (the auth endpoints). A temporary-password holder is refused everywhere except routes flagged `allowTemporaryPassword` (the password change) |
| Every dashboard page | The `(dashboard)` layout verifies the cookie against the DB-stored secret: unconfigured → `/setup`, invalid → `/login`, temporary password → `/password` |
| The admin pages | The `(admin)` route group's layout sends a user-role account to `/chat` |
| The edge | `proxy.ts` does only the optimistic cookie-presence redirect the Next.js auth guide prescribes; the real gates are server-side, where the database is reachable |

Before setup, non-public routes stay open and the dashboard forces `/setup` on
first contact — refusing everything before setup would break the fresh-install
experience, and setup is self-sealing (it refuses to run once any account
exists, so it cannot be used to seize an installed instance). A database
outage does not lock the operator out of the status shell: the pages render
their "database unavailable" states.

Login failures cost a flat 500 ms and answer identically for a wrong username
and a wrong password, so a probe cannot enumerate usernames; a deactivated
account is told so. Usernames are at least 3 characters of letters, digits,
dots, dashes and underscores; passwords at least 8 characters.

## `/accounts` — management (admins)

Every account with its role and state, live on the `accounts` topic, and per
row:

| Action | Rule |
| --- | --- |
| Create | `POST /api/accounts` — username, optional display name (≤120), role, temporary password (the form suggests a readable random one). Duplicate usernames are refused case-insensitively |
| Password | `PATCH /api/accounts/{id}` `{ temporaryPassword }` — the holder's current password stops working, every session is signed out (the secret rotates), and the forced-change hold is re-armed |
| Make admin / Make user | `PATCH` `{ role }` |
| Deactivate / Reactivate | `PATCH` `{ active }` — either way every transport is nudged to refetch its desired state, because the account's assistants are silenced by deactivation (below) |
| Delete… | `DELETE /api/accounts/{id}` — offered only once the account is deactivated |

Guards, enforced in the service whatever the UI shows: you cannot deactivate,
demote or delete **yourself**, and the **last active admin** can be neither
deactivated nor demoted. One management action per call.

## `/password` and the password change

`POST /api/auth/change-password` demands the **current** password even though
the route is session-gated — a walked-up-to browser with a live session must
not be enough to take over the account — rotates the session secret, clears
the temporary-password hold, and answers with a fresh cookie so the caller
alone stays signed in. `/password` is the forced form a temporary-password
holder lands on; `/profile` and Settings → Security offer the same change.

## `/profile` — every account's own surface

| Card | Does |
| --- | --- |
| Who you are | Display name (`PATCH /api/profile`) — how the account appears in chats |
| Your identities | The identities linked to this person via the link graph, labelled from the directory; **Link another identity** mints a one-time code (`POST /api/profile/link-code`) |
| What the assistant remembers about you | The memory documents under any of the account's identities, readable and deletable (`DELETE /api/profile/memory?userId=<ref>`) — view + delete is the whole user-facing memory surface; there is no self-authoring |
| Password | The change form above |

Everything here is scoped to the acting account; the admin pages remain the
global views.

## Self-link: a code sent to any bot

The self-service way to declare "this Telegram user is me"
(`features/accounts/server/self-link.ts`):

1. The account mints a code on `/profile`: `link-xxxxxxxx`, eight characters
   from an alphabet without `0`/`o`/`1`/`l` so it survives being typed by hand,
   valid **15 minutes**, one live code per account (minting again retires the
   unused one). The code never reaches a trace.
2. The person sends the code — as the whole message — to any connected bot from
   the identity they want to link.
3. The ingest recognizes the code-shaped message *before* it could open a turn
   (after the feedback-capture check) and redeems it: the sender's ref joins the
   account's person link — extending the account's existing link, or the
   sender's, or creating one — and the code burns. The message is consumed and
   answered in the chat; it is never sent to the model.

| Outcome | Reply |
| --- | --- |
| `linked` | Done — memory and permissions follow the person here from now on |
| `already-linked` | Nothing to do |
| `conflict` | The two identities already belong to different linked people, or the sender's link already holds a **different** account — merging persons is an admin's call on `/users`, not something a chat message may decide |
| `invalid` | Unknown, expired, used, or the account is gone or deactivated |

Admins link and unlink by hand on `/users` → Linked people
([Users and groups](known-users-and-groups.md#person-links)).

## Owner rights

`server/owner-rights.ts` answers one question for every turn: does this
sender hold owner rights over this assistant?

1. Resolve the sender's account: the ref itself when it is an account's own
   web identity, else the account whose web ref shares a person link with it.
   Only an **active** account counts.
2. An admin holds owner rights on every assistant. Otherwise the assistant's
   `owner_account_id` must be that account; a null owner (a pre-auth row)
   grants nobody but admins.

Never throws into the message path — an unresolvable ref is simply not the
owner. The ingest stamps the verdict on every inbound event as
`sender.isOwner`, per receiving assistant; the web chat does the same for a
thread's account. Everything owner-gated reads that stamp and compares no user
ids of its own: maintenance mode, the chat-side task gates and
`created_by_owner`, the browser agent's download tools, and the
`senderIsOwner` a hosted tool receives in its turn binding.

## Ownership scoping

`server/ownership.ts` is where role scoping lives once (Phase 9): `mayActOn`,
`ownedAssistantIds`, `requireAssistantOwnership` (not-found, never forbidden,
so ids do not leak), `servedChatKeys` (the platform chats an account's
assistants serve, from the presence table), `visibleTraceScope` /
`requireTraceVisible` (a user sees only its own assistants' traces; traces
with no assistant are operator actions and stay admin-only), and
`silencedAssistantIds`. Every scoped API — assistants, transport connections,
tasks, tool connections, web-chat threads, traces — resolves through these
helpers. A null actor (auth unconfigured) behaves as an admin: there is nobody
to hide anything from yet.

## Offboarding

Two steps, and the first is reversible:

1. **Deactivate.** Sign-in and sessions stop. The account's assistants are
   **silenced everywhere the fact is computed, never stored**
   (`silencedAssistantIds`): the transport's desired state marks their
   connections disabled, the task scheduler and the ingest fan-out skip them.
   Reactivating restores everything exactly as it was. On a read failure
   nothing is silenced — a DB blip must not mute working assistants.
2. **Delete** (only a deactivated account, so the guards above apply). In
   order: the account's assistants through the assistants service, so each
   `assistant.deleted` fires and the transports clean up (tasks and bot
   connections cascade); the memory documents under its linked identities; its
   person-link membership (the link survives only if two other identities
   remain); then the account row, whose foreign keys take the web threads, the
   link codes and the account's tool connections with it.

## Tracing

| Feature id | Actions |
| --- | --- |
| `auth` | `setup`, `login` (successes and failures alike — a failed attempt is a trace with status error), `change-password`. No password, temporary or not, ever appears in a trace body |
| `accounts` | `create`, `activate` / `deactivate`, `change-role`, `reset-password`, `delete`, `update-profile`, `mint-link-code`, `self-link` (trigger kind `telegram`, actor the sender's ref) |

## Tests

`server/auth/auth.test.ts` (password hashing, session tokens and rotation),
`server/auth/auth.integration.test.ts` (setup → login → session judgement, the
second-setup refusal, the failure answers, the API gate, the password change and
its session semantics), `features/accounts/server/accounts.integration.test.ts`
(creation with the temporary password, the management guards, the roster
without secrets, self-link codes end to end, offboarding),
`server/owner-rights.integration.test.ts` (account resolution through links,
owner rights, the ownership helpers), and
`server/ingest/ingest.integration.test.ts` (a self-link code consumed instead
of opening a turn). Security posture: [Security](../architecture/security.md).
