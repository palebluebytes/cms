# TypeScript ships as JavaScript

`src/*.ts` is the input; `dist/` — plain ESM plus `.d.ts` — is the package. No
consumer ever compiles a file of ours: a `.ts` in the export map would demand a
TypeScript toolchain from an Eleventy or Workers build that has none, which is
the same audience argument as [`runtime-audience.md`](runtime-audience.md).

## `dist/` is not committed and not present after a fresh clone

`prepack` runs `tsc`, so `pnpm publish` builds it — but any CI job that publishes
must install dependencies first, or `prepack` fails on a missing compiler.

## Node strips types; it does not check them

`pnpm test` runs the `.ts` sources directly (type stripping, unflagged since Node
22.18 and 24.x), which means a green test run says nothing about whether the
package compiles. The `typecheck` job in CI is the only thing that reads the
types.

**`pnpm typecheck` runs the root config before `tsc -p test`, and the order is
load-bearing.** `test/tsconfig.json` adds `"types": ["node"]` back, and its
program pulls in the `src` files the tests import — so `src` is typechecked
WITHOUT the `@types/node` guard there. Reversing the order, or running only
`tsc -p test`, silently drops the guard.

## Value imports carry `.ts`, type-only imports carry `.js`

The `.ts` is what lets Node run the sources unbuilt, and
`rewriteRelativeImportExtensions` turns those into `.js` on the way into `dist`.
It does NOT rewrite a type-only import, which survives verbatim into the emitted
`.d.ts` — write `import type … from "./auth.ts"` and the published declarations
point at a `.ts` file that does not ship. Node erases type-only imports entirely,
so the `.js` there costs nothing at runtime.

## Every construct must survive erasure

`erasableSyntaxOnly` is on: type stripping erases, it does not transform, so
anything that needs emitted code has no way to exist. No `enum`, no `namespace`,
no constructor parameter properties.
