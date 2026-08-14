# Randomness (`roll_chance`)

One MCP tool, `roll_chance`, which answers "should this happen this time?" for
anything written as a probability.

- **Feature id:** `mcp-tools-randomness` (Debug scope for every call)
- **Owner:** `randomness` (`features/randomness/`)
- **Dashboard:** listed on `/tools`; it has no page of its own
- **Availability:** every turn — a reply turn and a task fire alike

## Why it exists

Standing tasks are routinely written as a rate: *"from time to time, comment on
a message"*, *"in 30% of cases"*, *"with a 70% probability"*, *"rarely"*. A
language model cannot honour that on its own. Asked to decide randomly it does
not sample — it emits whatever its decoding happens to favour, which is neither
the requested rate nor stable between turns. And nothing in the trace afterwards
distinguishes a real 30% from a model that simply felt agreeable that day.

So the draw moves into code, where it is uniform, and into the trace, where the
rolled number sits next to the threshold it was compared against.

## The contract

| | |
| --- | --- |
| Input | `percent` — the chance of a hit, `0`–`100`, fractions allowed |
| Output text | `HIT (rolled 12.34 < 30)` / `MISS (rolled 74.11 >= 30)` |
| Structured | `{ hit, percent, roll }` |

The verdict is **bare** (user decision, 2026-08-14): the tool says whether it hit
and nothing about what to do next. It has no idea what was at stake, so any
consequence it stated would be invented. What a miss means belongs to the task's
own instruction.

The numbers ride along in the text on purpose. `MISS` alone is unfalsifiable when
someone asks a week later why the bot stayed quiet; the roll and the threshold
make the turn checkable from its trace.

## The draw

`randomInt(0, 1_000_000) / 1_000_000 * 100` — a CSPRNG with rejection sampling,
so there is no modulo bias, at a fixed and explicit resolution rather than
whatever a float multiply happens to give.

The comparison is `roll < percent` over a draw from **[0, 100)**, which is what
makes the ends correct: at `0` nothing can fall below, and at `100` everything
does. A `<=` would let a 0% task fire once in a million.

`chance.ts` holds that arithmetic as a pure function so the boundaries are tested
without stubbing a random source; `server/mcp-tools.ts` only produces the roll.

## Interaction with task enforcement

A task-opened turn is required to call a tool (see
[tasks.md](tasks.md)). A task phrased as a probability now has one to call, which
is why a rule like *"from time to time, comment on a message"* reaches the chat
instead of being suppressed as an empty task turn.
