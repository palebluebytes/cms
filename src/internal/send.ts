/**
 * One authorised request to Google, and the refusal to accept an answer that is
 * not OK.
 *
 * Internal. Not reachable through the package's export map.
 *
 * THE SEAM: a caller says which URL it wants and what it is doing; it gets back
 * a `Response` ALREADY KNOWN TO BE OK. What is left over on the caller's side is
 * reading the body — `.json()` for a listing, `.arrayBuffer()` for a media
 * download — and any refusal only that one endpoint can need, such as Drive
 * answering a media download with a sign-in page.
 *
 * Applying the credential lives here because it is the step no caller may skip:
 * `page-walk.ts` authorises every page rather than only the first, and
 * `fetchBytes` authorises the one request it makes. A third caller gets that,
 * and the non-OK refusal with it, by construction rather than by being copied
 * from one of these two.
 */

// `.js`, not `.ts`, and only because this import is type-only: see the note in
// `require-auth.ts`.
import type { Auth, FetchLike } from "../auth.js";

export interface SendOptions {
	/**
	 * PRECONDITION: already checked. The transport runs `requireAuth` before it
	 * builds a URL, so the message names the function the caller actually typed
	 * rather than this one.
	 */
	auth: Auth;
	/** Defaults to the global. The only place that default lives. */
	fetch?: FetchLike;
	/**
	 * The verb phrase completing "Failed to …" — `read folder`, `download Drive
	 * file abc123`. The caller supplies it because only the caller knows its own
	 * noun; what is shared is the status that follows.
	 */
	what: string;
}

/**
 * The response to one authorised request, already known to be OK.
 *
 * Throws on a non-OK status: a build-time tool has no degraded mode. The thrown
 * error carries a sentence and no code, for the reasons in
 * `docs/adr/0001-errors-carry-messages-not-codes.md`.
 *
 * THE CREDENTIAL IS APPLIED HERE, immediately before the send — so a `fetch`
 * that retries internally resends the credential it was handed rather than
 * minting a fresh one. That ordering is caller-visible, and the README says
 * what to pass instead when a retry needs a new token.
 */
export async function send(
	url: string,
	{ auth, fetch: fetchImpl = globalThis.fetch, what }: SendOptions,
): Promise<Response> {
	const request = await auth(new Request(url));
	const response = await fetchImpl(request);

	if (!response.ok) {
		throw new Error(
			`Failed to ${what}: ${response.status} ${response.statusText}`,
		);
	}

	return response;
}
