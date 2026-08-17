/**
 * Reading a calendar from an `.ics` URL: the transport, and the pure normaliser
 * that turns the file into the same events the Google provider produces.
 *
 * The second implementation of the calendar resource, and the reason the first
 * one's shape can be trusted — see
 * `docs/adr/0004-a-resource-may-have-more-than-one-provider.md`. Every calendar
 * system exports this format, so this is also the only way to read a calendar
 * with no OAuth and no Google account at all: paste the secret address.
 *
 * WHAT THIS PROVIDER HAS TO DO THAT GOOGLE'S DOES NOT: expand recurrence. There
 * is no server to ask, so `internal/recurrence.ts` does it, and an unbounded
 * series therefore needs a `to` — the one place where the window stops being
 * optional.
 *
 * Nothing here formats, sorts or partitions, exactly as on the Google side.
 */

import { send } from "../internal/send.ts";
import type { Auth, FetchLike } from "../auth.js";
import {
	dayOf,
	icsTime,
	parseDuration,
	parseIcs,
	properties,
	property,
	textValue,
	timeKey,
	type IcsProperty,
	type IcsTime,
} from "./internal/ics-parse.ts";
import { expand } from "./internal/recurrence.ts";
import { addDays, inclusiveEnd } from "./shared.ts";
import type { CalendarEvent } from "./shared.js";

/**
 * The resource's own type, re-exported so a consumer of this provider needs one
 * import path rather than two. Defined in `./shared.ts`, which is what makes it
 * the resource's and not this file's.
 */
export type { CalendarEvent, EventKind } from "./shared.js";

/** The window, as the normaliser needs it. */
export interface Window {
	/**
	 * RFC3339, or a bare `YYYY-MM-DD`. Events OVERLAPPING the window are kept —
	 * see `normaliseEvents`.
	 */
	from?: string;
	to?: string;
}

export interface IcsOptions extends Window {
	/**
	 * The `.ics` URL. For a private calendar this is the secret address, which
	 * IS the credential — hence no required `auth`.
	 */
	url: string;
	/**
	 * OPTIONAL here, unlike the Google provider, and deliberately: a secret
	 * `.ics` address carries its own credential, so there is nothing to attach
	 * and a `none()` sentinel would teach a caller nothing the URL has not
	 * already told them. Pass one anyway for an export behind Basic auth, such
	 * as a private Nextcloud calendar. See ADR-0004.
	 */
	auth?: Auth;
	/** Defaults to the global. Integration-test seam. */
	fetch?: FetchLike;
}

/**
 * The file, as text. Network, no interpretation.
 *
 * No page walk: a calendar file is one document, so there is nothing to
 * paginate and `internal/page-walk.ts` is not involved. `send` is, because
 * refusing a non-OK answer is not this provider's decision to re-make.
 *
 * REFUSES A `200 text/html`, which is what a private calendar answers when the
 * credential is missing or stale: a sign-in page, served cheerfully. Parsing it
 * would find no `VEVENT` and hand back `[]` — a calendar that reads as empty
 * rather than as unreadable, which is the exact failure this package exists to
 * refuse. The same trap as `fetchBytes` on the Drive side.
 */
export async function listEvents({
	url,
	auth,
	fetch: fetchImpl,
}: Pick<IcsOptions, "url" | "auth" | "fetch">): Promise<string> {
	// `send` applies a credential unconditionally, so a provider that does not
	// need one passes the identity. It is the honest spelling of "nothing to
	// attach", and it keeps the non-OK refusal in one place.
	const response = await send(url, {
		auth: auth ?? ((request) => request),
		fetch: fetchImpl,
		what: "read the calendar",
	});

	const type = response.headers?.get?.("content-type") ?? "";
	if (type.startsWith("text/html")) {
		throw new Error(
			`${url} answered 200 text/html — that is a sign-in page, not a ` +
				`calendar. A file with no VEVENT in it would read as an empty ` +
				`calendar rather than as an unreadable one.`,
		);
	}

	return response.text();
}

/** `SUMMARY:` with nothing after it is untitled, the same as no SUMMARY at all. */
function summaryOf(event: readonly IcsProperty[]): string | undefined {
	const summary = textValue(property(event, "SUMMARY"));
	return summary || undefined;
}

