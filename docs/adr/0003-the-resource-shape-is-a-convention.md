# The resource shape is a convention, not a module

Drive and Calendar are the package's two resources, and both are written to the
same outline: check `auth`, build one page's URL, walk it, harvest what each page
carries, normalise the result. Read side by side the two files look like one file
written twice, and an architecture review reads that as duplication waiting to be
extracted.

A `resource()` constructing both was considered and rejected. It would have to
take six things — the caller name for `requireAuth`, the URL builder, the page
walk's label, the `capHint` sentence, the harvest, and the normaliser — over two
option types sharing only `auth`, `fetch` and `maxPages`. That is an interface as
complex as its implementation, and it would buy about six lines from each of two
files. The narrower version, a `paired(list, normalise)` covering only the
`fetchPhotos`/`fetchEvents` composition, costs each of those functions its
docblock and its declared return type to save one line twice.

## Why the walk and the send were different

Both were extracted, and the contrast is the point. `internal/page-walk.ts` owns
a loop, a `maxPages` cap, a refusal to follow a repeated `pageToken` and a
refusal to read a non-JSON body — behaviour neither transport should have to
re-derive, and every line of it identical for any listing. `internal/send.ts`
owns four steps in a fixed order that no caller may skip.

Those are shared **behaviour**. The resource shape is a shared **outline**, and
the two abstract differently: behaviour concentrates into an implementation,
while an outline concentrates into parameters. Six parameters is what that costs
here, and parameters are interface.

The clearest evidence is the harvest. Drive accumulates one array; Calendar
accumulates an array and takes the calendar's `timeZone` off the first page.
That difference is why `pages` yields rather than accumulating, and a factory
would have to take it as a function anyway.

## Consequences

`CONTEXT.md` defines Resource, so the term is available for describing the code
without implying a module exists to instantiate. Adding a third resource means
writing the outline a third time.

Two things stay unguarded by construction, both recorded in
[`docs/agents/transports.md`](../agents/transports.md) instead, which is the
cheap form of the same guard: nothing stops a new transport forgetting
`requireAuth` — the cost being a confusing 403 from Google rather than a message
naming the constructors — and `PageWalkLabel` is a closed union that has to be
edited to add one.

Worth reopening when a third resource actually arrives. Three call sites make a
seam real where two made it arguable, the drift risk stops being hypothetical,
and guaranteeing `requireAuth` and the label by construction starts to pay for
the parameters it costs.
