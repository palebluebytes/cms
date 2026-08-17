# AGENTS.md

Zero-dependency package that reads a folder of files or a calendar at build time,
for static site generators. A Google Drive folder, a Google Calendar, or any
`.ics` URL — one **resource** read through one **provider**, and `CONTEXT.md`
defines both words.

Package manager is **pnpm**. Usage and rationale live in [`README.md`](README.md)
and in comments beside the code; the files below carry only the **traps** —
constraints whose violation produces no error. The tests pass, a consumer's build
goes green, and the data is wrong.

Two traps bear on every change:

- **`pnpm test` does not typecheck.** Node strips the types and runs the `.ts`
  sources directly, so a green run says nothing about whether the package
  compiles. `pnpm typecheck` is the only thing that reads the types.
- **The audience is any JS runtime, not Node.** Nothing in `src` may reach for
  `node:`, `Buffer`, `process.env` or a dependency. Workers and Deno are targets,
  and no test here runs on one.

## Traps by area

- **Editing `src`** — the whole toolbox a target runtime guarantees, and the half
  of the audience rule `tsc` cannot enforce:
  [`docs/agents/runtime-audience.md`](docs/agents/runtime-audience.md)
- **Touching the build, an import specifier or `tsconfig.json`** — what ships,
  why `.ts` and `.js` extensions differ by import kind, and the order `typecheck`
  must run in: [`docs/agents/typescript-build.md`](docs/agents/typescript-build.md)
- **Changing a transport or a normaliser, or adding a provider** — where a
  provider lives and what holds it to the contract, the Drive field mask,
  Google's three wrong defaults, all-day dates, the `.ics` reader's own traps
  (unfolding, recurrence, the sign-in page), and what must not cross the seam
  into this package: [`docs/agents/transports.md`](docs/agents/transports.md)
- **Writing a test** — why no test may need a credential, what a `fetch` double
  must be made of, and the one suite every calendar provider runs:
  [`docs/agents/testing.md`](docs/agents/testing.md)
- **Releasing, publishing, or editing a version number** — release-please owns
  all of it, and the commit subject is the changelog:
  [`docs/agents/releasing.md`](docs/agents/releasing.md)

## Working the repo

- **Issues** live as GitHub issues on `palebluebytes/google-cms`, driven through
  the `gh` CLI: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- **Triage labels** are the five canonical strings, unrenamed: `needs-triage`,
  `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- **Domain docs** — `CONTEXT.md` and `docs/adr/`, both created lazily:
  [`docs/agents/domain.md`](docs/agents/domain.md)
