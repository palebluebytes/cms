# An event's time is a kind, not a boolean

`isAllDay` promised that `false` meant an instant — RFC3339 with an offset, safe
to hand to `new Date()`. Google can keep that promise, because a timed event
always comes back carrying an offset. It is not a promise about calendars; it is
a promise about one API.

RFC 5545 has **four** time forms, and two of them are not instants:

| Form                    | Example                     | An instant? |
| ----------------------- | --------------------------- | ----------- |
| `DATE`                  | `20260513`                  | No          |
| `DATE-TIME`, floating   | `20260513T190000`           | No          |
| `DATE-TIME` with `TZID` | `TZID=Europe/London:…T1900` | No          |
| `DATE-TIME` in UTC      | `20260513T180000Z`          | Yes         |

A floating `DATE-TIME` is a wall time with no zone at all — 7pm wherever the
reader is — and a `TZID` one is a wall time in a named zone with no offset in the
string. Under `isAllDay`, both would arrive as `false` and a consumer would
construct a `Date` from them, which is the exact class of silent lie the all-day
rule already exists to prevent.

So `kind` replaces it: `"date" | "floating" | "zoned" | "instant"`, one arm per
form. `isAllDay` is gone rather than kept as a derivation, because two ways to
ask the same question drift.

Rejected: resolving `TZID` to an offset inside the provider — `Intl` can compute
one for a wall time in a named zone — so that everything becomes an instant and
the boolean survives. It invents a fact the file did not state, which is the same
error as defaulting `timeZone`, and it fails outright on the zone names Outlook
writes.

## `timeZone` stays whatever the file said

`TZID` first, then `X-WR-TIMEZONE` — non-standard, and what Google's own `.ics`
export emits. Neither is guaranteed to be IANA: Outlook writes
`W. Europe Standard Time`. Discarding a value for failing validation would be
this package deciding on the site's behalf, and `kind: "zoned"` already tells a
consumer that resolving it is their job. A Windows name reaching `Intl` throws a
loud `RangeError` rather than misrendering quietly, which is the outcome the error
policy asks for.

IANA validation belongs in the fixtures, never in the hot path.

## Consequences

Breaking for every consumer that branches on `isAllDay`; the replacement is
`kind === "date"`. Pre-1.0 with first-party consumers, this is the cheapest the
change will ever be.

Until the ICS provider lands, two arms are unreachable — Google emits only
`"date"` and `"instant"`. That is worth stating rather than hiding: the type is
sized for the domain, not for today's single provider, and the conformance
fixtures are what stop the unused arms from being wrong.

The README's claim that these strings "sort correctly as strings" survives only
within one kind and one offset. It has always been fragile — two instants written
in different offsets sort wrongly as text — and Google hid that too, by answering
in the calendar's zone throughout. `kind` is what lets a consumer notice before
sorting.

Worth reopening if a consumer needs instants uniformly. The answer then is a
resolver they pass in, not a default this package picks.
