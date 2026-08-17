# The normalisers report nothing

`displayDimensions` used to `console.warn` when Drive sent no usable dimensions
for a file, and the whole of what that line said is already in the returned
`Photo`: `width === null` holds in exactly the cases the warning fired in, and
`name` is right there beside it. A consumer that wants the list writes one line
over the array. Rejected as a side effect of the one module this package
documents as pure — in `CONTEXT.md`, in `docs/agents/transports.md` and in the
README — where it escaped through a global instead of through the interface, and
where the tests had to reassign `console.warn` to work around it. Whether a
missing dimension is worth mentioning during a build is a site's decision, and it
sits with sorting, filtering, formatting and the hard fail on an empty folder,
all of which this package declines for the same reason.

An injected sink — `normalisePhotos(payload, { onWarn })` — was the alternative.
Rejected too: it puts a second parameter on the interface whose whole value is
that a raw payload goes straight in, which is what lets `fetchPhotos` be one
expression and an Eleventy `_data` module be a single `default` export. One
caller would have supplied a sink. That is a hypothetical seam.

## A degraded record is handed over; a noise record is dropped

The two normalisers look inconsistent and are not. `normalisePhotos` hands over a
file whose dimensions are missing, with the gap visible as `null` — the record is
degraded, and a site may still want to lay it out. `normaliseEvents` drops a
cancelled or startless event and leaves no trace of it at all — that record is
transport-shaped noise, and there is nothing a site could do with it.

So "the return value carries the fact" is the rule for data this package hands
over, not a promise that everything Google sent is accounted for in the output.

## Consequences

Neither normaliser has any effect other than its return value. `console` is in
`lib.dom` and so a call to it compiles clean inside `src`, which makes this a
constraint whose violation produces no error — the shape `AGENTS.md` is built
around. The guard is a test in `test/files/google.test.ts` that poisons all five
`console` methods across the missing-dimensions path and asserts none was
reached for. It mutates a global to enforce the seam, which is the inverse of the
`captureWarnings` helper it replaced.

`displayDimensions` no longer takes the filename, because a parameter with no
reader is an invitation to use it.

Worth reopening if a consumer needs to gate a build on degraded data without
inspecting every `Photo` — a CI check that fails when any dimension is missing is
the case that would make it real. Note that the check is already available to
that consumer as a filter over the returned array; the question is only whether
this package should be the one to raise it.
