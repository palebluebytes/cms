# A resource may have more than one provider

Both resources read Google, and the package is named after it. The intent is that
the calendar resource — its type and its interpretation — should contain no
Google, so a second backend can be added without a consumer relearning anything.

There was no second backend. That is the condition under which an abstraction is
usually a mistake: with one implementation every joint is chosen against an
imagined caller, imagined callers never object, and the neutrality is **asserted**
rather than demonstrated. The first real backend then arrives and the seam is in
the wrong place.

So a second implementation was manufactured on purpose: an **`.ics` provider**.
It is cheap in dependency terms (plain `fetch`, no `node:`, no packages),
independently useful — an `.ics` URL is the only way to read a calendar with no
OAuth and no Google account at all, and every calendar system exports one — and
different enough from Google to put real pressure on the type. It applied that
pressure immediately: [`ADR-0005`](0005-an-events-time-is-a-kind-not-a-boolean.md)
and [`ADR-0006`](0006-expansion-is-a-guarantee-and-a-window-terminates-it.md)
both exist because ICS contradicted something this package had documented as
true.

## What a provider owns

A provider owns its transport **and** its normaliser, and hands back the domain
type. Rejected: a canonical intermediate payload that every provider translates
into, interpreted by one shared normaliser. With two Google listings as the only
examples, that intermediate would have been a Google payload wearing a neutral
name — two normalisation steps to arrive at the same coupling, less honestly.

This is [`ADR-0003`](0003-the-resource-shape-is-a-convention.md)'s distinction one
level up. Shared **behaviour** concentrates into an implementation, and
`internal/send.ts` and `internal/page-walk.ts` already are that: any provider
reading a paginated JSON listing gets both guards by construction. A shared
**outline** concentrates into parameters, and a provider is the outline written
again — which ADR-0003 accepted as the price of not having six of them.

Worth seeing what the ICS provider does _not_ reach for: there is no page walk in
a single file fetched over HTTP. `pages` is Google-shaped by nature rather than by
oversight, and a second provider declining to use it is not evidence that it was
extracted wrongly.

What the core does own is the logic belonging to the **medium** rather than the
vendor — the inclusive-end correction, the floating-date rules — because a second
provider that reimplements those gets them subtly wrong instead of sharing them.
`src/calendar/shared.ts` is where they go.

## Selection is an import path

`/calendar/google` and `/calendar/ics` are separate entry points, and nothing
dispatches: no registry, no `{ provider }` option, no `createClient`. A registry
is the `resource()` factory ADR-0003 rejected with a runtime choice stacked on
top, and it would force the union of every provider's options into one shape,
most of them meaningless at any given call. It would also cost the property the
README leads with — an Eleventy `_data/*.js` module may export only `default`, so
anything that must construct something first cannot be one expression.

The interface is therefore the return type. What holds a provider to it is
`CalendarEvent` plus a conformance suite: paired fixtures, one logical calendar
exported both as a Google `events.list` body and as an `.ics` file, asserted
equal on a **projection** — `summary`, `kind`, `start`, `end`, `isMultiDay`. Not
deep equality, because `id` is a Google event id versus a `UID` and `timeZone`
availability legitimately differs. Pretending otherwise would make the test
flaky and then ignored.

## Layout, and which claim is actually proven

`src/calendar/{google,ics,shared}.ts` and `src/files/google.ts`: one directory is
one resource, the interchangeable implementations sit beside the shared logic they
are obliged to use, and the conformance suite is "every provider in
`src/calendar/` passes this file". Provider-first (`src/google/…`) would scatter a
resource across directories and leave the shared module belonging to neither.

The calendar resource is provider-neutral and two implementations demonstrate it.
The files resource has exactly one provider and nothing demonstrates anything
about it, so the README states it as structure — "shaped so a second provider
slots in" — and not as a property. The same restraint applies to its type:
`Photo` keeps its fields and its name, because neutralising it against an
imagined second file backend is the mistake this ADR opens by describing.

## `auth` belongs to a provider, not to a resource

A secret `.ics` address **is** the credential; there is nothing to attach. So
`auth` is optional at the contract, required by the Google providers through
`requireAuth`, and applied by the ICS provider only if given — a private
Nextcloud export wants Basic. A `none()` sentinel was rejected as ceremony that
teaches a caller something the URL already told them.

## The name

`@palebluebytes/google-cms` becomes `@palebluebytes/cms`, and the repo with it. A
package named after a vendor it is supposed to be neutral about is a permanent
lie in the install line, and with only first-party consumers the rename costs one
import per site. `@palebluebytes/google-cms@0.2.0` stays published and working,
so nothing is forced to migrate.

## Consequences

`CONTEXT.md` gains **Provider** and stops listing it under _Avoid_ for Resource.
That ban was written when each resource had exactly one implementation, which is
precisely when "provider" **was** a synonym for "resource" — the reason for it
expires here rather than being overruled.

Two things ADR-0003 left unguarded get slightly worse: `PageWalkLabel` is a
closed union that a Google-shaped provider still has to be added to, and nothing
enforces `requireAuth` in a provider that needs it. Both stay recorded in
[`docs/agents/transports.md`](../agents/transports.md) rather than being designed
away.

`send` applies `auth` unconditionally, so a provider with optional auth either
passes an identity `Auth` or `send` grows a default. That is an implementation
choice this decision deliberately does not make.

None of it is written yet. The ICS provider lands **after** the conformance
fixtures exist, so the seam is tested against a real second implementation rather
than the fixtures being retrofitted to whatever the parser happened to emit.

Worth reopening when a **third** calendar provider arrives, or a second files
provider. Two implementations demonstrate more than one and less than three, and
`src/calendar/shared.ts` is the first place to look when a third one finds a joint
in the wrong place.