/** `DTEND`, or `DTSTART` plus `DURATION`, or nothing. */
function endOf(
	event: readonly IcsProperty[],
	start: IcsTime,
): IcsTime | undefined {
	const dtend = property(event, "DTEND");
	if (dtend) return icsTime(dtend);

	const duration = property(event, "DURATION");
	if (!duration) return undefined;

	// DURATION instead of DTEND is legal and common in Apple's exports. Days and
	// seconds are applied differently on purpose: days are calendar arithmetic,
	// and the seconds only ever move the time of day, which is why a zoned event
	// keeps its wall clock rather than drifting by an hour across a DST change.
	const { days, seconds } = parseDuration(duration.value);
	const day = addDays(dayOf(start), days);

	if (start.kind === "date") {
		if (seconds !== 0) {
			throw new Error(
				`An all-day event cannot have a DURATION carrying a time ` +
					`("${duration.value}"): it would end at an hour the event has no ` +
					`hours in.`,
			);
		}
		return { kind: "date", value: day, timeZone: undefined };
	}

	const [hh, mm, ss] = start.value.slice(11, 19).split(":").map(Number);
	const total = hh! * 3600 + mm! * 60 + ss! + seconds;
	const carried = Math.floor(total / 86400);
	const within = ((total % 86400) + 86400) % 86400;
	const pad = (n: number) => String(n).padStart(2, "0");
	const utc = start.value.endsWith("Z") ? "Z" : "";

	return {
		kind: start.kind,
		value:
			`${addDays(day, carried)}T` +
			`${pad(Math.floor(within / 3600))}:${pad(Math.floor((within % 3600) / 60))}:` +
			`${pad(within % 60)}${utc}`,
		timeZone: start.timeZone,
	};
}

/**
 * A comparable key for one side of a window test.
 *
 * A `"date"` is compared DAY-WISE — its first ten characters against the
 * boundary's — because comparing a floating day to an instant needs a zone this
 * package will not invent. Everything else is compared as a wall time in UTC,
 * which is exact for an `"instant"` and an approximation for the two forms that
 * have no offset. That is the divergence
 * `docs/adr/0006-expansion-is-a-guarantee-and-a-window-terminates-it.md`
 * documents rather than fixes: Google compares server-side in the calendar's
 * zone, so the two can disagree by a day on an event straddling the very edge.
 */
function windowKey(kind: CalendarEvent["kind"], value: string): string {
	if (kind === "date") return value.slice(0, 10);
	if (kind === "instant") return new Date(value).toISOString().slice(0, 19);
	return value.slice(0, 19);
}

/** The boundary in the same shape as the event it is compared against. */
function boundaryKey(kind: CalendarEvent["kind"], boundary: string): string {
	if (kind === "date") return boundary.slice(0, 10);
	const parsed = new Date(
		boundary.length === 10 ? `${boundary}T00:00:00Z` : boundary,
	);
	return parsed.toISOString().slice(0, 19);
}

/**
 * Events OVERLAPPING the window, which is Google's rule and therefore the
 * contract's: `timeMin` bounds an event's END and `timeMax` bounds its START.
 * The obvious `start >= from` would drop an event already in progress.
 *
 * A `"date"` event covers its whole last day, so a window opening on that day
 * does overlap it — the comparison is inclusive at day granularity.
 */
function overlaps(event: CalendarEvent, { from, to }: Window): boolean {
	const startKey = windowKey(event.kind, event.start);
	const endKey = event.end ? windowKey(event.kind, event.end) : startKey;

	if (from !== undefined) {
		const fromKey = boundaryKey(event.kind, from);
		if (event.kind === "date" ? endKey < fromKey : endKey <= fromKey) {
			return false;
		}
	}

	if (to !== undefined) {
		const toKey = boundaryKey(event.kind, to);
		if (event.kind === "date" ? startKey > toKey : startKey >= toKey) {
			return false;
		}
	}

	return true;
}

/**
 * Pure. `.ics` text in, `CalendarEvent[]` out — no network, no clock, no
 * environment, no locale.
 *
 * This is the seam to feed a checked-in file through, exactly as
 * `normaliseEvents` on the Google side takes a checked-in payload.
 *
 * The window is a SECOND ARGUMENT rather than part of the text, because a file
 * cannot be asked for a subset the way an API can: filtering and expansion both
 * happen here. Providers agree on what they RETURN, not on what they take —
 * ADR-0004.
 *
 * Drops cancelled events and events with no `DTSTART`, the same
 * transport-shaped noise the Google provider drops.
 *
 * THROWS on an unbounded recurring series with no `to`, and on an `RRULE` the
 * expander does not implement. Both refusals are `internal/recurrence.ts`'s and
 * are the point of it: half a series missing looks exactly like a calendar with
 * fewer events in it.
 */
