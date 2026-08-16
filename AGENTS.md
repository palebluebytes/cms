# AGENTS.md

Constraints for this package. Everything here shares one property: **break it and
nothing errors** — the tests pass, a consumer's build goes green, and the data is
wrong.

Usage and rationale live in [`README.md`](README.md) and in comments beside the
code; this file is only the traps.

## The audience is any JS runtime, not Node

No `node:` imports, no `Buffer`, no `process.env`, no dependencies in `/drive` or
`/calendar`. `fetch`, `Request`, `Headers`, `URL`, `Uint8Array` and WebCrypto are
the whole toolbox — all of them native on Node 18+, Deno, Bun and Workers.

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
