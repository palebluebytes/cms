# AGENTS.md

Constraints for this package. Everything here shares one property: **break it and
nothing errors** — the tests pass, a consumer's build goes green, and the data is
wrong.

Usage and rationale live in [`README.md`](README.md) and in comments beside the
code; this file is only the traps.

## The audience is any JS runtime, not Node

No `node:` imports, no `Buffer`, no `process.env`, no dependencies in `/drive` or
`/calendar`. `fetch`, `Request`, `Headers`, `URL`, `Uint8Array` and WebCrypto are
the whole toolbox — all of them native on Node 22+, Deno, Bun and Workers.

Reaching for `node:crypto` or `Buffer` does not fail here; it fails in a
consumer's edge build, which is the one place nobody runs these tests.

## `fetchBytes` returns `Uint8Array`, and eleventy-img will not take it

`@11ty/eleventy-img` tests `Buffer.isBuffer(src)` (`src/image.js:135`), which is
**false** for a plain `Uint8Array`. Returning a `Buffer` to fix that would make
the package Node-only, so the README tells Node consumers to wrap:
`Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)`.

If a test ever starts asserting `Buffer.isBuffer(await fetchBytes(...))`, someone
has quietly changed the audience.

## The normalisers must stay pure

`normalisePhotos` and `normaliseEvents` take a payload and return data. No
network, no clock, no environment, no locale. That is what lets a consumer feed a
checked-in fixture through the real interpretation without faking a `Response` —
the property the whole testing story rests on.

A `new Date()` or a `toLocaleDateString` in there breaks nothing visibly; it just
makes the function untestable at the point it is most worth testing.

## Nothing crosses the seam that belongs to a site

Ordering, filtering, formatting, a future/past partition, a default time zone, a
hard fail on an empty folder: **all of these are consumer decisions.** Each one
looks like a small kindness and each one serves exactly one caller.

The one that keeps trying to sneak back is a default `timeZone` — the transport
returns `undefined`, deliberately.

## `nextPageToken` must be in the Drive field mask

`fields=files(...)` omits `nextPageToken`, and the page walk then stops after one
page. A folder of 1500 files silently becomes 1000, with no error anywhere. The
mask is built as `nextPageToken,files(...)` and
`test/drive.test.js` pins it.

## Google's defaults are wrong in three specific ways

All three are set by the transports and must stay set:

| Parameter           | Google's default | Why it matters                                                                                       |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `singleEvents`      | `false`          | Returns an unexpanded master with an `RRULE`; a whole series renders as one event                    |
| `orderBy=startTime` | unset            | The page walk is non-deterministic without it (and the API only accepts it alongside `singleEvents`) |
| `maxResults`        | 250              | A single un-paginated request drops the tail, silently                                               |

## All-day dates are floating

An all-day `start`/`end` is `YYYY-MM-DD` with no instant. `new Date()` on one
invents UTC midnight, which is a real date in a real zone and therefore a lie
that renders as a spurious time — or, west of UTC, the day before.

The only `Date` in the calendar half is inside `inclusiveEnd`, as arithmetic
scaffolding on a UTC-pinned string; it never escapes.

## Google's all-day `end.date` is exclusive

A 13th-to-16th event arrives ending on the **17th**. `normaliseEvents` steps it
back so `end` means the same thing for every event. Consumers that emit
`schema.org` `endDate` want the corrected value; leaving it exclusive puts the
structured data one day out of step with the visible page.

## Tests need neither network nor credentials

Both transports take `fetch` as an option and the normalisers are pure, so every
test is a plain function call. `npm test` is `node --test` with no fixtures
directory, no mock server and no key. Keep it that way: a test that needs a
credential is a test nobody runs.

## Releases are release-please's, not yours

