/**
 * What every calendar provider shares: the type it must hand back, and the
 * interpretation that belongs to the MEDIUM rather than to one vendor.
 *
 * A provider owns its transport and its normaliser
 * (`docs/adr/0004-a-resource-may-have-more-than-one-provider.md`); what it does
 * not own is the shape of the answer. Two providers disagreeing about what
 * `end` means, or about whether a string is safe to hand to `new Date()`, would
 * make the entry point a consumer chose part of its data model — which is the
 * one thing the seam exists to prevent.
 *
 * Nothing here talks to a network or knows what a `Response` is.
 */

/**
 * Which of RFC 5545's four time forms an event's `start` and `end` hold, and
 * therefore what a consumer may safely do with them.
 *
 *   "date"     → `2026-05-13`                  a floating DAY; no instant
 *   "floating" → `2026-05-13T19:00:00`         a wall TIME; no zone, no instant
 *   "zoned"    → `2026-05-13T19:00:00` + zone  a wall time IN `timeZone`
 *   "instant"  → `2026-05-13T19:00:00+01:00`   an instant; `new Date()` is safe
 *
 * ONLY `"instant"` is an instant. The other three have no single moment in time
 * and `new Date()` on one invents whatever the runtime's zone happens to be —
 * for `"date"`, UTC midnight, which renders as a spurious time or, west of UTC,
 * as the day before.
 *
 * This replaced an `isAllDay` boolean, which named only the first form and
 * implied the other three were instants. Google can afford that boolean because
 * a timed event always comes back carrying an offset; that is a property of one
 * API and not of calendars. See
 * `docs/adr/0005-an-events-time-is-a-kind-not-a-boolean.md`.
 */
export type EventKind = "date" | "floating" | "zoned" | "instant";

/**
 * An event, as this package hands it over — whichever provider read it.
 *
 * DATES ARE STRINGS, NOT `Date`s, and `kind` is how a consumer knows which of
 * the four forms it is holding.
 *
 * They sort correctly as strings only WITHIN one kind and one offset. Two
 * instants written in different offsets sort wrongly as text, and a `"date"`
 * sorts before every timed form on the same day. Google hides this by answering
 * in the calendar's zone throughout; a provider reading a file written by
 * several clients does not.
 */
export interface CalendarEvent {
	id: string;
	/**
	 * `undefined` for an untitled event. Inventing a title is the site's
	 * decision, not this package's.
	 */
	summary: string | undefined;
	/** `""` when unset. */
	description: string;
	/** `""` when unset. */
	location: string;
	/** Which time form `start` and `end` hold. See {@link EventKind}. */
	kind: EventKind;
	/**
	 * True when the span covers more than one calendar day, computed AFTER the
	 * inclusive-end correction.
	 */
	isMultiDay: boolean;
	start: string;
	/**
	 * INCLUSIVE — the last moment the event actually covers.
	 *
	 * An all-day end arrives EXCLUSIVE from every calendar system worth reading:
	 * Google's `end.date` and RFC 5545's `DTEND` both name the day AFTER the
	 * last, so a 13th-to-16th event arrives ending on the 17th. It is stepped
	 * back, so `end` means the same thing whatever the `kind`.
	 *
	 * `undefined` only if the source sent no end at all.
	 */
	end: string | undefined;
	/**
	 * The event's own zone, else the calendar's, else `undefined`. NEVER a
	 * default: a fallback zone is the consumer's truth, not this package's.
	 *
	 * NOT guaranteed to be an IANA name. It is whatever the source said, and
	 * Outlook writes Windows zone names like `W. Europe Standard Time`. With
	 * `kind: "zoned"` this is the only thing that makes `start` meaningful, and
	 * resolving it is the consumer's job.
	 */
	timeZone: string | undefined;
}

/**
 * `YYYY-MM-DD`, `n` days later. Negative `n` goes back.
 *
 * The `Date` is arithmetic scaffolding on a UTC-pinned date string and NEVER
 * ESCAPES — pin the string to UTC, count in days, take the date part back. A
 * date-only string has no instant of its own, so anything that let a real zone
 * near it would move the answer by a day for half the world.
 */
export function addDays(day: string, n: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + n);
	return date.toISOString().slice(0, 10);
}

/**
 * An all-day end, corrected from EXCLUSIVE to INCLUSIVE.
 *
 * Every calendar system worth reading states an all-day end as the day AFTER
 * the last: Google's `end.date` and RFC 5545's `DTEND` alike, so a
 * 13th-to-16th event arrives ending on the 17th. Every provider steps it back,
 * which is why this lives here rather than in whichever provider needed it
 * first — two providers disagreeing by a day about the same event is precisely
 * what the shared module exists to prevent.
 *
 * Consumers that emit `schema.org` `endDate` want the corrected value; leaving
 * it exclusive puts the structured data one day out of step with the page.
 */
export function inclusiveEnd(end: string): string {
	return addDays(end, -1);
}
