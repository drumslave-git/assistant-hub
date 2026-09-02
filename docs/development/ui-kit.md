# UI kit and dashboard conventions

Tailwind CSS v4, React 19, App Router. Features compose shared primitives; they do not
restyle them and they do not build parallel versions of them.

```ts
import { Button, Card, CardContent, Field, Table, Tabs } from "@/components/ui";
```

One barrel, one stable entry point. Import from the barrel, not from the individual
files.

## What lives where

| Directory | Contents | Rule |
| --- | --- | --- |
| `components/ui/` | The design-system kit | Presentational. No feature logic, no data fetching |
| `components/layout/` | The responsive app shell: `AppShell`, `Sidebar`, `Topbar`, `nav-config.ts` (the role-filtered navigation), `SystemAlerts` | — |
| `components/auth/` | `AuthPasswordForm` (setup and login) and `ForcedPasswordChangeForm` (the temporary-password gate) | Rendered outside the shell |
| `components/chat/` | `ThreadsPage` — the whole web chat at `/chat` | Built from `@assistant-hub/ui` (see below) |
| `components/debug/` | The shared Debug views | Every feature composes these |
| `components/jobs/` | `JobStatusCard` and the pure `job-status.ts` it shares with the server-side registry | Every scheduler-backed feature renders this |
| `components/realtime/` | The core's `LiveIndicator` (wired to `router.refresh()`), `useLiveRefresh`, and re-exports of the shared stream singleton and `useLiveEvent` | — |
| `components/search/` | `SearchBox` — the top bar's message search (admin only) | — |
| `components/source/` | `SourceUnavailableNotice` — names a source that could not be read above the Users/Groups tables | — |
| `components/theme/` | The toggle, `useIsDark`, and the pre-hydration script | — |
| `components/time/` | `Timestamp` (re-exported from the shared package) and `TimezoneProvider` | — |
| `components/transports/` | `TransportSections` and `TransportConnectionSection` — the assistant editor's schema-driven connection sections | Built from `@assistant-hub/ui` (see below) |
| `features/*/ui/` | A feature's own components | Composed from the above |

## The primitives

