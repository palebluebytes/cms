# @palebluebytes/google-cms

Use Google services as a CMS. Read a **Drive folder** or a **Calendar** at build
time, get back data a page can render — no client, no ceremony, no dependencies.

Your client edits a shared Drive folder and their own calendar; your site reads
them when it builds. That is the whole idea.

```bash
pnpm add @palebluebytes/google-cms
```

Runs on **Node 22+, Deno, Bun and edge runtimes** (Workers, Vercel). It uses
`fetch`, `Request` and `Uint8Array` and nothing else — no `node:` imports, no
`Buffer`, no `process.env`.

Written in TypeScript and published as plain ESM with type declarations, so a
JavaScript consumer needs no build step and a TypeScript one needs no
`@types/` package.

## Installing from GitHub Packages

This package is published to GitHub Packages, which requires authentication to
_install_ even though the repo is public. Without it the install fails with a
bare 401 that reads like the package doesn't exist.

Create a token with the `read:packages` scope, then an `.npmrc`:

```
@palebluebytes:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

---

## Entry points

There is no root entry point. An entry point is one **resource** — a folder of
files, a calendar — read through one **provider**, and you import the pairing you
want:

```
@palebluebytes/google-cms/files/google       fetchPhotos · listFiles · normalisePhotos · fetchBytes
@palebluebytes/google-cms/calendar/google    fetchEvents · listEvents · normaliseEvents
@palebluebytes/google-cms/auth               apiKey · bearer
```

The provider is chosen by the import path and by nothing else — there is no
registry and no `{ provider }` option, because a site knows at build time which
backend it reads. Both providers are Google's today; see
[`ADR-0004`](docs/adr/0004-a-resource-may-have-more-than-one-provider.md).

Every operation is reachable in a **single expression**, deliberately: an
Eleventy `_data/*.js` module may export only `default`, and a module that has to
construct a client first cannot be one expression.

```js
import { fetchPhotos } from "@palebluebytes/google-cms/files/google";
import { apiKey } from "@palebluebytes/google-cms/auth";

export default () =>
  fetchPhotos({ folderId: "…", auth: apiKey(process.env.GOOGLE_KEY) });
```

## Auth is one type

```ts
type Auth = (request: Request) => Request | Promise<Request>;
```

A `Request` in, an authorised `Request` out. Everything reduces to it, including
models this package does not ship.

| Constructor              | Credential goes        | Notes                                                                                                                             |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey(key)`            | `?key=` query param    | Public content only. Cannot verify its own access — `permissions.list` rejects API keys outright.                                 |
| `bearer(tokenOrFactory)` | `Authorization` header | A string, or a `() => Promise<string>` called per request. **Never** a query param: rejected on media downloads since 1 Jan 2020. |

**`auth` is required.** Pass nothing and the call throws immediately. The package
reads **no environment variables** — `process.env` does not exist on every target
runtime, and an env var read inside a dependency is invisible coupling. Read your
own environment and pass the value in.

**`auth` runs immediately before each send, outside your `fetch`.** Every request
gets the credential — every page of a walk, not just the first — but the ordering
has one consequence worth knowing: a `fetch` of your own that retries internally
resends the `Request` it was given, credential included. A `bearer` factory is
**not** consulted again for that retry, so a token that expired mid-walk stays
expired. If a retry needs a fresh credential, own the whole exchange instead:

```js
// Everything in `fetch`, so each attempt mints its own token. `auth` still has
// to be a function, and identity is the honest one to pass.
fetchPhotos({
  folderId,
  auth: (request) => request,
  fetch: async (request) => {
    const attempt = async () => fetch(await bearer(mintToken)(request));
    const first = await attempt();
    return first.status === 401 ? attempt() : first;
  },
});
```

### Service accounts

Not shipped, and not needed to use one: the `Auth` type **is** the escape hatch.

```js
// Mint the token however you like — google-auth-library, jose, your own
// WebCrypto RS256, a token from CI — and hand it over.
fetchPhotos({ folderId, auth: bearer(() => mintServiceAccountToken()) });

// Or skip the constructors entirely and authorise the Request yourself.
fetchEvents({ calendarId, auth: (request) => myPreAuthedRewrite(request) });
```

A built-in `serviceAccount({clientEmail, privateKey})` may ship later, from
`/auth` so that every provider entry point stays at zero dependencies whatever it
ends up depending on. It is absent today because the prior art
(`google-auth-library`, `gtoken`, `jose`) has not been surveyed, and the honest
answer may be "use one of those".

---

## `/files/google`

```js
const photos = await fetchPhotos({ folderId, auth });
```

### `Photo`

| Field          | Type                | Always? | Notes                                                         |
| -------------- | ------------------- | ------- | ------------------------------------------------------------- |
| `id`           | string              | ✅      |                                                               |
| `name`         | string              | ✅      | Filename with extension, exactly as Drive has it              |
| `mimeType`     | string              | ✅      | Returned, **never filtered on**                               |
| `modifiedTime` | string              | ✅      | RFC3339; the only cache-busting input you need                |
| `description`  | string              | ✅      | Drive's field, trimmed; `""` when unset                       |
| `caption`      | string              | ✅      | **Never empty**: `description \|\| name`                      |
| `width`        | number \| null      | —       | **Displayed** pixels, axes already swapped                    |
| `height`       | number \| null      | —       | as `width`                                                    |
| `ratio`        | number              | ✅      | Displayed `width / height`; **1** when dimensions are missing |
| `rotation`     | number              | ✅      | Quarter-turns clockwise as Drive reported                     |
| `url`          | string \| undefined | —       | `webContentLink` — read the predicate below                   |

Three of those rows are the reason this package exists.

**`width`/`height`/`ratio` are the DISPLAYED orientation.** Drive's
`imageMediaMetadata` is the _stored_ orientation and `rotation` is quarter-turns
clockwise, so an **odd rotation swaps the axes**. Every other Drive loader gets
this wrong by ignoring rotation, and the symptom is a gallery whose portrait
photos lay out as landscape. `width`/`height` are nullable and `ratio` is not:
the 1:1 fallback is a stated assumption you can lay out against, whereas
fabricated pixel counts would be a lie you could not detect.

Nothing is logged when dimensions are missing — whether that is worth mentioning
during a build is yours to decide, and the returned data already says so:

```js
const undimensioned = photos.filter((p) => p.width === null).map((p) => p.name);
```

**`caption` is never empty**, so you can safely render `alt=""` and let a
figcaption be the text alternative. Refining `name` into something pretty —
stripping a numeric prefix, swapping separators for spaces — is a site
convention and stays yours.

**`url` resolves only for PUBLICLY SHARED files.** Not "when you used an API
key" — that is only accidentally true, because a key can never see anything
else. A service-account consumer reading a private folder gets this field
populated and it answers `200 text/html` with ~900 KB of sign-in page. Use
`fetchBytes` when the folder is not public; `url` is the optimisation that skips
a download.

### Delivery

```js
const bytes = await fetchBytes(photo, { auth }); // Uint8Array
```

The universal primitive: a key goes in the query string, a token in a header, and
that one line is the entire difference between the two auth models. No signed-URL
mechanism exists to replace it (`expirationTime` cannot be set on an `anyone`
permission), and `thumbnailLink` is not a stable src — it changes on every
metadata call.

> **`Uint8Array`, not `Buffer`.** `Buffer` is Node-only. The consequence worth
> stating once, loudly: **eleventy-img tests `Buffer.isBuffer(src)`**
> (`@11ty/eleventy-img/src/image.js:135`), which is **false** for a plain
> `Uint8Array`. A Node consumer passes
> `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)` — a view, not
> a copy.

`fetchBytes` throws on `200 text/html`, which is what an unreadable file answers.
Unguarded, that HTML gets cached as image bytes and fails somewhere far away.

### Options

| Option        | Effect                                                          |
| ------------- | --------------------------------------------------------------- |
| `extraFields` | **Merged** into the field list, never replacing it              |
| `extraQuery`  | **AND-ed** onto the base `q`, never replacing it                |
| `fetch`       | Your own fetch — the integration-test seam, or a pre-authed one |
| `maxPages`    | Backstop on the page walk (default 10 × 1000 files)             |

`fetch` is typed as `FetchLike` — `(request: Request) => Promise<Response>` —
because that is all this package ever calls. The global satisfies it, and so does
a two-line double that records the `Request` it was handed.

Both merges are deliberate inversions of `@localnerve/google-drive-folder`, whose
field list is a hard-coded literal with no passthrough — so build-time aspect
ratios are simply unreachable — and whose `fileQuery` _replaces_ its
`trashed = false` default rather than extending it.

The base query is `'<folderId>' in parents and trashed = false` and nothing else.
Want images only? That is your decision, so it is your clause:

```js
fetchPhotos({ folderId, auth, extraQuery: "mimeType contains 'image/'" });
```

The transport sets `orderBy=name` internally for a deterministic page walk. **The
returned order carries no meaning** — sort it yourself.

---

## `/calendar/google`

```js
const events = await fetchEvents({ calendarId, auth });
```

### `CalendarEvent`

| Field         | Type                | Notes                                                 |
| ------------- | ------------------- | ----------------------------------------------------- |
| `id`          | string              |                                                       |
| `summary`     | string \| undefined | `undefined` for an untitled event — Google omits it   |
| `description` | string              | `""` when unset                                       |
| `location`    | string              | `""` when unset                                       |
| `kind`        | EventKind           | Which time form `start`/`end` hold — read this first  |
| `isMultiDay`  | boolean             | Computed **after** the inclusive-end correction       |
| `start`       | string              | See `kind`                                            |
| `end`         | string \| undefined | **Inclusive** — `undefined` if the source sent no end |
| `timeZone`    | string \| undefined | Event's own, else the calendar's, else **undefined**  |

Events Google sends with no usable `start` — and cancelled ones — are dropped,
so `start` is always a string on an event you get back.

**Strings, not `Date`s, and `kind` says which kind of string.** There are four
time forms in calendar interchange and **only one of them is an instant**:

```
kind: "date"     → "2026-05-13"                 a floating DAY  — no instant
kind: "floating" → "2026-05-13T19:00:00"        a wall TIME     — no zone at all
kind: "zoned"    → "2026-05-13T19:00:00"        a wall time IN `timeZone`
kind: "instant"  → "2026-05-13T19:00:00+01:00"  an instant      — new Date() is safe
```

`new Date()` on any of the first three invents whatever the runtime's zone
happens to be — for a `"date"`, UTC midnight, which renders as a spurious time
or, west of UTC, as the day before.

**Google only ever returns `"date"` and `"instant"`**, because its `dateTime`
always carries an offset. The other two exist for providers reading a file
written by some other client, and they are the reason this is a four-way `kind`
rather than the boolean it used to be —
[ADR-0005](docs/adr/0005-an-events-time-is-a-kind-not-a-boolean.md).

They sort correctly as strings only **within one kind and one offset**. Two
instants written in different offsets sort wrongly as text; Google hides that by
answering in the calendar's zone throughout.

**`end` is the inclusive last day.** An all-day end arrives exclusive from every
calendar system worth reading — Google's `end.date` and RFC 5545's `DTEND` both
name the day _after_ the last, so a 13th-to-16th event arrives ending on the 17th
— and this steps it back, so `end` means the same thing whatever the `kind`.
Remember to use the corrected value in your `schema.org` `endDate` too.

**`timeZone` is `undefined` rather than defaulted.** Your site's fallback zone is
your truth, not this package's. It is also **not guaranteed to be an IANA name** —
it is whatever the source said, and Outlook writes Windows zone names like
`W. Europe Standard Time`. Google's are IANA; validate if you accept calendars
from elsewhere.

### The window: `from` and `to`

```js
const events = await fetchEvents({
  calendarId,
  auth,
  from: "2026-01-01T00:00:00Z",
  to: "2027-01-01T00:00:00Z",
});
```

One meaning, for every calendar provider: **events overlapping the window**, and
an unbounded recurring series **expanded within it**. RFC3339 with an offset —
Google rejects a date-only value.

Overlapping, not starting-within — an event already in progress at `from` is
included. That is Google's own rule (`timeMin` bounds an event's _end_, `timeMax`
bounds its _start_), and it is now the contract's, so a provider that filters
client-side has to reproduce it rather than the obvious `start >= from`.

**Neither end is defaulted.** A site that renders past appearances would silently
lose half its page to a default window, and defaulting one end would need a clock
inside a package that deliberately has none.

### What the transport always sets

`singleEvents=true` (Google defaults it to **false** and returns an unexpanded
master carrying an `RRULE`, which any normaliser renders as a single event on the
series' start date), `orderBy=startTime` (accepted only alongside `singleEvents`),
full pagination, a repeated-`pageToken` guard, and a `maxPages` backstop —
because `singleEvents` expands an unbounded recurring series without limit, so an
unterminating walk must fail loudly rather than loop or truncate.

Expansion is the one to understand rather than memorise: **a consumer never
receiving an unexpanded series is this package's guarantee**, and `singleEvents`
is merely how Google satisfies it for free —
[ADR-0006](docs/adr/0006-expansion-is-a-guarantee-and-a-window-terminates-it.md).

---

## What this package does not do

**No sorting, no filtering, no formatting, no future/past partition.** Not an
oversight — a partition needs a clock, and a package that partitions must decide
what "now" means for a _floating_ all-day date. There is no answer that is right
for every site. Keeping the clock out is also what makes the normalisers testable
at the exact point they are most worth testing.

## Transport, normaliser, composition

Each half is three functions:

```js
listFiles(options)   → Promise<rawPayload>    network, no interpretation
normalisePhotos(raw) → Photo[]                pure: no network, no clock, no env
fetchPhotos(options) → Promise<Photo[]>       the two together
```

The middle one is why your tests need no fixtures library and no faked
`Response`. Save a real `files.list` body to a JSON file, and:

```js
const photos = process.env.FIXTURE_DATA
  ? normalisePhotos(JSON.parse(await readFile(fixturePath, "utf8")))
  : await fetchPhotos({ folderId, auth });
```

Every line of interpretation still runs — ratios, the rotation swap, the caption
fallback. Use the `fetch` option for integration tests that want the transport;
unit tests should not need it.

## Error policy

**Throw on anything unambiguously wrong; never throw on an ambiguous-but-legal
result.** A build-time tool has no sensible degraded mode: a green build carrying
silently wrong data is the failure mode worth designing against.

Throws on `!res.ok`, a repeated `pageToken`, `maxPages` exceeded, missing `auth`,
and a payload that contradicts what was asked for (media that answers `text/html`).

Does **not** throw on an empty folder or an empty calendar — `fetchPhotos`
returns `[]`.

> **The hazard behind that last line.** Drive answers a listing against a folder
> your key can no longer read with `200 {"files": []}`, so a sharing change reads
> as a successful request that found nothing. "Empty" is legal for most callers,
> and only you know whether your folder can be. If it cannot, that is three lines
> in your own code:
>
> ```js
> const photos = await fetchPhotos({ folderId, auth });
> if (!photos.length)
>   throw new Error("Drive listing came back empty — check sharing");
> ```

## Testing

```bash
pnpm test        # node --test over the .ts sources; no install, no network, no key
pnpm install     # prettier, typescript, @types/node — dev only, nothing ships
pnpm typecheck   # tsc; type stripping runs the tests, it does not check them
pnpm build       # tsc → dist/, which is what publishing ships
```

Node runs the TypeScript directly by stripping the types, so the test command
needs nothing installed — but it also never typechecks, which is why `typecheck`
is its own step here and its own job in CI.

## Licence

MIT © Pale Blue Bytes
