# Tests need neither network nor credentials

Both transports take `fetch` as an option and the normalisers are pure, so every
test is a plain function call: `node --test` over the `.ts` sources, with no
fixtures directory, no mock server and no key. Keep it that way — a test that
needs a credential is a test nobody runs.

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
