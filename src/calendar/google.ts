/**
 * Reading a Google Calendar: the transport, and the pure normaliser that turns
 * its payload into events a page can print.
 *
 * Nothing here formats, sorts or partitions — all three need a locale or a
 * clock, and both belong to the site. See the README's "What this package does
 * not do".
 *
 * Nothing here assumes the files half is in use, either: a calendar-only
 * consumer never imports `@palebluebytes/google-cms/files/google`.
 */

// `.js` on the type-only import, `.ts` on the value import: see the note in
// `internal/require-auth.ts`.
import type { Auth, FetchLike } from "../auth.js";
import { pages } from "../internal/page-walk.ts";
import { requireAuth } from "../internal/require-auth.ts";
import { inclusiveEnd } from "./shared.ts";
import type { CalendarEvent } from "./shared.js";

// 2500 is the API's ceiling; its DEFAULT is 250, which is the size of the tail a
// growing calendar loses to a single un-paginated request.
const PAGE_SIZE = 2500;

// A backstop, not a budget: `singleEvents` expands an unbounded recurring series
// without limit, so an unterminating walk must fail loudly rather than loop or
// truncate.
const MAX_PAGES = 4;

/**
 * One end of an event, as Google sends it: `date` for an all-day event
 * (`YYYY-MM-DD`, floating), `dateTime` for a timed one (RFC3339 with an offset).
 * Exactly one of the two is present.
 */
export interface EventDateTime {
	date?: string;
	dateTime?: string;
	timeZone?: string;
}

/** A raw `events.list` item, as `listEvents` hands it on. */
export interface EventResource {
	id: string;
	/**
	 * Google's three values, and OPEN — the `(string & {})` arm keeps a fourth
	 * from being a type error while still offering the three by name. Only
	 * `"cancelled"` is interpreted here; anything else is handed over untouched,
	 * so a value Google adds later reaches a consumer rather than a drop.
	 */
	status?: "confirmed" | "tentative" | "cancelled" | (string & {});
	summary?: string;
	description?: string;
	location?: string;
	start?: EventDateTime;
	end?: EventDateTime;
	/** Everything else Google sends and this package does not interpret. */
	[field: string]: unknown;
}

/** The raw `events.list` body. */
export interface EventsPayload {
	timeZone?: string;
	items?: EventResource[];
	/** Present only while the walk is in progress — `listEvents` exhausts it. */
	nextPageToken?: string;
}

/**
 * The resource's own type, re-exported so a consumer of this provider needs one
 * import path rather than two. It is defined in `./shared.ts` because it belongs
 * to the calendar resource and not to Google — a second provider that imported
 * it from here would make this file its dependency.
 */
export type { CalendarEvent, EventKind } from "./shared.js";

export interface CalendarOptions {
	calendarId: string;
	/** Required. */
	auth: Auth;
	/** Defaults to the global. Integration-test seam. */
	fetch?: FetchLike;
	/**
	 * THE WINDOW, and it means one thing for every calendar provider: events
	 * OVERLAPPING it, and an unbounded recurring series expanded within it.
	 *
	 * RFC3339, with an offset — Google rejects a date-only value. Both ends are
	 * omitted by default: a site that renders past appearances would silently
	 * lose half its page to a default window, and defaulting one end would need
	 * a clock.
	 *
	 * Overlapping, not starting-within: Google's `timeMin` bounds an event's END
	 * and `timeMax` bounds its START, so an event already in progress at `from`
	 * is included. A second provider filtering client-side has to reproduce
	 * exactly that — see
	 * `docs/adr/0006-expansion-is-a-guarantee-and-a-window-terminates-it.md`.
	 */
	from?: string;
	/** The other end of the window. See `from`. */
	to?: string;
	/** Backstop on the page walk. Defaults to 4. */
	maxPages?: number;
}

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
 */
