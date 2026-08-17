/**
 * The calendar contract, as a suite every provider runs.
 *
 * ONE logical calendar, described here once as the answers it must produce, and
 * encoded per provider in that provider's own test file — a Google
 * `events.list` body, an `.ics` document, whatever a third one reads. Two
 * providers that disagree about this calendar have made the entry point a
 * consumer chose part of its data model, which is what
 * `docs/adr/0004-a-resource-may-have-more-than-one-provider.md` exists to
 * prevent.
 *
 * Not a fixtures directory, deliberately: the encodings are literals in the
 * files that use them, so `node --test` still needs no fixtures, no mock server
 * and no key (`docs/agents/testing.md`).
 *
 * TWO THINGS THIS COMPARES LOOSELY, both on purpose:
 *
 * - **Order.** The contract promises events, not an order — consumers sort. So
 *   the projection is sorted before comparing, and a provider whose source is a
 *   file in arbitrary order is not failed for it.
 * - **How an instant is SPELLED.** Google answers `2099-03-04T19:00:00+00:00`
 *   and an `.ics` file says `20990304T190000Z`; both name the same moment, and
 *   normalising one into the other's spelling would throw away the offset the
 *   source chose to state. So `"instant"` values are compared as instants. The
 *   contract promises a moment, not a text.
 *
 * `id` and `timeZone` are outside the projection for the same class of reason:
 * a Google event id is not a `UID`, and whether a zone is available at all
 * legitimately differs. Each provider pins its own in its own file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { CalendarEvent, EventKind } from "../../src/calendar/shared.js";

/** The four arms, so a fifth cannot appear without a test noticing. */
const KINDS: readonly EventKind[] = ["date", "floating", "zoned", "instant"];

/** What every provider must agree about, for one event. */
export interface EventProjection {
	summary: string | undefined;
	kind: EventKind;
	start: string;
	end: string | undefined;
	isMultiDay: boolean;
}

/**
 * THE SHARED CALENDAR, in words, so a provider's encoding can be checked
 * against something other than another encoding:
 *
 * - `Reading` — a timed hour on 4 March.
 * - `Weekly rehearsal` — a weekly series of THREE, starting 1 April at 18:00Z.
 *   Google expands this server-side and sends three items; a provider reading a
 *   file gets one `RRULE` and has to expand it. That asymmetry is the single
 *   most important row here.
 * - `Untitled` — a timed event with no title at all, so `summary` is
 *   `undefined` rather than an invented string.
 * - `Festival` — all-day, 13 to 16 June INCLUSIVE. Every source states this as
 *   ending on the 17th; every provider must step it back.
 * - `Open studio` — a single all-day day, so `isMultiDay` is false.
 *
 * And one event that must NOT appear: a cancelled one. Each encoding includes
 * it, and a provider that hands it over fails on the length.
 */
export const SHARED_CALENDAR: readonly EventProjection[] = [
	{
		summary: "Reading",
		kind: "instant",
		start: "2099-03-04T19:00:00Z",
		end: "2099-03-04T20:00:00Z",
		isMultiDay: false,
	},
	{
		summary: "Weekly rehearsal",
		kind: "instant",
		start: "2099-04-01T18:00:00Z",
		end: "2099-04-01T20:00:00Z",
		isMultiDay: false,
	},
	{
		summary: "Weekly rehearsal",
		kind: "instant",
		start: "2099-04-08T18:00:00Z",
		end: "2099-04-08T20:00:00Z",
		isMultiDay: false,
	},
	{
		summary: "Weekly rehearsal",
		kind: "instant",
		start: "2099-04-15T18:00:00Z",
		end: "2099-04-15T20:00:00Z",
		isMultiDay: false,
	},
	{
		summary: undefined,
		kind: "instant",
		start: "2099-05-01T09:00:00Z",
		end: "2099-05-01T10:00:00Z",
		isMultiDay: false,
	},
	{
		summary: "Festival",
		kind: "date",
		start: "2099-06-13",
		end: "2099-06-16",
		isMultiDay: true,
	},
	{
		summary: "Open studio",
		kind: "date",
		start: "2099-09-21",
		end: "2099-09-21",
		isMultiDay: false,
	},
];