export function normaliseEvents(
	text: string,
	window: Window = {},
): CalendarEvent[] {
	const document = parseIcs(text);
	const calendarTimeZone =
		textValue(property(document.calendar, "X-WR-TIMEZONE")) || undefined;

	// An override is a VEVENT carrying RECURRENCE-ID: it replaces ONE instance of
	// the series with the same UID. Collected first, because a file may state the
	// override before the series it belongs to.
	const overrides = new Map<string, IcsProperty[]>();
	for (const event of document.events) {
		const recurrenceId = property(event, "RECURRENCE-ID");
		if (!recurrenceId) continue;
		const uid = textValue(property(event, "UID"));
		overrides.set(`${uid}@${timeKey(icsTime(recurrenceId))}`, event);
	}

	const events: CalendarEvent[] = [];

	for (const source of document.events) {
		if (property(source, "RECURRENCE-ID")) continue; // handled as an override

		const dtstart = property(source, "DTSTART");
		if (!dtstart) continue;
		if (textValue(property(source, "STATUS")).toUpperCase() === "CANCELLED") {
			continue;
		}

		const uid = textValue(property(source, "UID"));
		const start = icsTime(dtstart);
		const rawEnd = endOf(source, start);

		// The same correction the Google provider applies, from the same module:
		// an all-day end is exclusive in RFC 5545 exactly as it is in Google's
		// `end.date`.
		const end =
			rawEnd && rawEnd.kind === "date"
				? { ...rawEnd, value: inclusiveEnd(rawEnd.value, dayOf(start)) }
				: rawEnd;

		// The span, kept as whole days plus the end's own time of day, so every
		// instance of a series gets the same span without this code ever adding
		// hours to a wall clock it cannot resolve.
		const spanDays = end
			? Math.round(
					(Date.parse(`${dayOf(end)}T00:00:00Z`) -
						Date.parse(`${dayOf(start)}T00:00:00Z`)) /
						86_400_000,
				)
			: 0;
		const endTime = end?.value.slice(10) ?? "";

		const rrule = property(source, "RRULE");
		const excluded = new Set(
			properties(source, "EXDATE").flatMap((exdate) =>
				exdate.value
					.split(",")
					.map((one) => timeKey(icsTime({ ...exdate, value: one }))),
			),
		);

		const instances = rrule
			? expand({
					start,
					rule: rrule.value,
					excluded,
					toDay: window.to?.slice(0, 10),
				})
			: [start];

		for (const instance of instances) {
			const override = overrides.get(`${uid}@${timeKey(instance)}`);

			if (override) {
				// An override may cancel just its own instance.
				if (
					textValue(property(override, "STATUS")).toUpperCase() === "CANCELLED"
				) {
					continue;
				}

				const overrideStart = property(override, "DTSTART");
				if (!overrideStart) continue;
				const movedStart = icsTime(overrideStart);
				const movedEnd = endOf(override, movedStart);

				events.push(
					build(uid, override, movedStart, movedEnd, calendarTimeZone, rrule),
				);
				continue;
			}

			const instanceEnd: IcsTime | undefined = end
				? {
						kind: end.kind,
						value: `${addDays(dayOf(instance), spanDays)}${endTime}`,
						timeZone: end.timeZone,
					}
				: undefined;

			events.push(
				build(uid, source, instance, instanceEnd, calendarTimeZone, rrule),
			);
		}
	}

	return events.filter((event) => overlaps(event, window));
}

/** One `CalendarEvent` from one instance. */
function build(
	uid: string,
	source: readonly IcsProperty[],
	start: IcsTime,
	end: IcsTime | undefined,
	calendarTimeZone: string | undefined,
	recurring: IcsProperty | undefined,
): CalendarEvent {
	// A recurring series has one UID for every instance, so the id carries the
	// instance's own start — the same shape Google uses for an expanded instance,
	// and the only way a consumer keying by id can hold two of them at once.
	const id = recurring ? `${uid}_${timeKey(start)}` : uid;

	return {
		id,
		summary: summaryOf(source),
		description: textValue(property(source, "DESCRIPTION")),
		location: textValue(property(source, "LOCATION")),
		kind: start.kind,
		isMultiDay:
			end !== undefined && start.value.slice(0, 10) !== end.value.slice(0, 10),
		start: start.value,
		end: end?.value,
		// The event's own zone, else the calendar's X-WR-TIMEZONE, else undefined.
		// Never validated and never defaulted — ADR-0005.
		timeZone: start.timeZone || calendarTimeZone,
	};
}

/**
 * `listEvents` + `normaliseEvents`, so the whole thing is one expression. An
 * empty calendar is `[]`, not an error.
 */
export async function fetchEvents(
	options: IcsOptions,
): Promise<CalendarEvent[]> {
	const text = await listEvents(options);
	return normaliseEvents(text, { from: options.from, to: options.to });
}
