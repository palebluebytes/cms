# Tests need neither network nor credentials

Both transports take `fetch` as an option and the normalisers are pure, so every
test is a plain function call: `node --test` over the `.ts` sources, with no
fixtures directory, no mock server and no key. Keep it that way — a test that
needs a credential is a test nobody runs.

## One suite, every calendar provider

`test/calendar/conformance.ts` holds ONE logical calendar as the answers every
provider must produce, and each provider's test file encodes that same calendar
in its own source format and calls
`conformsToTheCalendarContract(name, read)`. It is the only test that can fail
when a decision lands on the wrong side of the seam — shape assertions pass
happily while two providers disagree about what a three-day event means.

Three things it compares loosely, each for a stated reason, and none of them
accidental: **order** (the contract promises events, not an order), **how an
instant is spelled** (`+00:00` and `Z` are the same moment, and rewriting one
into the other would discard the offset the source stated), and **`id` and
`timeZone`**, which are outside the projection because a Google event id is not
a `UID` and zone availability legitimately differs. Tightening any of those
turns a real agreement into a flaky test, which is how a suite stops being run.

The encodings are literals in the test files, not files on disk — that is what
keeps "no fixtures directory" true above.

It bites: it has been checked against a deliberately broken provider that kept a
cancelled event, dropped a series instance, invented a title and left an all-day
end uncorrected. Each one fails it.

## A `fetch` double answers with a real `Response`

`ok` derived from a status, a real `Headers`, a real `arrayBuffer()`. A literal
carrying `ok`/`json` gets to agree with whatever the code happens to read, which
is the one thing a transport test must not do.

## A normaliser that says anything fails a test

`recordConsole` in `test/support/console.ts` runs a normaliser with every
`console` method replaced and returns what it called, which must be nothing —
[`ADR-0002`](../adr/0002-the-normalisers-report-nothing.md). Both normalisers have
one, because `console` is in `lib.dom` and so a call to it compiles clean inside
`src`: nothing else here would go red.

## A green test run is not a typecheck

`pnpm test` strips the types rather than checking them; only `pnpm typecheck`
reads them, and the order of its two configs matters — see
[`typescript-build.md`](typescript-build.md).
