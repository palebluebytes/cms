# cms

Reading a folder of files or a calendar at build time, for static site
generators — a Google Drive folder, a Google Calendar, or any `.ics` URL. This is
the glossary; the traps live in [`AGENTS.md`](AGENTS.md) and the usage in
[`README.md`](README.md).

## Language

**Resource**:
One kind of listing this package can read — a folder of files, a calendar — as a
Transport and a Normaliser plus the function composing the two. There are exactly
two, one entry point per provider of each: `listFiles` / `normalisePhotos` /
`fetchPhotos`, and `listEvents` / `normaliseEvents` / `fetchEvents`. A shape the
code follows and deliberately not a module it instantiates —
[`ADR-0003`](docs/adr/0003-the-resource-shape-is-a-convention.md).
_Avoid_: source, integration

**Provider**:
One backend's implementation of a resource: its Transport and its Normaliser,
handing back the resource's type. Chosen by import path and never by a parameter
— [`ADR-0004`](docs/adr/0004-a-resource-may-have-more-than-one-provider.md). The
calendar resource has two, Google and `.ics`; the files resource has one.
_Avoid_: adapter, driver, client, backend as a noun in code

Provider was listed under _Avoid_ for Resource until ADR-0004, and correctly so:
with one implementation each, the two words named the same thing. They stop being
synonyms at the second implementation.

**Transport**:
The half of a provider that talks to the outside world and interprets nothing — it
decides what to ask for and hands back the raw payload.
_Avoid_: client, fetcher, service

**Normaliser**:
The half of a provider that turns a raw payload into what a page lays out. Pure:
its only effect is its return value — so no network, no clock, no environment, no
locale, and nothing written to a console.
_Avoid_: mapper, parser, transformer

**Page walk**:
Following `nextPageToken` until a listing is exhausted, or failing loudly rather
than truncating. One of the ways this package could silently hand back wrong
data, and therefore a thing with a name.
_Avoid_: pagination, paging, page loop

**Kind**:
Which of RFC 5545's four time forms an event's `start` and `end` hold, and
therefore what a consumer may safely do with them: `"date"`, `"floating"`,
`"zoned"`, `"instant"`. Only the last is an instant —
[`ADR-0005`](docs/adr/0005-an-events-time-is-a-kind-not-a-boolean.md). Google's
provider reaches only the first and the last.
_Avoid_: `isAllDay` as a concept — it named only the first form and implied the
other three were instants.

**Expansion**:
Turning a recurring series into its instances. A guarantee this package makes, not
a parameter of one API: Google satisfies it server-side via `singleEvents`, and
the `.ics` provider does it itself in `src/calendar/internal/recurrence.ts` —
[`ADR-0006`](docs/adr/0006-expansion-is-a-guarantee-and-a-window-terminates-it.md).
_Avoid_: recurrence handling, unrolling, instantiation

**Window**:
`from`/`to`: events OVERLAPPING it, and an unbounded series expanded within it.
One meaning for every provider — Google maps it to `timeMin`/`timeMax`, the
`.ics` provider filters and expands with it. Never defaulted, because a default
window loses half a page and choosing one end needs a clock.
_Avoid_: range, period, timeMin/timeMax as names outside the Google provider
