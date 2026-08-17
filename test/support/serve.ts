/**
 * A `fetch` double, made of real `Response`s.
 *
 * `ok` derived from a status, real `Headers`, a real `json()`, a real
 * `arrayBuffer()` — a literal carrying `ok`/`json` gets to agree with whatever
 * the code happens to read, which is the one thing a transport test must not
 * do. See `docs/agents/testing.md`.
 *
 * Every test file uses these. A double written beside a test is a copy of this
 * contract that nothing keeps honest.
 */

import type { FetchLike } from "../../src/auth.ts";

export interface Served {
	fetch: FetchLike;
	/** Every URL asked for, in order — recorded AFTER `auth` was applied. */
	requested: URL[];
}

export interface ServeOptions {
	status?: number;
	statusText?: string;
}

/**
 * Answer with each page in turn, repeating the last one for every request after
 * them — so a single page carrying a `nextPageToken` is a listing that hands
 * back itself.
 */
export function serve(
	pages: unknown[],
	{ status = 200, statusText = "OK" }: ServeOptions = {},
): Served {
	const requested: URL[] = [];
	let call = 0;

	const fetch: FetchLike = async (request) => {
		requested.push(new URL(request.url));
		const page = pages[Math.min(call++, pages.length - 1)];
		return new Response(JSON.stringify(page), {
			status,
			statusText,
			headers: { "content-type": "application/json" },
		});
	};

	return { fetch, requested };
}

export interface ServeBytesOptions extends ServeOptions {
	/** Defaults to `image/jpeg`. The header `fetchBytes` reads. */
	type?: string;
}

/**
 * Answer with a body that is not JSON — a media download, or the sign-in page
 * Drive sends instead of one.
 */
export function serveBytes(
	body: string,
	{
		status = 200,
		statusText = "OK",
		type = "image/jpeg",
	}: ServeBytesOptions = {},
): Served {
	const requested: URL[] = [];

	const fetch: FetchLike = async (request) => {
		requested.push(new URL(request.url));
		return new Response(body, {
			status,
			statusText,
			headers: { "content-type": type },
		});
	};

	return { fetch, requested };
}

/**
 * Answer every request with a page carrying a FRESH token, forever. A walk
 * against this one can only end at its cap — which is the point: an unbounded
 * recurring series expands exactly like this.
 */
export function serveEndless(): Served {
	const requested: URL[] = [];
	let call = 0;

	const fetch: FetchLike = async (request) => {
		requested.push(new URL(request.url));
		return Response.json({ nextPageToken: `token-${++call}` });
	};

	return { fetch, requested };
}