| Primitive | Notes |
| --- | --- |
| `Badge` | Compact status pill; `dot` adds a leading status dot |
| `Button` | `asChild` renders onto the child element (e.g. a Next `<Link>`) instead of a `<button>` |
| `Calendar` | Selects a **period**, not an instant — day, week (returns its Monday), month, or year — and marks which periods hold data. Presentational and generic |
| `Card` + `CardHeader/Title/Description/Content/Footer/Action` | The standard surface. `interactive` adds hover affordance; `muted` is the recessed surface for nested panels |
| `Checkbox`, `Switch` | Native inputs, peer-styled, so they work in plain forms without client JS |
| `Combobox` | Searchable select: a text input that filters a dropdown of options, built for long model lists. Default mode commits only a picked option (typed text is a filter and reverts on close); `freeText` commits every keystroke for endpoints whose model ids cannot be listed. A committed value is always clearable — every consumer gives `""` its own meaning |
| `EmptyState` | The one "nothing here yet" — icon, title, description, action slot |
| `Field` | Labelled form row: wires `htmlFor`/`id`/`aria-describedby` and renders either a hint or an error |
| `Input`, `Textarea`, `Select`, `Label` | Form controls. `Select` is a native select with a chevron affordance |
| `PageHeader` | Page title, description, actions |
| `Fab` | The page's one main action, pinned bottom-right. **Replaces** the inline button rather than shadowing it, and carries that button's state (`busy`, plus a short `status` pill) — a floating button that swallowed the only copy of the feedback would make a failed save look like nothing happened. See [below](#the-floating-action-button) |
| `Modal` | Dialog for forms and confirmations, on the native `<dialog>` + `showModal()`. See [below](#modals) |
| `useConfirm` | `window.confirm()`, replaced. Promise-shaped, so it drops into the call sites that used the native one. See [below](#modals) |
| `Pagination` | Offset pagination for a server-rendered list. Presentational — the caller supplies `hrefFor(offset)`, so every page stays a real URL and the control works in a Server Component. Renders nothing when the list fits on one page |
| `Progress` | Clamped 0–100% meter |
| `ScrollArea` | Caps a growing section at a fraction of the viewport and scrolls **inside** the panel, so one dense list never stretches the page |
| `SegmentedControl` | One-of-N pills with arrow-key navigation. Distinct from `Tabs`: it owns only the choice, so it fits in a card header |
| `Separator` | Horizontal by default; `orientation="vertical"` inline |
| `Skeleton`, `Spinner` | Loading placeholders |
| `Slot` | The minimal `asChild` mechanism behind `Button` |
| `StatCard` | Metric card: large value, label, optional icon and trend. `accent` for the lead stat |
| `StatusCard` | Compact operational status for the Overview |
| `Table` + `TableBody/Head/HeaderCell/Row/Cell` | The presentational chrome only — scroll container, borders, padding, header typography. Features compose their own row behavior |
| `Tabs` | Accessible tabbed sections. **All panels stay mounted** (inactive ones `hidden`), so consumer state inside a panel survives switching. Uncontrolled via `defaultTabId`, or controlled with `value` + `onValueChange` |

`cn()` from `lib/cn.ts` merges class names and resolves conflicting Tailwind utilities
so the last one wins. Use it wherever a component composes a base style with a
caller-provided `className`.

## The second kit: `@assistant-hub/ui`

`packages/ui` is a workspace package (`@assistant-hub/ui`, exported from
`packages/ui/src/index.ts`) that holds the primitives and plumbing the dashboard must
render *identically* outside the core's own component tree. Its `package.json`
describes it as the shared home the source apps' `ui` subpackages import — never their
app's server code — and it depends only on `@assistant-hub/contracts`, `clsx`,
`tailwind-merge` and `lucide-react`. It holds:

| Export | What |
| --- | --- |
| `Badge`, `Button`, `Card` family, `EmptyState`, `Field`, `Input` (+ `fieldBase`), `Label`, `PageHeader`, `Slot` | The presentational primitives, one copy |
| `cn` | The class merger |
| `subscribeToRealtime` (`event-stream.ts`), `useLiveEvent`, `LiveIndicator` | The one-connection-per-tab SSE stream, its hook, and the pill — `LiveIndicator` here takes an `onEvent` callback |
| `Timestamp`, `TimezoneProvider`, `useTimezone`, `formatTime`, `formatTimestamp` | The one way to render an instant |
| `apiFetch`, `readApiError`, `ApiOkBody`, `ApiErrorBody` | The dashboard's one response envelope (`{ data }` / `{ error: { message } }`) and a fetch that unwraps it |

The core's kit does **not** duplicate any of it. `components/ui/{Badge,Button,Card,
EmptyState,Field,Input,Label,PageHeader,Slot}.tsx` are one-line re-exports from the
package ("moved to `@assistant-hub/ui`, Phase 3"), as are `components/time/Timestamp.tsx`,
`components/realtime/{event-stream,useLiveEvent}` and `lib/cn.ts`/`lib/format.ts`;
`components/realtime/LiveIndicator.tsx` wraps the shared pill with a
`router.refresh()`. Everything else in `components/ui/` (`Calendar`, `Combobox`,
`Modal`, `Tabs`, `Table`, `Fab`, …) exists only in the core.

Who imports the package directly, as the code stands:

| Importer | Why |
| --- | --- |
| `components/chat/ThreadsPage.tsx` | The web chat — a page that was an app-contributed extension before the chat dissolve (Phase 6), fetching on the client with `apiFetch` and refreshing through `LiveIndicator`'s `onEvent` |
| `components/transports/TransportConnectionSection.tsx` | The assistant editor's transport section — the surface that replaced the transport apps' hand-written `ui` packages (Phase 7) |
| The re-export files above | To keep the app-local import paths stable |

The two kits therefore coexist rather than compete: feature code and pages import
`@/components/ui`, which is the superset; the two client surfaces that grew up outside
the core tree import `@assistant-hub/ui` directly. The code shows no other rule, and
the extension registry the package was built for has since retired (the whole
navigation is the shell's own), so a new page has no reason to pick the package over
the barrel unless it needs `apiFetch` or the callback-style `LiveIndicator`.

## Non-negotiable conventions

### Timestamps

```tsx
<Timestamp iso={row.createdAt} />
```

Every rendered instant goes through `<Timestamp>`. It formats in the **operator's
configured timezone** — never the viewer's local zone, never hardcoded UTC — and emits
a semantic `<time>` carrying the original ISO instant.

Never call `toLocaleString()` in a component, and never pass a timezone prop: the zone
comes from `TimezoneProvider`, which the root layout seeds from the database once per
request. That is what makes a server-rendered and a client-rendered timestamp agree
without hydration drift.

### Live data

```tsx
const { connected } = useLiveRefresh("memory");
```

Every data-display page live-updates. Two hooks:

| Hook | For | Mechanism |
| --- | --- | --- |
| `useLiveRefresh(topic)` | A Server Component view | `router.refresh()` re-runs the server read |
| `useLiveEvent(topic, onEvent)` | A card that fetched its own data on the client | Your re-fetch — `router.refresh()` cannot reach state a `fetch` put in `useState` |

Both accept several topics and return `{ connected }` for the `LiveIndicator` pill.
Every consumer shares **one** `EventSource` per tab (see
[Observability](../architecture/observability.md#one-connection-per-tab) for why that
matters), so it is safe for many components to subscribe.

A page that requires a manual reload to show new data is a bug.

### Tabs over stacked sections

Multiple content sections on one page go into the shared `Tabs`, not stacked cards. Job
cards stay **above** the tabs. Drop card titles that duplicate a tab label — the tab
already says it.

### Server Components by default

Pages are Server Components that call services **directly** — no internal `fetch` to
your own API. Push interactivity to leaf Client Components and pass server-rendered
data down as props. A Client Component that needs a value from the database receives it
as a prop; it does not re-fetch it.

`JobStatusCard` is a Client Component, so a feature's job card must also be a Client
Component (it constructs the badge/notice nodes). Never drive the shared card directly
from a Server Component.

### Honest status

Never render "configured" from the presence of a value. Probe: connect to the database,
call the endpoint, open the file for append, fetch the transport's `/health`.
`/settings` reads the row for real on the server and shows the actual error if that
read fails, rather than a misleading "looks fine".

### Background failures must be visible

A `console.error`-only failure is invisible to the operator. Route it to the feature's
status card — or, for the class of failure that silently destroys data, to
`components/layout/SystemAlerts.tsx`.

That surface is deliberately reserved. Today it carries exactly one thing: the trace
write path. Per-feature degradations (LLM down, a bot stopped, a transport not
registered) stay on their own pages. The banner must stay rare to stay loud.

### Extract before the second copy

If a second consumer of a table/form/list pattern is imminent, build the shared
component **first** and use it. Do not ship a second hand-rolled copy with a "refactor
later" note. By the third use, sharing is mandatory unless there is a documented reason
not to.

The Settings form is the worked example: it once carried three hand-rolled copies of the
probe flow and five of the write-only secret input. Those are now two hooks in
`features/settings/ui/connection.ts` and one section shell (`RoleSection`) that all
nine role cards render through.

### The floating action button

A page with **one** unambiguous main action renders it as a `Fab` instead of an inline
button (user decision, 2026-08-14). Today that is eight consumers:

| Page | Consumer | Action |
| --- | --- | --- |
| `/settings` | `features/settings/ui/SettingsForm.tsx` | Save settings (hidden on the Security tab, which has its own button) |
| `/backends` | `features/backends/ui/BackendsManager.tsx` | New backend |
| `/assistants` | `features/assistants/ui/AssistantsManager.tsx` | New assistant (disabled with a `status` pill at the limit) |
| `/accounts` | `features/accounts/ui/AccountsManager.tsx` | Create account |
| `/users` → Linked people tab | `features/person-links/ui/PersonLinksManager.tsx` | Link identities |
| `/tools` → Connections tab | `features/tool-connections/ui/ConnectionsManager.tsx` | New connection (disabled at the limit) |
| `/tasks` | `features/tasks/ui/TasksManager.tsx` | Create task |
| `/browser` | `features/browser-agent/ui/NewRunForm.tsx` | Start run |

The rule is "one unambiguous action", not "every page". Pages deliberately left without
one: `/history/transfer` (import *and* export are both the point), `/debug` (a bundle
download and a destructive prune — a floating button is the wrong home for the second),
`/jobs` (every action belongs to a row, not the page), `/profile` (four cards, each
with its own save), `/chat` (the composer *is* the action) and `/` (its only actions
are the per-connection start/stop buttons, which belong beside the status they
reflect). Inventing a winner on those pages would mean promoting one action for the
sake of consistency.

Mechanics worth knowing before adding a ninth:

- It **replaces** the inline button. Two live copies of one action means two places
  showing its state and a reader working out whether they differ.
- The inline row's feedback moves onto the `status` pill — but only the verdict.
  Anything longer belongs in the page next to what it is about; Settings puts "Saved" on
  the button and the list of models the save cleared on the Models tab, where those
  roles are.
- A `disabled` Fab should say why via `status` (`tone: "muted"`), since a dead floating
  button is further from its cause than an inline one.
- Positioning is plain `fixed` at `z-30`, no portal — the content column has no
  transformed ancestor, and the mobile drawer at `z-40` correctly covers it. `AppShell`
  carries the bottom padding that stops it covering the last row of a page, reserved on
  every page rather than only the ones with a Fab.

### Modals

Every create/edit form and every destructive confirmation opens in a `Modal`
(user decision, 2026-08-14). The pages underneath are lists: an inline create card
sat above the list permanently, and an inline edit expanded a row and pushed
everything below it down the page while you typed.

`Modal` is built on the **native `<dialog>`** driven by `showModal()`. That is not
a style preference — the platform supplies four things a hand-rolled overlay has to
reimplement and usually gets wrong:

| | |
| --- | --- |
| Focus containment | No focus trap of our own |
| Inert background | A control behind the dialog cannot be tabbed to or clicked |
| Escape | Handled, and routed back through `onClose` so React state stays authoritative |
| Top layer | Above every stacking context — including the `fixed` `Fab`, which a `z-index` overlay would have had to out-rank |

Two things that will bite whoever touches it:

- **`m-auto` is load-bearing.** A native dialog is centred by the UA's own
  `margin: auto`, and Tailwind's preflight zeroes every margin — without it the
  dialog opens in the top-left corner.
- **`busy` blocks dismissal** while a write is in flight. A half-submitted create
  that vanishes to a stray Escape leaves no way to know whether it landed.

The convention for a CRUD page: **one** dialog component serving create *and*
edit, mounted only while open and `key`ed by its target, so its fields are seeded
once per opening and never carry the previous row's text. The two paths then
cannot drift apart — where they genuinely differ (a backend edit sends a
changed-only patch; a task's chat is fixed after creation; an assistant's transport
sections mount only once it exists) the difference is visible in one file.

On a tabbed page, put the `Fab` and the dialog **inside the owning tab's panel**.
`Tabs` keeps inactive panels mounted but `hidden`, which takes a `fixed` child out
of rendering too — so the Fab correctly disappears on tabs that don't own it, with
no extra wiring. The Users page (Linked people) and the Tools page (Connections) both
work this way.

`useConfirm` replaces `window.confirm()` for destructive actions. Beyond looking
like the rest of the dashboard, the reason it had to go: browsers let a user
suppress the native dialog for the session, so a delete guard can silently stop
appearing and nobody notices it left. Give the confirmation the fact that makes it
worth reading — which roles use the backend, the task's own instruction, that
deleting an assistant stops the bot it ran — not "Are you sure?".

## Theming

Dark-first. `components/theme/theme-script.tsx` is a blocking inline script in `<head>`
that applies the persisted choice **before** React hydrates, so there is no light/dark
flash; anything other than an explicit `"light"` resolves to dark. `ThemeToggle` flips
the `.dark` class on `<html>` and persists it, and reads the current theme from the DOM
via `useIsDark` so its icon stays in sync without effect-driven state.

A client component that must restyle on theme change (the JSON viewer, the charts) uses
`useIsDark`, which is a `useSyncExternalStore` over a class `MutationObserver` — no
flicker.

Charts do **not** theme automatically: the caller builds its ECharts `option` from the
supplied `ChartTheme`, where the dark palette is its own selected set of steps rather
than a flipped light one.

## Charts

One wrapper: `features/analytics/ui/Chart.tsx`. A Client Component that
lazy-`import("echarts")` on mount, pulled in by its callers via
`next/dynamic({ ssr: false })`, so the ~1 MB library never enters the server bundle.
`chart-theme.ts` holds pure tokens and types with no ECharts import, so the server can
evaluate the palette while the canvas-bound component stays client-only.

## Debug UI

Compose `components/debug/` — do not build a per-feature debug page. Link into the
shared explorer with `featureDebugHref(id)`.

`JsonBlock` collapses above a **size** threshold, not by type: a full system prompt or a
long message list folds away by default while short payloads stay inline. Nothing is
hidden permanently — one click reveals the full body. Debug must show complete raw
bodies; never trim or hand-pick fields for display.

## Preview and verification

When verifying UI in the in-app browser, note that the preview browser pins CSS
transitions (reduced-motion). Prefer `motion-reduce` variants and verify via the page
snapshot / DOM inspection rather than relying on an animation being visible in a
screenshot.

The dev server runs on port **3200** (the transport on **3210**; root `npm run dev`
starts both). Never delete `.next` or run a production build while it is live — that
kills the running server.
