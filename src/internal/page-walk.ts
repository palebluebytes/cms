/**
 * The page walk: ask Google for a page, follow `nextPageToken`, stop when it
 * stops — or fail loudly rather than truncate.
 *
 * Internal. Not reachable through the package's export map.
 *
 * THE SEAM: a transport says what one page's URL is, given a page token, and
 * gets every page body back in order. What is left over on the transport's side
 * is exactly what differs between two Google listings — the field mask, the
 * query, the parameters Google gets wrong by default — and everything that is
 * the same, including both ways a walk can silently hand back a short answer,
 * is behind this interface.
 *
 * The walk knows one field name, `nextPageToken`, because that is what drives
 * the loop. It knows nothing else about Drive or Calendar.
 */

// `.js`, not `.ts`, and only because this import is type-only: see the note in
// `require-auth.ts`.
import type { Auth, FetchLike } from "../auth.js";

/**
 * Which listing is being walked. Interpolated into every message this module
 * can throw, so it reads as a noun in a sentence: "the folder walk", "the
 * calendar walk".
 */
export type PageWalkLabel = "folder" | "calendar";

export interface PageWalkOptions {
	/**
	 * PRECONDITION: already checked. The transport runs `requireAuth` before it
	 * builds a URL, so the message names the function the caller actually typed
	 * rather than this one.
	 */
	auth: Auth;
	/** Defaults to the global. */
	fetch?: FetchLike;
	/**
	 * Checked BEFORE each request, so `maxPages` is a count of requests made and
	 * not of requests attempted: `maxPages: 3` fetches three times and then
	 * throws.
	 */
	maxPages: number;
	label: PageWalkLabel;
	/**
	 * The sentence appended to the too-many-pages message, saying why the cap
	 * might have tripped. It carries the page size too — that lives in the
	 * transport's own parameters, not here.
	 */
	capHint: string;
}

/**
 * Every page of a listing, in order, as raw bodies.
 *
 * Yields rather than accumulating because the two transports harvest different
 * things from a page — `files`, versus `items` plus the calendar's `timeZone`
 * off the first one — and that difference is theirs to keep.
 *
 * Throws on a non-OK response, on a `pageToken` the API hands back to itself,
 * and on exceeding `maxPages`. All three are the same policy: a build-time tool
 * has no degraded mode, and a short answer that reads as a complete one is the
 * failure worth designing against.
 *
 * @param url One page's URL, given the token for that page (`undefined` for the
 * first). The walk sets nothing else on it.
 */
export async function* pages<Body extends { nextPageToken?: string }>(
	url: (pageToken: string | undefined) => string,
	{
		auth,
		fetch: fetchImpl = globalThis.fetch,
		maxPages,
		label,
		capHint,
	}: PageWalkOptions,
): AsyncGenerator<Body> {
	let pageToken: string | undefined;

	for (let page = 1; ; page++) {
		if (page > maxPages) {
			throw new Error(
				`The ${label} walk took too many pages (>${maxPages}). ${capHint}`,
			);
		}

		const request = await auth(new Request(url(pageToken)));
		const response = await fetchImpl(request);

		if (!response.ok) {
			throw new Error(
				`Failed to read ${label}: ${response.status} ${response.statusText}`,
			);
		}

		const body = (await response.json()) as Body;
		yield body;

		if (!body.nextPageToken) return;

		// A token that hands back itself would loop until the cap; stopping here
		// quietly would drop the tail. Both are worse than saying so.
		if (body.nextPageToken === pageToken) {
			throw new Error(
				`The ${label} walk got the same pageToken twice — refusing to loop ` +
					`or to truncate after ${page} pages.`,
			);
		}

		pageToken = body.nextPageToken;
	}
}
