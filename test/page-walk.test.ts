import test from "node:test";
import assert from "node:assert/strict";

import { apiKey } from "../src/auth.ts";
import { pages, type PageWalkOptions } from "../src/internal/page-walk.ts";
import { serve, serveEndless } from "./support/serve.ts";

// The walk itself, once, rather than twice through two transports. Every guard
// here is a way a listing can come back short while looking complete, which is
// the failure this package is built against.

const auth = apiKey("test-key");

// A page's URL. What a real transport puts in the rest of the query — the field
// mask, `q`, `singleEvents` — is its own business and never the walk's.
const url = (pageToken: string | undefined) =>
	`https://example.test/list${pageToken ? `?pageToken=${pageToken}` : ""}`;

const options = (
	overrides: Partial<PageWalkOptions> & Pick<PageWalkOptions, "fetch">,
): PageWalkOptions => ({
	auth,
	maxPages: 10,
	label: "folder",
	capHint: "Each page is up to 1000 files; raise maxPages.",
	...overrides,
});

interface Page {
	n?: number;
	nextPageToken?: string;
}

// Drain the generator the way a transport does.
async function walk(overrides: Parameters<typeof options>[0]): Promise<Page[]> {
	const collected: Page[] = [];
	for await (const body of pages<Page>(url, options(overrides))) {
		collected.push(body);
	}
	return collected;
}

// ------------------------------------------------------------------- the walk

test("yields every page, in order, and stops when the tokens do", async () => {
	const { fetch } = serve([
		{ n: 1, nextPageToken: "token-2" },
		{ n: 2, nextPageToken: "token-3" },
		{ n: 3 },
	]);

	const collected = await walk({ fetch });

	assert.deepEqual(
		collected.map((page) => page.n),
		[1, 2, 3],
	);
});

test("sends back the token it was given, and asks for nothing else", async () => {
	// The walk sets one thing on a request: the page it wants. Everything else on
	// the URL came from the transport.
	const { fetch, requested } = serve([
		{ n: 1, nextPageToken: "token-2" },
		{ n: 2 },
	]);

	await walk({ fetch });

	assert.equal(requested.length, 2);
	assert.equal(requested[0].searchParams.get("pageToken"), null);
	assert.equal(requested[1].searchParams.get("pageToken"), "token-2");
});

test("authorises every page, not just the first", async () => {
	// A credential that reached only page one would read as a listing that ran
	// out early — which is the whole family of bug this module exists for.
	const { fetch, requested } = serve([
		{ n: 1, nextPageToken: "token-2" },
		{ n: 2 },
	]);

	await walk({ fetch });

	assert.deepEqual(
		requested.map((asked) => asked.searchParams.get("key")),
		["test-key", "test-key"],
	);
});

// ------------------------------------------------------------------- failures

test("throws rather than truncating when the API repeats a pageToken", async () => {
	// A token that hands back itself would loop until the cap; stopping quietly
	// would drop the tail.
	const { fetch } = serve([{ n: 1, nextPageToken: "same-token" }]);

	await assert.rejects(() => walk({ fetch }), {
		message: /the folder walk got the same pageToken twice/i,
	});
});

test("the repeated-token message counts pages, since the walk holds no items", async () => {
	// Page two hands back the token that fetched it, so two pages were read
	// before the walk refused — the count is of pages, not of files or events,
	// because the transport is the one accumulating those.
	const { fetch } = serve([
		{ n: 1, nextPageToken: "token-2" },
		{ n: 2, nextPageToken: "token-2" },
	]);

	await assert.rejects(() => walk({ fetch }), /after 2 pages/);
});

test("throws rather than paging forever past the cap", async () => {
	const { fetch, requested } = serveEndless();

	await assert.rejects(
		() => walk({ fetch, maxPages: 3 }),
		/took too many pages \(>3\)/,
	);
	assert.equal(
		requested.length,
		3,
		"the cap counts requests made, not attempted",
	);
});

test("the cap message carries the transport's own explanation", async () => {
	// Why a cap tripped differs per API — a folder that really is huge, or a
	// recurring series with no end date — and the sentence saying so is the
	// transport's to supply.
	const { fetch } = serveEndless();

	await assert.rejects(
		() =>
			walk({
				fetch,
				maxPages: 1,
				label: "calendar",
				capHint:
					"Each page is up to 2500 events; a recurring event with no end date " +
					"expands without limit under singleEvents.",
			}),
		/the calendar walk took too many pages \(>1\)\. Each page is up to 2500 events/i,
	);
});

test("throws on a non-OK response, naming the listing and the status", async () => {
	const { fetch } = serve([{}], { status: 403, statusText: "Forbidden" });

	await assert.rejects(() => walk({ fetch }), {
		message: "Failed to read folder: 403 Forbidden",
	});
});
