# Transports and normalisers

The shape — `listFiles` / `normalisePhotos` / `fetchPhotos`, and what each half
is for — is in [`README.md`](../../README.md#transport-normaliser-composition).
The traps are here.

## One directory per resource, one file per provider

`src/calendar/google.ts` and `src/files/google.ts`, each reachable as its own
entry point (`/calendar/google`, `/files/google`). A directory is one resource and
the files in it are interchangeable implementations of it, which is what makes
"every provider in `src/calendar/` passes the same test file" a sentence that
means something — [`ADR-0004`](../adr/0004-a-resource-may-have-more-than-one-provider.md).

Both providers are Google's today, so nothing yet enforces the interchangeability
the layout implies. A `dist` path in the export map, not a `src` one: see
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
[`ADR-0002`](../adr/0002-the-normalisers-report-nothing.md). Neither normaliser
reports anything now, and each has a test that fails if it starts: `recordConsole`
from `test/support/console.ts`, once in `test/files/google.test.ts` and once in
`test/calendar/google.test.ts`.

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

## All-day dates are floating

An all-day `start`/`end` is `YYYY-MM-DD` with no instant. `new Date()` on one
invents UTC midnight, which is a real date in a real zone and therefore a lie
that renders as a spurious time — or, west of UTC, the day before.

The only `Date` in the calendar half is inside `inclusiveEnd`, as arithmetic
scaffolding on a UTC-pinned string; it never escapes.

## Google's all-day `end.date` is exclusive

A 13th-to-16th event arrives ending on the **17th**. `normaliseEvents` steps it
back so `end` means the same thing for every event. Consumers that emit
`schema.org` `endDate` want the corrected value; leaving it exclusive puts the
structured data one day out of step with the visible page.
