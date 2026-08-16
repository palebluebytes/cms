/**
 * Reading a Google Calendar: the transport, and the pure normaliser that turns
 * its payload into events a page can print.
 *
 * Nothing here formats, sorts or partitions — all three need a locale or a
 * clock, and both belong to the site. See the README's "What this package does
 * not do".
 *
 * Nothing here assumes the Drive half is in use, either: a calendar-only
 * consumer never imports `@palebluebytes/google-cms/drive`.
 */

import { requireAuth } from "./internal/require-auth.js";

// 2500 is the API's ceiling; its DEFAULT is 250, which is the size of the tail a
// growing calendar loses to a single un-paginated request.
const PAGE_SIZE = 2500;

// A backstop, not a budget: `singleEvents` expands an unbounded recurring series
// without limit, so an unterminating walk must fail loudly rather than loop or
// truncate.
const MAX_PAGES = 4;

/**
 * An event, as this package hands it over.
 *
 * DATES ARE STRINGS, NOT `Date`s. An all-day event is a FLOATING date — it has
 * no instant, and `new Date("2026-05-13")` invents one at UTC midnight.
 * `isAllDay` tells a consumer which form it is holding:
 *
 *   isAllDay true  → `YYYY-MM-DD`      (floating; do NOT construct a Date)
 *   isAllDay false → RFC3339 + offset  (an instant; `new Date()` is safe)
 *
 * They also sort correctly as strings, which is the one thing every consumer
 * does with them.
 *
 * @typedef {object} CalendarEvent
 * @property {string} id
 * @property {string} summary
 * @property {string} description `""` when unset.
 * @property {string} location `""` when unset.
 * @property {boolean} isAllDay
 * @property {boolean} isMultiDay True when the span covers more than one
 *   calendar day, computed AFTER the inclusive-end correction.
 * @property {string} start
 * @property {string|undefined} end INCLUSIVE. Google's all-day `end.date` is
 *   EXCLUSIVE — a 13th-to-16th event arrives ending on the 17th — and this is
 *   stepped back, so `end` means the same thing whether or not the event is
 *   all-day. `undefined` only if Google sent no end at all.
 * @property {string|undefined} timeZone The event's own zone, else the
 *   calendar's, else `undefined`. NEVER a default: a fallback zone is the
 *   consumer's truth, not this package's.
 */

/**
 * @typedef {object} CalendarOptions
 * @property {string} calendarId
 * @property {import("./auth.js").Auth} auth Required.
 * @property {typeof fetch} [fetch] Defaults to the global. Integration-test seam.
 * @property {string} [timeMin] RFC3339. Omitted by default: a site that renders
 *   past appearances would silently lose half its page to a default window.
 * @property {string} [timeMax] RFC3339.
 * @property {number} [maxPages=4] Backstop on the page walk.
 */

/**
 * The raw `events.list` payload — `{timeZone, items}` — paginated to exhaustion.
 *
 * Three parameters carry the correctness here, and all three are things Google
 * gets wrong by default:
 *
 * - `singleEvents=true` expands a recurring series into its instances. The
 *   default is FALSE, which hands back the unexpanded master carrying its
 *   `RRULE` — and a normaliser has no idea what an RRULE is, so a weekly series
 *   comes out as a single event on the series' start date.
 * - `orderBy=startTime` makes the page walk deterministic. The API accepts it
 *   only alongside `singleEvents=true`. It is transport correctness, not display
 *   order: consumers sort.
 * - `maxResults` + `nextPageToken`: the default page is 250 events, and a single
 *   un-paginated request drops everything past it, silently.
 *
 * @param {CalendarOptions} options
 * @returns {Promise<{timeZone?: string, items: object[]}>}
 */
export async function listEvents({
	calendarId,
	auth,
	fetch: fetchImpl = globalThis.fetch,
	timeMin,
	timeMax,
	maxPages = MAX_PAGES,
}) {
	requireAuth(auth, "listEvents");

	const items = [];
	let timeZone;
	let pageToken;

	for (let page = 1; ; page++) {
		if (page > maxPages) {
			throw new Error(
				`Calendar walk took too many pages (>${maxPages} x ${PAGE_SIZE} ` +
					`events). A recurring event with no end date expands without limit ` +
					`under singleEvents.`,
			);
		}

		const params = new URLSearchParams({
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: String(PAGE_SIZE),
		});
		if (timeMin) params.set("timeMin", timeMin);
		if (timeMax) params.set("timeMax", timeMax);
		if (pageToken) params.set("pageToken", pageToken);

		const request = await auth(
			new Request(
				`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
			),
		);
		const response = await fetchImpl(request);

		if (!response.ok) {
			throw new Error(
				`Failed to fetch calendar events: ${response.status} ${response.statusText}`,
			);
		}

		const body = await response.json();
		items.push(...(body.items ?? []));
		timeZone ??= body.timeZone;

		if (!body.nextPageToken) break;
		if (body.nextPageToken === pageToken) {
			throw new Error(
				`Calendar returned the same pageToken twice — refusing to loop or to ` +
					`truncate at ${items.length} events.`,
			);
		}
		pageToken = body.nextPageToken;
	}

	return { timeZone, items };
}

/**
 * Google's all-day `end.date` is EXCLUSIVE, so step it back a day and hand over
 * the last day the event actually covers.
 *
 * Done in UTC on a date-only string, which has no instant of its own: the Date
 * is arithmetic scaffolding here and never escapes.
 */
function inclusiveEnd(end) {
	const date = new Date(`${end}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() - 1);
	return date.toISOString().slice(0, 10);
}

/**
 * Pure. Raw payload in, `CalendarEvent[]` out — no network, no clock, no
 * environment, no locale.
 *
 * Drops `status === "cancelled"` and events with no `start`: that is
 * transport-shaped noise, not a display choice.
 *
 * Does NOT sort and does NOT partition future from past. Both need a clock,
 * which is what would make this function untestable at the point it is most
 * worth testing — and a package that partitioned would have to decide what "now"
 * means for a floating all-day date, which has no answer that is right for every
 * site.
 *
 * @param {{timeZone?: string, items?: object[]}} payload
 * @returns {CalendarEvent[]}
 */
export function normaliseEvents(payload) {
	const calendarTimeZone = payload?.timeZone;

	return (payload?.items ?? [])
		.filter((event) => event.status !== "cancelled" && event.start)
		.map((event) => {
			const { id, summary, description, location, start, end } = event;

			// All-day events use `date` (YYYY-MM-DD); timed events use `dateTime`.
			const isAllDay = !start.dateTime;
			const startAt = start.dateTime || start.date;
			const rawEnd = end?.dateTime || end?.date || undefined;
			const endAt = isAllDay && rawEnd ? inclusiveEnd(rawEnd) : rawEnd;

			return {
				id,
				summary,
				description: description ?? "",
				location: location ?? "",
				isAllDay,
				// Compare calendar days only. Both strings carry their own day in
				// their first ten characters — a timed one in the offset Google
				// returned it in — so this needs no zone and no clock.
				isMultiDay:
					Boolean(endAt) && startAt.slice(0, 10) !== endAt.slice(0, 10),
				start: startAt,
				end: endAt,
				timeZone: start.timeZone || calendarTimeZone,
			};
		});
}

/**
 * `listEvents` + `normaliseEvents`, so the whole thing is one expression. An
 * empty calendar is `[]`, not an error.
 *
 * @param {CalendarOptions} options
 * @returns {Promise<CalendarEvent[]>}
 */
export async function fetchEvents(options) {
	return normaliseEvents(await listEvents(options));
}
