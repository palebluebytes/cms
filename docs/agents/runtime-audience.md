# The audience is any JS runtime, not Node

`fetch`, `Request`, `Headers`, `URL`, `Uint8Array` and WebCrypto are the whole
toolbox — all of them native on Node 22+, Deno, Bun and Workers. Nothing in `src`
may reach for `node:`, `Buffer`, `process.env` or a dependency.

Reaching for `node:crypto` or `Buffer` does not fail here; it fails in a
consumer's edge build, which is the one place nobody runs these tests.

## The compiler guards the Node half, and only the Node half

`tsconfig.json` sets `"types": []` so that `src` cannot see `@types/node` at all:
`Buffer`, `process` and `node:` imports are compile errors rather than review
findings. Adding `"node"` to the root config takes that guard away and nothing
goes red.

`"lib": ["es2023", "dom"]` is there for `fetch`/`Request`/`Headers`/`URL`/
`console`, and it brings `document`, `localStorage` and `window` with them —
every bit as absent from Workers and Deno Deploy as `Buffer` is, and every bit as
clean at compile time. Replacing `dom` with hand-written ambients would close it,
at the cost of a mini `lib.dom` to maintain and extend for every platform API a
future `serviceAccount` needs. Until someone does that, browser-only globals are
caught by reading the diff, not by `tsc`.

The test program pulls in the `src` files it imports and adds `"types": ["node"]`
back, so the guard depends on the order `typecheck` runs its two configs in — see
[`typescript-build.md`](typescript-build.md).

## `fetchBytes` returns `Uint8Array`, and eleventy-img will not take it

`@11ty/eleventy-img` tests `Buffer.isBuffer(src)` (`src/image.js:135`), which is
**false** for a plain `Uint8Array`. Returning a `Buffer` to fix that would make
the package Node-only, so the README tells Node consumers to wrap:
`Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)`.

If a test ever starts asserting `Buffer.isBuffer(await fetchBytes(...))`, someone
has quietly changed the audience.