/** One event reduced to what every provider must agree about. */
function project(event: CalendarEvent): EventProjection {
	return {
		summary: event.summary,
		kind: event.kind,
		start: event.start,
		end: event.end,
		isMultiDay: event.isMultiDay,
	};
}

/**
 * A stable order for comparison only. Sorting on the raw strings would put
 * `"2099-03-04T19:00:00+00:00"` and `"2099-03-04T19:00:00Z"` in different
 * places, so instants sort by their moment; a `"date"` sorts by its text, which
 * for `YYYY-MM-DD` is the same thing.
 */
function ordered(projections: readonly EventProjection[]): EventProjection[] {
	const key = (p: EventProjection) =>
		p.kind === "instant"
			? Date.parse(p.start)
			: Date.parse(`${p.start}T00:00:00Z`);

	return [...projections].sort(
		(a, b) =>
			key(a) - key(b) || (a.summary ?? "").localeCompare(b.summary ?? ""),
	);
}

/** Same moment, or same text for the forms that have no moment. */
function sameTime(
	actual: string | undefined,
	expected: string | undefined,
	kind: EventKind,
	what: string,
) {
	if (kind !== "instant" || actual === undefined || expected === undefined) {
		assert.equal(actual, expected, what);
		return;
	}

	assert.equal(
		Date.parse(actual),
		Date.parse(expected),
		`${what} — ${actual} is not the same moment as ${expected}`,
	);
}

/**
 * Run the contract against one provider.
 *
 * @param provider How the provider is named in test output.
 * @param read Reads THE SHARED CALENDAR through that provider, however it has
 *   to encode it. Async so a provider that goes through its transport (with a
 *   `fetch` double) can be tested the same way as one handed a payload.
 */
export function conformsToTheCalendarContract(
	provider: string,
	read: () => CalendarEvent[] | Promise<CalendarEvent[]>,
) {
	test(`${provider} reads the shared calendar into the agreed events`, async () => {
		const events = await read();
		const actual = ordered(events.map(project));
		const expected = ordered(SHARED_CALENDAR);

		// Length first: a provider that dropped a rehearsal instance or kept the
		// cancelled event should say so in one number rather than in a diff of
		// seven objects.
		assert.equal(
			actual.length,
			expected.length,
			`${provider} returned ${actual.length} events, expected ${expected.length}`,
		);

		for (const [i, want] of expected.entries()) {
			const got = actual[i]!;
			assert.equal(got.summary, want.summary, `event ${i} summary`);
			assert.equal(got.kind, want.kind, `event ${i} kind`);
			sameTime(got.start, want.start, want.kind, `event ${i} start`);
			sameTime(got.end, want.end, want.kind, `event ${i} end`);
			assert.equal(got.isMultiDay, want.isMultiDay, `event ${i} isMultiDay`);
		}
	});

	test(`${provider} returns only the four kinds`, async () => {
		for (const event of await read()) {
			assert.ok(
				KINDS.includes(event.kind),
				`${event.summary ?? "untitled"} has kind ${event.kind}`,
			);
		}
	});

	test(`${provider} never returns an end before its start`, async () => {
		for (const { kind, start, end, summary } of await read()) {
			if (end === undefined) continue;

			// Instants are compared as moments for the same reason the projection
			// is: two offsets spelling one span would compare wrongly as text.
			const [a, b] =
				kind === "instant"
					? [Date.parse(start), Date.parse(end)]
					: [start, end];

			assert.ok(
				a <= b,
				`${summary ?? "untitled"}: end ${end} precedes ${start}`,
			);
		}
	});

	test(`${provider} fills description and location rather than omitting them`, async () => {
		for (const event of await read()) {
			assert.equal(typeof event.description, "string");
			assert.equal(typeof event.location, "string");
		}
	});

	test(`${provider} computes isMultiDay from the corrected end`, async () => {
		for (const event of await read()) {
			// The contract's own rule, restated: calendar days only, first ten
			// characters, no zone and no clock. A provider that used a Date here
			// would drift from every other one at a day boundary.
			const expected =
				event.end !== undefined &&
				event.start.slice(0, 10) !== event.end.slice(0, 10);

			assert.equal(event.isMultiDay, expected, event.summary ?? "untitled");
		}
	});
}
