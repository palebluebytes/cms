# Releases are release-please's, not yours

Releases follow the release-plz model — a bot maintains one open **release PR**;
merging it is the act of releasing. release-plz itself is cargo-only, so the
implementation is [release-please](https://github.com/googleapis/release-please),
the tool release-plz was ported from. Two workflows, one config pair:

| File                            | Owns                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| `.github/workflows/ci.yml`      | Tests on Node 22 and 24, plus typecheck and Prettier, per PR |
| `.github/workflows/release.yml` | The release PR, and the publish that follows merging it      |
| `release-please-config.json`    | Release type, changelog sections, pre-1.0 bumping            |
| `.release-please-manifest.json` | **The** current version                                      |

Push to `main` → release-please updates the release PR. Merge it → it tags,
creates the GitHub release, and only then does the publish job run.

## Never hand-edit a version

`.release-please-manifest.json` is the source of truth; the `version` in
`package.json` is a copy release-please writes. Bumping `package.json` by hand
doesn't error — it gets silently overwritten on the next release, and until then
every consumer reads a version that was never published.

## The commit subject _is_ the changelog

`type(scope): subject` is not house style here, it is input. A fix committed as
`feat:` releases a minor version and lands under **Features** for good; work
committed as `chore:` is hidden from the changelog entirely. Nothing warns you —
the release just describes itself wrongly, permanently.

## Pre-1.0, a breaking change is a _minor_ bump

`bump-minor-pre-major` is on. While the version is `0.x`, a `BREAKING CHANGE:`
footer takes `0.1.0` → `0.2.0`, not `1.0.0`. Going to 1.0 is a deliberate act —
set `1.0.0` in the manifest — not something a commit can trigger by accident.

## The CI matrix and `engines` must stay in step

`engines` says `>=22` and CI tests 22 and 24 — every advertised runtime is
verified, which is the property worth keeping. Widening `engines` without adding
the matching matrix entry breaks nothing here and everything in a consumer's
install; the same is true of README and `src/auth.ts`, which state the floor in
prose.

`engines` describes the runtime the **published** `dist` needs, which is any
Node 22. Running the tests needs Node 22.18, where type stripping stopped being
a flag — a distinction worth keeping straight before "raising the floor" to
match.

## Prettier must not check what release-please writes

`CHANGELOG.md` and `.release-please-manifest.json` are in `.prettierignore`
because release-please rewrites them in its own format. Take them out and the
first release lands a `main` that fails its own format check, in a file no human
touched.

## CI does not run on the release PR

Releases are cut with the default `GITHUB_TOKEN`, and PRs it opens deliberately
do not trigger further workflows — GitHub's own recursion guard. So the green
check on `main` is the last signal you get. That is exactly why `release.yml`
re-runs the tests inside the publish job: it is the only gate between the merge
and an immutable version.

Switching to a PAT or GitHub App token would make CI run on release PRs. Nothing
else about the setup depends on that choice.

## The release PR depends on a repo setting, not just this repo

**Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to
create and approve pull requests"** must be on. With it off, release-please still
runs, still computes the version, still pushes its
`release-please--branches--main` branch — and then fails on the last call with
`GitHub Actions is not permitted to create or approve pull requests`. Everything
looks configured; only the PR is missing.

## What gets published

### A published version can never be replaced

GitHub Packages refuses to republish a version that already exists. There is no
`--force` and deleting-then-republishing is blocked too. A bad publish is fixed
only by releasing another version.

### `files` decides what ships, and it is `["dist", "src"]`

`dist` is what runs; `src` rides along only so the `.js.map` and `.d.ts.map`
files resolve to real sources in a consumer's debugger and editor. Anything a
consumer needs at runtime must therefore be reachable from a compiled `dist`
module. Add a runtime file outside `src/`, or an export map entry pointing
anywhere but `dist`, and the tests still pass, the publish still succeeds, and
the tarball is missing it — the failure surfaces in a consumer's build.

### `publishConfig.registry` is the only thing aiming at GitHub

Remove it and `pnpm publish` goes to npmjs.com — a different registry, a
different audience, and a package name that isn't yours to take. The scope must
also stay lowercase and equal to the GitHub owner (`@palebluebytes` ↔
`palebluebytes`); GitHub Packages rejects any other pairing.

### `repository.url` names a repo that does not exist yet

The package is `@palebluebytes/cms` and `repository.url` says
`github.com/palebluebytes/cms`, but **the GitHub repo is still named
`google-cms`.** GitHub Packages associates a package with a repository through
that field, so **the repo has to be renamed before anything is published under
the new name.** Renaming it afterwards is the harder order: a published version
can never be replaced.

Both halves of the rename are one act — see
[`ADR-0004`](../adr/0004-a-resource-may-have-more-than-one-provider.md).

### The version starts at 0.1.0 because the NAME is new

`@palebluebytes/google-cms` reached `0.2.0`. `@palebluebytes/cms` has never been
published, so `.release-please-manifest.json` says `0.1.0` and should.

This matters at exactly one moment: merging a branch that predates the old
package's `0.2.0` release commit produces a conflict in `package.json` and the
manifest, and the tempting resolution — "take the higher number" — is the wrong
one here. `0.2.0` would tag and publish a first release that claims a history the
new name does not have. Nothing warns you; the changelog simply starts in the
middle.

### Consumers need a token even though the repo is public

GitHub Packages requires authentication to _install_, public or not, and the
failure is a bare 401 that reads like the package doesn't exist. The token scope
and `.npmrc` a consumer needs are in
[`README.md`](../../README.md#installing-from-github-packages) — keep that
section in step with any change to `publishConfig.registry` or the scope.
