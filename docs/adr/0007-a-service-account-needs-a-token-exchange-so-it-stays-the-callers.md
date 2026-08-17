# A service account needs a token exchange, so it stays the caller's

`/auth` is its own entry point so that a `serviceAccount({clientEmail, privateKey})`
could ship with a dependency without `/files/*` or `/calendar/*` gaining one. The
README said it was absent because the prior art had not been surveyed. This is
that survey, and it changed what the README should say as much as what the code
should do.

## The prior art does not run where this package claims to

The three libraries the README named as alternatives are not alternatives to each
other:

| Package                      | Dependencies                                                                                | Declared engines                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `google-auth-library@11.0.2` | `jws`, `gaxios`, `base64-js`, `gcp-metadata`, `ecdsa-sig-formatter`, `google-logging-utils` | `node >=22`                                                                                          |
| `gtoken@8.0.0`               | `jws`, `gaxios`                                                                             | `node >=18`                                                                                          |
| `jose@6.2.9`                 | **none**                                                                                    | unspecified — "Node.js, Browser, Cloudflare Workers, Deno, Bun and other Web-interoperable runtimes" |

The first two sign with `jws`, which needs `crypto.createSign`. Workers' Node
compatibility layer does not implement it, so **the official Google library does
not run on a target this package advertises on its first screen.** Recommending
it to an edge consumer was worse than saying nothing: it names the obvious thing
and lets them find out at deploy time.

`jose` is the one that fits, and it fits exactly: zero dependencies, WebCrypto
underneath, `jwt/sign` and `key/import` as subpath exports.

## The version with no network is not available to us

The appealing shape would be a **self-signed JWT** used directly as the bearer:
sign locally, attach, no token endpoint, no cache, nothing stateful. Google
documents it, and `AIP-4111` specifies it.

It does not cover this case. That mechanism is a Cloud API one; the `scope` claim
in a self-signed JWT is gated behind an opt-in (`UseJWTAccessWithScope`), is "not
supported for all Cloud API service backends", and Google's own libraries default
it off and fall back to the OAuth exchange whenever a scope is present. Drive and
Calendar are scoped user-data APIs, so the fallback is the path, not the
exception.

So a built-in would have to POST an assertion to `https://oauth2.googleapis.com/token`
with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, read an
`access_token` and an `expires_in`, and cache them. That is a **network call and
mutable state inside `/auth`** — in a package whose every other unit is a pure
function or a single expression.

## Decision

Not shipped, and now for a reason rather than for want of looking. `bearer(() => …)`
remains the answer, and the README names `jose` specifically instead of listing
three libraries as if they were interchangeable.

The clinching argument is how small the escape hatch turns out to be: the whole
exchange, including the cache, is about a dozen readable lines in the consumer's
own code — where the caller can see the credential's lifetime and own it. This
package would be taking on a token cache to save that.

Two things also settled while surveying, both worth stating because they make the
use case work at all:

- **Domain-wide delegation is not needed.** A service account reads a Drive folder
  or a calendar that has been **shared with its own email address**, which is
  precisely the "your client shares a folder with you" story this package is for.
- The `sub` claim is only for impersonating a user, so the worked example does not
  set one.

## Consequences

`src/auth.ts` keeps its "no `serviceAccount` yet" note, pointing here rather than
at an unfinished survey.

Worth reopening when **both** of these are true: a real service account exists to
verify against — every other claim in this repo has been checked against reality,
and a credential path shipped unverified would be the first that was not — and a
second consumer wants it, so the interface is not designed for an imagined one
(the same rule as
[`ADR-0004`](0004-a-resource-may-have-more-than-one-provider.md)).

The shape it would take, so the next person does not re-derive it:
`serviceAccount({clientEmail, privateKey, scope})` returning an `Auth`, with the
token cached **per returned function** rather than in a module-level variable —
two calls with different keys in one build must not share a token, and a
module-global cache is how they would.