export async function listEvents({
	calendarId,
	auth,
	fetch: fetchImpl,
	from,
	to,
	maxPages = MAX_PAGES,
}: CalendarOptions): Promise<{
	timeZone: string | undefined;
	items: EventResource[];
}> {
	requireAuth(auth, "listEvents");

	// One page's URL. The three parameters above are the whole of what makes this
	// a correct calendar listing; the token is the walk's.
	const url = (pageToken: string | undefined) => {
		const params = new URLSearchParams({
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: String(PAGE_SIZE),
		});
		// The window's names are this package's; `timeMin`/`timeMax` are Google's,
		// and this line is the whole of the translation.
		if (from) params.set("timeMin", from);
		if (to) params.set("timeMax", to);
		if (pageToken) params.set("pageToken", pageToken);
		return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
	};

	const items: EventResource[] = [];
	let timeZone: string | undefined;

	for await (const body of pages<EventsPayload>(url, {
		auth,
		fetch: fetchImpl,
		maxPages,
		label: "calendar",
		capHint:
			`Each page is up to ${PAGE_SIZE} events; a recurring event with no end ` +
			`date expands without limit under singleEvents.`,
	})) {
		items.push(...(body.items ?? []));
		// The calendar's own zone arrives on every page; the first one is enough.
		timeZone ??= body.timeZone;
	}

	return { timeZone, items };
}

/**
 * Pure. Raw payload in, `CalendarEvent[]` out — no network, no clock, no
 * environment, no locale.
 *
 * Drops `status === "cancelled"` and events with no usable `start`: that is
 * transport-shaped noise, not a display choice.
 *
 * Does NOT sort and does NOT partition future from past. Both need a clock,
 * which is what would make this function untestable at the point it is most
 * worth testing — and a package that partitioned would have to decide what "now"
 * means for a floating all-day date, which has no answer that is right for every
 * site.
 */
export function normaliseEvents(
	payload: EventsPayload | null | undefined,
): CalendarEvent[] {
	const calendarTimeZone = payload?.timeZone;

	// `flatMap` rather than filter-then-map: dropping an event and reading its
	// start are the same question, and answering it once is what lets `start`
	// below be a string rather than a maybe-string.
	return (payload?.items ?? []).flatMap((event) => {
		const { id, summary, description, location, start, end } = event;

		// All-day events use `date` (YYYY-MM-DD); timed events use `dateTime`, so
		// having a `dateTime` is what "timed" MEANS — read once, and the drop
		// below, the `kind` and the inclusive-end correction all follow from it.
		const timedStart = start?.dateTime;
		const startAt = timedStart || start?.date;

		// Cancelled events, and events carrying no usable start, are
		// transport-shaped noise rather than a display choice.
		if (event.status === "cancelled" || !startAt) return [];

		const rawEnd = end?.dateTime || end?.date || undefined;
		// The start goes in too: an all-day end is usually exclusive, but not every
		// producer agrees, and `inclusiveEnd` needs both to tell the forms apart.
		// Google's own answers are the exclusive kind.
		const endAt =
			!timedStart && rawEnd ? inclusiveEnd(rawEnd, startAt) : rawEnd;

		return [
			{
				id,
				summary,
				description: description ?? "",
				location: location ?? "",
				// Only two of the four kinds are reachable from this API. A
				// `dateTime` from Google always carries an offset, so a timed event
				// is always an instant, and Google has no form that hands back a
				// wall time — a provider reading a file gets the other two.
				kind: timedStart ? "instant" : "date",
				// Compare calendar days only. Both strings carry their own day in
				// their first ten characters — a timed one in the offset Google
				// returned it in — so this needs no zone and no clock.
				isMultiDay:
					endAt !== undefined && startAt.slice(0, 10) !== endAt.slice(0, 10),
				start: startAt,
				end: endAt,
				timeZone: start?.timeZone || calendarTimeZone,
			},
		];
	});
}

/**
 * `listEvents` + `normaliseEvents`, so the whole thing is one expression. An
 * empty calendar is `[]`, not an error.
 */
export async function fetchEvents(
	options: CalendarOptions,
): Promise<CalendarEvent[]> {
	return normaliseEvents(await listEvents(options));
}
