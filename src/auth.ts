/**
 * How a Google request gets its credential.
 *
 * THE SEAM: auth is ONE type — a function taking a `Request` and returning an
 * authorised `Request`. Every model reduces to it, including models this package
 * does not ship: a caller with its own credential machinery passes its own
 * function and never touches the constructors below.
 *
 * A `Request` rather than `(url, init)` because it is the one
 * credential-carrying object present in every target runtime — Node 22+, Deno,
 * Bun, Workers — and it holds url and headers together, so an implementation can
 * put the credential in either.
 *
 * This package reads NO environment variables. `process.env` does not exist on
 * every target runtime, and an env var read down inside a dependency is
 * invisible coupling: the caller reads its own environment and passes the value
 * in.
 */
export type Auth = (request: Request) => Request | Promise<Request>;

/**
 * The only part of `fetch` this package uses: it is ALWAYS called with a
 * `Request`, never with a url and an init.
 *
 * Narrower than `typeof fetch` on purpose — the global satisfies this, and so
 * does a two-line test double, which is the whole point of the option.
 */
export type FetchLike = (request: Request) => Promise<Response>;

/**
 * Credential in the query string (`?key=`). The only model Google's public-data
 * endpoints accept without OAuth.
 *
 * Its hazards, which a caller has to know:
 *
 * - An API key can only ever read PUBLIC content.
 * - It cannot check its own access — `permissions.list` rejects API keys
 *   outright ("API keys are not supported by this API").
 * - So a Drive folder that stops being shared answers `200 {"files": []}`
 *   rather than a 403. `fetchPhotos` returns `[]` for that, because an empty
 *   folder is also legal; see the README's error policy.
 */
export function apiKey(key: string): Auth {
	if (!key) {
		// Fail here rather than sending `?key=undefined`, which Google answers
		// with a 400 that says nothing about where the credential should have
		// come from. The type says `string`, but a JS caller reading an unset
		// environment variable gets here anyway — which is exactly the caller
		// this guard is for.
		throw new Error("apiKey(key) needs a non-empty Google API key");
	}

	return (request) => {
		const url = new URL(request.url);
		url.searchParams.set("key", key);
		// `new Request(url, request)` copies method, headers and body across.
		return new Request(url, request);
	};
}

/**
 * A caller-supplied OAuth access token, or a function that mints one. Set as
 * `Authorization: Bearer`, NEVER as a query parameter — query-param access
 * tokens have been rejected on media downloads since 1 January 2020, and
 * Google's own OAuth2 documentation is stale on this point.
 *
 * The factory form is called on every request, so a caller that caches and
 * refreshes its own token needs no cooperation from this package.
 */
export function bearer(
	tokenOrFactory: string | (() => string | Promise<string>),
): Auth {
	if (!tokenOrFactory) {
		throw new Error("bearer(token) needs a token, or a function returning one");
	}

	return async (request) => {
		const token =
			typeof tokenOrFactory === "function"
				? await tokenOrFactory()
				: tokenOrFactory;

		if (!token) {
			throw new Error("bearer(): the token factory returned nothing");
		}

		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${token}`);
		return new Request(request, { headers });
	};
}

// NO `serviceAccount` — deliberately, and now for a surveyed reason.
//
// It is the obvious third constructor, and the reason `auth` is its own entry
// point rather than living inside a provider: if it ever ships with a
// dependency, `/files/*` and `/calendar/*` stay at zero.
//
// What the survey found is that it cannot be the ~40-line local JWT minter it
// looks like. Signing a JWT and sending it straight as the bearer is a Cloud API
// mechanism; Drive and Calendar are scoped APIs, and for those the assertion has
// to be exchanged at `oauth2.googleapis.com/token` for an access token — so a
// built-in means a network call and a token cache in here, in a file that is
// otherwise two pure constructors.
//
// See `docs/adr/0007-a-service-account-needs-a-token-exchange-so-it-stays-the-callers.md`
// for the whole survey, including why the README now names `jose` rather than
// `google-auth-library` (which does not run on Workers at all).
//
// Nothing is blocked in the meantime: the `Auth` type IS the escape hatch. Mint
// a token however you like and pass `bearer(() => myToken())`, or pass your own
// `(request) => request` function. The README has the whole exchange, cache
// included, in about a dozen lines.