Releases follow the release-plz model — a bot maintains one open **release PR**;
merging it is the act of releasing. release-plz itself is cargo-only, so the
implementation is [release-please](https://github.com/googleapis/release-please),
the tool release-plz was ported from. Two workflows, one config pair:

| File                            | Owns                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `.github/workflows/ci.yml`      | Tests on Node 22 and 24, plus a Prettier check, on every PR |
| `.github/workflows/release.yml` | The release PR, and the publish that follows merging it     |
| `release-please-config.json`    | Release type, changelog sections, pre-1.0 bumping           |
| `.release-please-manifest.json` | **The** current version                                     |

Push to `main` → release-please updates the release PR. Merge it → it tags,
creates the GitHub release, and only then does the publish job run.

### The CI matrix and `engines` must stay in step

`engines` says `>=22` and CI tests 22 and 24 — every advertised runtime is
verified, which is the property worth keeping. Widening `engines` without
adding the matching matrix entry breaks nothing here and everything in a
consumer's install; the same is true of README and `src/auth.js`, which state
the floor in prose.

### Never hand-edit a version

`.release-please-manifest.json` is the source of truth; the `version` in
`package.json` is a copy release-please writes. Bumping `package.json` by hand
doesn't error — it gets silently overwritten on the next release, and until then
every consumer reads a version that was never published.

### The commit subject _is_ the changelog

`type(scope): subject` is not house style here, it is input. A fix committed as
`feat:` releases a minor version and lands under **Features** for good; work
committed as `chore:` is hidden from the changelog entirely. Nothing warns you —
the release just describes itself wrongly, permanently.

### Pre-1.0, a breaking change is a _minor_ bump

`bump-minor-pre-major` is on. While the version is `0.x`, a `BREAKING CHANGE:`
footer takes `0.1.0` → `0.2.0`, not `1.0.0`. Going to 1.0 is a deliberate act —
set `1.0.0` in the manifest — not something a commit can trigger by accident.

### The release PR depends on a repo setting, not just this repo

**Settings → Actions → General → Workflow permissions → "Allow GitHub Actions
to create and approve pull requests"** must be on. With it off, release-please
still runs, still computes the version, still pushes its
`release-please--branches--main` branch — and then fails on the last call with
`GitHub Actions is not permitted to create or approve pull requests`. Everything
looks configured; only the PR is missing.

### Prettier must not check what release-please writes

`CHANGELOG.md` and `.release-please-manifest.json` are in `.prettierignore`
because release-please rewrites them in its own format. Take them out and the
first release lands a `main` that fails its own format check, in a file no
human touched.

### CI does not run on the release PR

Releases are cut with the default `GITHUB_TOKEN`, and PRs it opens deliberately
do not trigger further workflows — GitHub's own recursion guard. So the green
check on `main` is the last signal you get. That is exactly why `release.yml`
re-runs the tests inside the publish job: it is the only gate between the merge
and an immutable version.

Switching to a PAT or GitHub App token would make CI run on release PRs. Nothing
else about the setup depends on that choice.

### A published version can never be replaced

GitHub Packages refuses to republish a version that already exists. There is no
`--force` and deleting-then-republishing is blocked too. A bad publish is fixed
only by releasing another version.

### `files` decides what ships, and it is `["src"]`

Anything a consumer needs at runtime must live under `src/`. Add a runtime file
anywhere else and the tests still pass, the publish still succeeds, and the
tarball is missing it — the failure surfaces in a consumer's build.

### `publishConfig.registry` is the only thing aiming at GitHub

Remove it and `pnpm publish` goes to npmjs.com — a different registry, a
different audience, and a package name that isn't yours to take. The scope must
also stay lowercase and equal to the GitHub owner (`@palebluebytes` ↔
`palebluebytes`); GitHub Packages rejects any other pairing.

### Consumers need a token even though the repo is public

GitHub Packages requires authentication to _install_, public or not. A consumer
needs a `read:packages` token and an `.npmrc`:

```
@palebluebytes:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

This is worth stating in `README.md` before anyone is told to install it —
without it the install fails with a bare 401 that reads like the package doesn't
exist.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `palebluebytes/google-cms`, driven through the
`gh` CLI. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root, both created
lazily. See [`docs/agents/domain.md`](docs/agents/domain.md).
