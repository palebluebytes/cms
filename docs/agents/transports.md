# Transports and normalisers

The shape — `listFiles` / `normalisePhotos` / `fetchPhotos`, and what each half
is for — is in [`README.md`](../../README.md#transport-normaliser-composition).
The traps are here.

## One directory per resource, one file per provider

`src/calendar/{google,ics}.ts` and `src/files/google.ts`, each reachable as its
own entry point (`/calendar/google`, `/calendar/ics`, `/files/google`). A
directory is one resource and the files in it are interchangeable implementations
of it — [`ADR-0004`](../adr/0004-a-resource-may-have-more-than-one-provider.md).

**What enforces the interchangeability is `test/calendar/conformance.ts`**, which
both calendar providers run against one logical calendar. Adding a provider means
encoding that calendar in its format and calling the suite; a provider that does
not call it is not held to anything.

`src/calendar/shared.ts` holds what belongs to the MEDIUM rather than a vendor —
the inclusive-end correction and the day arithmetic under it. A provider that
reimplements one of those disagrees with the other by a day and no test outside
the conformance suite would notice.

A `dist` path in the export map, not a `src` one: see
[`typescript-build.md`](typescript-build.md).

## The two transports mirror each other on purpose

`listFiles` and `listEvents` follow the same outline and share almost no code.
Extracting a `resource()` that constructs both was considered and rejected in
[`ADR-0003`](../adr/0003-the-resource-shape-is-a-convention.md): it would take six
parameters to save six lines twice. Adding a third resource means writing the
outline again — and naming it in `PageWalkLabel`, and remembering `requireAuth`,
neither of which anything enforces. A second provider of an existing resource
means the same, minus `PageWalkLabel` if it has no page walk to label.

## Nothing crosses the seam that belongs to a site

Ordering, filtering, formatting, a future/past partition, a default time zone, a
hard fail on an empty folder: **all of these are consumer decisions.** Each one
looks like a small kindness and each one serves exactly one caller.

The one that keeps trying to sneak back is a default `timeZone` — the transport
returns `undefined`, deliberately.

## The normalisers must stay pure

`normalisePhotos` and `normaliseEvents` take a payload and return data, and their
**only effect is that return value** — the general rule, of which no network, no
clock, no environment and no locale are the four cases that bite. A `new Date()`
or a `toLocaleDateString` in there breaks nothing visibly; it just makes the
function untestable at the point it is most worth testing, which is the property
the whole testing story rests on.

A `console.warn` is the one that got in, precisely because it is none of those
four — it lived in `displayDimensions` until
[`ADR-0002`](../adr/0002-the-normalisers-report-nothing.md). No normaliser reports
anything now, and each of the three has a test that fails if it starts:
`recordConsole` from `test/support/console.ts`, in
`test/files/google.test.ts`, `test/calendar/google.test.ts` and
`test/calendar/ics.test.ts`. A new provider without one is a normaliser nothing
holds to silence.

## The page walk is one module, and it is not in the transports

`listFiles` and `listEvents` say what one page's URL is and hand it to
[`src/internal/page-walk.ts`](../../src/internal/page-walk.ts). The loop, the
`maxPages` cap, the refusal to follow a repeated `pageToken` and the refusal to
read a non-JSON body all live there, tested in `test/page-walk.test.ts` — not
through either transport. A fix belongs in the walk, and a third transport gets
the guards by construction rather than by being copied from one of these two.

## Applying the credential is one module below that

Constructing the `Request`, applying `auth`, sending it and refusing a non-OK
answer are [`src/internal/send.ts`](../../src/internal/send.ts) — one call, made
by the page walk for every page and by `fetchBytes` for its single download. The
`fetch` default lives there and only there.

`send` has no test file of its own, deliberately: it holds a template string and
an `if`, and both are already pinned where they are visible — the exact non-OK
sentence in `test/page-walk.test.ts`, the status in `test/files/google.test.ts`, and the
credential reaching every page in both. A test that only proved interpolation
works would be testing the extraction rather than the behaviour.

The caller supplies the verb phrase (`read folder`, `download Drive file <id>`)
because only it knows its own noun; what `send` owns is the
`Failed to …: <status> <statusText>` around it. A new caller that invents a
different sentence shape has taken a decision that belongs to
[`ADR-0001`](../adr/0001-errors-carry-messages-not-codes.md).

What stays with a transport is what Google gets wrong per API: the field mask
below, and the three defaults after it. The walk knows one field name,
`nextPageToken`, and nothing else about either API.

The label it takes is a closed union — adding a transport means naming it in
`PageWalkLabel`.

## `nextPageToken` must be in the Drive field mask

`fields=files(...)` omits `nextPageToken`, and the page walk then stops after one
page. A folder of 1500 files silently becomes 1000, with no error anywhere. The
mask is built as `nextPageToken,files(...)` and `test/files/google.test.ts` pins it.

## Google's defaults are wrong in three specific ways

All three are set by the calendar transport and must stay set. What they do for a
consumer is in [`README.md`](../../README.md#what-the-transport-always-sets);
what breaks when one is dropped is here.

| Parameter           | Google's default | What dropping it costs                                                          |
| ------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `singleEvents`      | `false`          | An unexpanded master with an `RRULE`; a whole series renders as one event       |
| `orderBy=startTime` | unset            | A non-deterministic page walk (and the API accepts it only with `singleEvents`) |
| `maxResults`        | 250              | A single un-paginated request that drops the tail, silently                     |

## All-day dates are floating, and `kind` is the only thing that says so

An all-day `start`/`end` is `YYYY-MM-DD` with no instant. `new Date()` on one
invents UTC midnight, which is a real date in a real zone and therefore a lie
that renders as a spurious time — or, west of UTC, the day before.

Every `Date` in the calendar half is scaffolding, and none of them escapes:
`addDays` in `shared.ts` (which `inclusiveEnd` is made of), the month and weekday
stepping in `internal/recurrence.ts`, and the window comparison in `ics.ts`.

The rule is not "no `Date`". It is that a `Date` may only be built from a string
that **already names an instant** — one carrying `Z` or an offset — or from a
date-only string this package pinned to UTC itself. What must never happen is a
`Date` built from a WALL TIME, which is why `ics.ts` compares a `"floating"` or
`"zoned"` event against the window as text and only an `"instant"` as a moment.
Putting a wall time through `Date` reads it in the build machine's zone, and
nothing downstream can tell.

`kind` carries this to a consumer, and it has four arms because RFC 5545 has four
time forms ([`ADR-0005`](../adr/0005-an-events-time-is-a-kind-not-a-boolean.md)).
**This provider can only ever produce two of them** — `"date"` and `"instant"` —
because Google's `dateTime` always carries an offset. Widening that to a wall
time, or narrowing `kind` back to a boolean because two arms look unused, breaks
the file-reading providers the type exists for and nothing here would fail.

## Google's all-day `end.date` is exclusive

A 13th-to-16th event arrives ending on the **17th**. `normaliseEvents` steps it
back so `end` means the same thing for every event. Consumers that emit
`schema.org` `endDate` want the corrected value; leaving it exclusive puts the
structured data one day out of step with the visible page.

## The `.ics` provider's own traps

### Unfolding removes the line break AND one whitespace character

RFC 5545 §3.1 folds a long line by inserting a break followed by a single space
or tab, and unfolding removes both. A space belonging to the value is therefore
written twice by whoever folded it. Removing only the break inserts a space into
every long `DESCRIPTION` in the file; not unfolding at all is worse — the tail of
the value becomes a property name nobody asked about and the value is silently
truncated. Pinned in `test/calendar/ics-parse.test.ts`.

### Components are a stack, not a flag

`VALARM` nests inside `VEVENT` and carries its own `DESCRIPTION` and `TRIGGER`. A
flat "am I inside an event" test reads the alarm's text as the event's, which
renders as an event whose description is "Reminder".

### Expansion moves the date, never the time of day

`internal/recurrence.ts` recurs by stepping the DATE part and carrying the time
part along verbatim. That is what lets a floating or zoned series recur at all
without resolving a zone — "weekly at 19:00" means the 19:00 the file wrote.
Reaching for a `Date` on the whole value would silently convert a wall time
through the build machine's zone.

### Under-expanding must throw, and does

An `RRULE` part the expander does not implement (`BYMONTHDAY`, `BYSETPOS`, an
ordinal `BYDAY`, a sub-daily `FREQ`) throws rather than returning the instances it
did understand. Half a series missing renders as a calendar that is merely quiet.
The supported subset is `DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY` with `INTERVAL`,
`COUNT`, `UNTIL`, plain `BYDAY` and `WKST`, plus `EXDATE` and `RECURRENCE-ID`.

### An unbounded series needs a window, and will not invent one

No `COUNT`, no `UNTIL` and no `to` throws. Choosing "now" would put a clock inside
a normaliser and make a build's output depend on when it ran.

### A private calendar answers `200 text/html`

The same trap as `fetchBytes` on the Drive side: a missing or stale credential
gets a sign-in page, served cheerfully. Parsing it finds no `VEVENT` and would
return `[]` — a calendar that reads as empty rather than unreadable. `listEvents`
refuses a `text/html` body for exactly that reason.

### `MONTHLY` skips a missing day rather than clamping it

31 January monthly has no February instance, and 29 February yearly skips common
years — 2100 among them, by the century rule. Clamping to the 28th would invent an
instance on a day the rule never named.
