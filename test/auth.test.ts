import test from "node:test";
import assert from "node:assert/strict";

import { apiKey, bearer } from "../src/auth.ts";

// One type: an `Auth` is a function from Request to Request. Everything else in
// this file is a consequence of that.

test("the key rides in the query string", async () => {
	const authed = await apiKey("secret")(
		new Request("https://www.googleapis.com/drive/v3/files?q=whatever"),
	);

	const url = new URL(authed.url);
	assert.equal(url.searchParams.get("key"), "secret");
	assert.equal(url.searchParams.get("q"), "whatever", "the rest survives");
});

test("the request's method and headers survive authorisation", async () => {
	const authed = await apiKey("secret")(
		new Request("https://www.googleapis.com/drive/v3/files", {
			headers: { accept: "application/json" },
		}),
	);

	assert.equal(authed.method, "GET");
	assert.equal(authed.headers.get("accept"), "application/json");
});

test("a missing key throws at construction, not on the first request", async () => {
	// The alternative is `?key=undefined`, which Google answers with a 400 that
	// says nothing about where the credential should have come from. The types
	// say `string`; the caller this guard is for read an unset env var in JS.
	// @ts-expect-error — deliberately calling it the way a JS caller can
	assert.throws(() => apiKey(undefined), /key/i);
	assert.throws(() => apiKey(""), /key/i);
});

test("the same Auth authorises repeated requests", async () => {
	const auth = apiKey("secret");
	const one = await auth(new Request("https://example.test/a"));
	const two = await auth(new Request("https://example.test/b"));

	assert.equal(new URL(one.url).searchParams.get("key"), "secret");
	assert.equal(new URL(two.url).searchParams.get("key"), "secret");
});

// --------------------------------------------------------------------- bearer

test("a token rides in the Authorization header, never the query string", async () => {
	// Query-parameter access tokens have been rejected on media downloads since
	// 1 January 2020, whatever Google's OAuth2 page still says.
	const authed = await bearer("ya29.token")(
		new Request("https://www.googleapis.com/drive/v3/files?q=whatever"),
	);

	assert.equal(authed.headers.get("Authorization"), "Bearer ya29.token");
	const url = new URL(authed.url);
	assert.equal(url.searchParams.get("access_token"), null);
	assert.equal(url.searchParams.get("q"), "whatever", "the url is untouched");
});

test("a factory is called per request, so a caller can refresh its own token", async () => {
	let n = 0;
	const auth = bearer(() => `token-${++n}`);

	const one = await auth(new Request("https://example.test/a"));
	const two = await auth(new Request("https://example.test/b"));

	assert.equal(one.headers.get("Authorization"), "Bearer token-1");
	assert.equal(two.headers.get("Authorization"), "Bearer token-2");
});

test("an async factory is awaited", async () => {
	const authed = await bearer(async () => "minted")(
		new Request("https://example.test/a"),
	);

	assert.equal(authed.headers.get("Authorization"), "Bearer minted");
});

test("other headers survive, and a stale Authorization is replaced", async () => {
	const authed = await bearer("fresh")(
		new Request("https://example.test/a", {
			headers: { accept: "application/json", Authorization: "Bearer stale" },
		}),
	);

	assert.equal(authed.headers.get("accept"), "application/json");
	assert.equal(authed.headers.get("Authorization"), "Bearer fresh");
});

test("nothing to mint with throws — at construction, or when the factory returns nothing", async () => {
	// @ts-expect-error — as above: the guard is for the caller the types miss
	assert.throws(() => bearer(undefined), /token/i);
	assert.throws(() => bearer(""), /token/i);
	await assert.rejects(
		// @ts-expect-error — a factory that mints nothing is a JS-shaped mistake
		() => bearer(() => undefined)(new Request("https://example.test/a")),
		/returned nothing/i,
	);
});
