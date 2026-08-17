# Expansion is a guarantee, and a window is how it terminates

`singleEvents=true` is filed under Google's wrong defaults, which undersells it. A
consumer never receiving an unexpanded recurring series is a property of this
package, not a parameter of one API — Google merely satisfies it server-side for
free, and reading it as "a default to correct" hides that the guarantee was ever
made.

An `.ics` file has no server. It hands over `RRULE`, `EXDATE` and
`RECURRENCE-ID` and expects the reader to do the work. So either expansion is part
of what a calendar provider promises, or the promise was Google's all along and a
consumer has to ask which provider it is holding.

It is part of the promise. The ICS provider expands, honouring `EXDATE` and
`RECURRENCE-ID` overrides, and it does so **without a clock**: a series bounded by
`COUNT` or `UNTIL` expands from the rule alone.

Two refusals carry the rest, both messages rather than codes, per
[`ADR-0001`](0001-errors-carry-messages-not-codes.md):

- An **unbounded** series with no window **throws**. There is nothing to expand
  into, and picking "now" would put a clock inside a normaliser.
- An `RRULE` form the expander does not implement **throws**. Under-expanding is
  the failure this package is built against — half a series missing renders as a
  calendar that is merely quiet, and nothing anywhere says otherwise.

## One window, meaning one thing

`from`/`to`: events overlapping it, unbounded series expanded within it. Google's
provider maps them to `timeMin`/`timeMax`; the ICS provider filters client-side by
the same rule, which is `end > from && start < to` — Google's `timeMin` bounds an
event's **end** and `timeMax` bounds its **start**, so the obvious `start >= from`
would quietly drop an event already in progress.

Rejected: two option pairs, a `timeMin`/`timeMax` filter alongside a separate
expansion horizon. The names would differ by provider and the conformance fixtures
could not compare a windowed read at all. Also rejected: a window that only bounds
expansion and never filters — passing `timeMin` to Google filters, unavoidably and
server-side, so the divergence would exist and simply be undocumented.

`from`/`to` rather than `timeMin`/`timeMax` because the names are now the
package's, not Google's. The policy underneath is unchanged: **no default
window**. A site rendering past appearances would silently lose half its page to
one.

## The divergence that is accepted rather than fixed

A floating `kind: "date"` event compared against a window needs a zone, and this
package will not invent one. So the ICS provider compares date-wise, on the first
ten characters — the same zone-free trick `isMultiDay` already uses — while Google
compares server-side in the calendar's zone.

**The two can therefore disagree by one day on an event straddling the very edge
of the window.** It is documented, and the paired fixtures either avoid an
edge-straddling event or assert the difference deliberately. The alternative is
inventing a zone in order to agree, which trades a stated divergence for an
unstated fabrication.

## Consequences

Renaming `timeMin`/`timeMax` is breaking. The `maxPages` cap and its `capHint`
sentence stay exactly as they are for Google: an unbounded series expanded
server-side is still how a walk fails to terminate.

The recurrence expander is the bulk of the work in adding the ICS provider, and it
exists because of this decision rather than because a caller asked for it. That is
the price of the guarantee being a guarantee.

Worth reopening if the expander's unimplemented-rule refusal starts firing on real
files more often than it protects anyone — that would be evidence the subset is
too small, not that the refusal is wrong.
