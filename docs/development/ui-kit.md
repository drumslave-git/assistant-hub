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
| `components/layout/` | The responsive app shell: sidebar, drawer, top bar, nav config, system alerts | — |
| `components/debug/` | The shared Debug views | Every feature composes these |
| `components/jobs/` | `JobStatusCard` | Every scheduler-backed feature renders this |
| `components/realtime/` | The SSE stream singleton and its two hooks | — |
| `components/time/` | `Timestamp` and `TimezoneProvider` | — |
| `components/theme/` | The toggle and the pre-hydration script | — |
| `features/*/ui/` | A feature's own components | Composed from the above |

## The primitives

| Primitive | Notes |
| --- | --- |
| `Avatar` | Falls back to initials. Uses a plain `<img>`, not `next/image`, because avatars are remote/user-supplied and unoptimized by design |
| `Badge` | Compact status pill; `dot` adds a leading status dot |
| `Button` | `asChild` renders onto the child element (e.g. a Next `<Link>`) instead of a `<button>` |
| `Calendar` | Selects a **period**, not an instant — day, week (returns its Monday), month, or year — and marks which periods hold data. Presentational and generic |
| `Card` + `CardHeader/Title/Description/Content/Footer/Action` | The standard surface. `interactive` adds hover affordance; `muted` is the recessed surface for nested panels |
| `Checkbox`, `Switch` | Native inputs, peer-styled, so they work in plain forms without client JS |
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

## Non-negotiable conventions

### Timestamps

```tsx
<Timestamp value={row.createdAt} />
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
call the endpoint, open the file for append. `/settings` reads the row for real on the
server and shows the actual error if that read fails, rather than a misleading
"looks fine".

### Background failures must be visible

A `console.error`-only failure is invisible to the operator. Route it to the feature's
status card — or, for the class of failure that silently destroys data, to
`components/layout/SystemAlerts.tsx`.

That surface is deliberately reserved. Today it carries exactly one thing: the trace
write path. Per-feature degradations (LLM down, bot stopped) stay on their own pages.
The banner must stay rare to stay loud.

### Extract before the second copy

If a second consumer of a table/form/list pattern is imminent, build the shared
component **first** and use it. Do not ship a second hand-rolled copy with a "refactor
later" note. By the third use, sharing is mandatory unless there is a documented reason
not to.

The Settings form is the worked example: it once carried three hand-rolled copies of the
probe flow and five of the write-only secret input. Those are now two hooks in
`features/settings/ui/connection.ts` and one section shell.

### The floating action button

A page with **one** unambiguous main action renders it as a `Fab` instead of an inline
button (user decision, 2026-08-14). Today that is six pages:

| Page | Action |
| --- | --- |
| `/settings` | Save settings |
| `/backends` | Create backend |
| `/personalities` | Create personality |
| `/specialists` | Create specialist |
| `/tasks` | Create task |
| `/browser` | Start run |

The rule is "one unambiguous action", not "every page". Pages deliberately left without
one: `/history/transfer` (import *and* export are both the point), `/debug` (a bundle
download and a destructive prune — a floating button is the wrong home for the second),
`/jobs` (every action belongs to a row, not the page), and `/` (its only action is the
bot start/stop toggle, which belongs beside the status it reflects). Inventing a winner
on those pages would mean promoting one action for the sake of consistency.

Mechanics worth knowing before adding a seventh:

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
changed-only patch; a task's chat is fixed after creation) the difference is
visible in one file.

On a tabbed page, put the `Fab` and the dialog **inside the owning tab's panel**.
`Tabs` keeps inactive panels mounted but `hidden`, which takes a `fixed` child out
of rendering too — so "New specialist" correctly disappears on the Entries tab
with no extra wiring.

`useConfirm` replaces `window.confirm()` for destructive actions. Beyond looking
like the rest of the dashboard, the reason it had to go: browsers let a user
suppress the native dialog for the session, so a delete guard can silently stop
appearing and nobody notices it left. Give the confirmation the fact that makes it
worth reading — which roles use the backend, how many chats lose the specialist,
the task's own instruction — not "Are you sure?".

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

The dev server runs on port **3200**. Never delete `.next` or run a production build
while it is live — that kills the running server.
