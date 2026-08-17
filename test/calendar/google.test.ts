import test from "node:test";
import assert from "node:assert/strict";

import { apiKey } from "../../src/auth.ts";
import {
	fetchEvents,
	listEvents,
	normaliseEvents,
	type EventResource,
	type EventsPayload,
} from "../../src/calendar/google.ts";
import { recordConsole } from "../support/console.ts";
import { serve } from "../support/serve.ts";
import { conformsToTheCalendarContract } from "./conformance.ts";

// What the transport ASKS for, how it walks pages, and what the normaliser makes
// of the answer. Nothing here formats a date or knows what "now" is — a consumer
// owns both.
//
// `listEvents` takes its `fetch` as an option, so nothing here touches
// `globalThis.fetch` or the network.

const auth = apiKey("test-key");
const CALENDAR = "someone@example.test";

// A page served below is a raw events.list body: `{timeZone, items,
// nextPageToken}`.

// A timed events.list item.
function event(
	summary: string,
	startDateTime?: string,
	extra: Partial<EventResource> = {},
): EventResource {
	return {
		id: `id-${summary}`,
		status: "confirmed",
		summary,
		description: `${summary} description`,
		location: "Somewhere",
		start: { dateTime: startDateTime, timeZone: "Europe/London" },
		end: { dateTime: startDateTime, timeZone: "Europe/London" },
		...extra,
	};
}

// ------------------------------------------------------------------ the query

test("asks the API to expand recurring series into instances", async () => {
	// Google defaults singleEvents to false, which hands back the unexpanded
	// master carrying its RRULE — a normaliser has no idea what an RRULE is, so
	// a weekly series would render as ONE event on the series' start date.
	const { fetch, requested } = serve([
		{ timeZone: "Europe/London", items: [] },
	]);

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("singleEvents"), "true");
});

test("orders by startTime, which the API only allows alongside singleEvents", async () => {
	const { fetch, requested } = serve([
		{ timeZone: "Europe/London", items: [] },
	]);

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("orderBy"), "startTime");
	assert.equal(
		requested[0].searchParams.get("singleEvents"),
		"true",
		"orderBy=startTime without singleEvents is a 400 from Google",
	);
});

test("asks for the largest page the API allows, not the 250 default", async () => {
	const { fetch, requested } = serve([
		{ timeZone: "Europe/London", items: [] },
	]);

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("maxResults"), "2500");
});

test("sends no time window unless asked — a default one would hide past events", async () => {
	const { fetch, requested } = serve([
		{ timeZone: "Europe/London", items: [] },
	]);

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("timeMin"), null);
	assert.equal(requested[0].searchParams.get("timeMax"), null);
});

test("the window becomes timeMin and timeMax when a caller does ask", async () => {
	const { fetch, requested } = serve([
		{ timeZone: "Europe/London", items: [] },
	]);

	// `from`/`to` are the package's names for the window; mapping them to
	// Google's two parameters is this provider's job and nobody else's.
	await listEvents({
		calendarId: CALENDAR,
		auth,
		fetch,
		from: "2020-01-01T00:00:00Z",
		to: "2030-01-01T00:00:00Z",
	});

	assert.equal(
		requested[0].searchParams.get("timeMin"),
		"2020-01-01T00:00:00Z",
	);
	assert.equal(
		requested[0].searchParams.get("timeMax"),
		"2030-01-01T00:00:00Z",
	);
});

test("the calendar id is escaped into the path, and the auth applied", async () => {
	const { fetch, requested } = serve([
		{ timeZone: "Europe/London", items: [] },
	]);

	await listEvents({ calendarId: "a b@example.test", auth, fetch });

	assert.match(
		requested[0].pathname,
		/calendars\/a%20b%40example\.test\/events/,
	);
	assert.equal(requested[0].searchParams.get("key"), "test-key");
});

// ---------------------------------------------------------------- pagination

// The walk itself — the cap, a repeated token, a non-OK page — is
// `internal/page-walk.ts` and is tested in `test/page-walk.test.ts`. What
// belongs here is that this transport keeps every page it is handed, and takes
// the calendar's zone off the first one.

test("follows nextPageToken and keeps every page's events", async () => {
	const { fetch, requested } = serve([
		{
			timeZone: "Europe/London",
			items: [event("Page one", "2099-03-04T19:00:00+00:00")],
			nextPageToken: "token-2",
		},
		{
			timeZone: "Europe/London",
			items: [event("Page two", "2099-03-05T19:00:00+00:00")],
		},
	]);

	const { items, timeZone } = await listEvents({
		calendarId: CALENDAR,
		auth,
		fetch,
	});

	assert.equal(requested.length, 2);
	assert.equal(requested[0].searchParams.get("pageToken"), null);
	assert.equal(requested[1].searchParams.get("pageToken"), "token-2");
	assert.deepEqual(
		items.map((e) => e.summary),
		["Page one", "Page two"],
	);
	assert.equal(timeZone, "Europe/London");
});

// ------------------------------------------------------------------ failures

test("throws immediately when no auth was passed", async () => {
	const { fetch } = serve([{ items: [] }]);

	await assert.rejects(
		// @ts-expect-error — the omission the runtime guard exists for
		() => listEvents({ calendarId: CALENDAR, fetch }),
		/auth/i,
	);
});

// ------------------------------------------------------------ normaliseEvents

test("cancelled events and events with no start are dropped", async () => {
	const events = normaliseEvents({
		items: [
			event("Kept", "2099-03-04T19:00:00+00:00"),
			{
				...event("Cancelled", "2099-03-05T19:00:00+00:00"),
				status: "cancelled",
			},
			{ ...event("Startless", "2099-03-06T19:00:00+00:00"), start: undefined },
			// A start that carries neither `date` nor `dateTime` is the same
			// absence wearing a wrapper, and goes the same way: `start` is a
			// string on the way out, so an event that cannot supply one is noise.
			//
			// This case used to be worse than untested: with an `end` present it
			// threw a TypeError out of `isMultiDay`, and without one it emitted a
			// record whose `start` was `undefined`. One drop replaces both.
			{ ...event("Dateless", "2099-03-07T19:00:00+00:00"), start: {} },
		],
	});

	assert.deepEqual(
		events.map((e) => e.summary),
		["Kept"],
	);
});

test("only `cancelled` drops an event — an unfamiliar status is kept", () => {
	// `status` is typed as an OPEN union, so a value Google has not documented
	// still assigns (this file would stop compiling if the union were closed) and
	// still reaches the consumer. Interpreting one value means interpreting one
	// value.
	const events = normaliseEvents({
		items: [
			{
				...event("Tentative", "2099-03-04T19:00:00+00:00"),
				status: "tentative",
			},
			{
				...event("Postponed", "2099-03-05T19:00:00+00:00"),
				status: "postponed",
			},
			{
				...event("Statusless", "2099-03-06T19:00:00+00:00"),
				status: undefined,
			},
		],
	});

	assert.deepEqual(
		events.map((e) => e.summary),
		["Tentative", "Postponed", "Statusless"],
	);
});

test("a timed event keeps its offset and is an instant", () => {
	const [e] = normaliseEvents({
		items: [event("Reading", "2099-03-04T19:00:00+00:00")],
	});

	// "instant" and not merely "timed": Google's `dateTime` always carries an
	// offset, which is what makes the string safe to hand to `new Date()`.
	assert.equal(e.kind, "instant");
	assert.equal(e.start, "2099-03-04T19:00:00+00:00");
	assert.equal(e.end, "2099-03-04T19:00:00+00:00");
	assert.equal(e.isMultiDay, false);
});

test("an all-day event's end is stepped back to the INCLUSIVE last day", () => {
	// Google's all-day end.date is exclusive: a 13th-to-16th event arrives
	// ending on the 17th. Correcting it here means `end` means the same thing
	// whether or not the event is all-day.
	const [festival, talk] = normaliseEvents({
		items: [
			{
				...event("Festival"),
				start: { date: "2099-06-13" },
				end: { date: "2099-06-17" },
			},
			{
				...event("Talk"),
				start: { date: "2099-09-21" },
				end: { date: "2099-09-22" },
			},
		],
	});

	assert.equal(festival.kind, "date");
	assert.equal(festival.start, "2099-06-13");
	assert.equal(festival.end, "2099-06-16");
	assert.equal(festival.isMultiDay, true);

	// One exclusive day past the start is a single-day event, not a two-day one.
	assert.equal(talk.end, "2099-09-21");
	assert.equal(talk.isMultiDay, false);
});

test("an all-day end that steps back across a month boundary", () => {
	const [e] = normaliseEvents({
		items: [
			{
				...event("Month end"),
				start: { date: "2099-05-30" },
				end: { date: "2099-06-01" },
			},
		],
	});

	assert.equal(e.end, "2099-05-31");
});

test("a timed event spanning midnight is multi-day", () => {
	const [e] = normaliseEvents({
		items: [
			{
				...event("Late"),
				start: { dateTime: "2099-03-04T23:00:00+00:00" },
				end: { dateTime: "2099-03-05T01:00:00+00:00" },
			},
		],
	});

	assert.equal(e.isMultiDay, true);
});

test("the event's own zone wins, else the calendar's, else undefined", () => {
	const payload = {
		timeZone: "Europe/London",
		items: [
			event("Own zone", "2099-03-04T19:00:00+00:00", {
				start: {
					dateTime: "2099-03-04T19:00:00+01:00",
					timeZone: "Europe/Paris",
				},
				end: { dateTime: "2099-03-04T20:00:00+01:00" },
			}),
			event("Calendar zone", "2099-03-04T19:00:00+00:00", {
				start: { dateTime: "2099-03-04T19:00:00+00:00" },
				end: { dateTime: "2099-03-04T20:00:00+00:00" },
			}),
		],
	};

	const events = normaliseEvents(payload);
	assert.equal(events[0].timeZone, "Europe/Paris");
	assert.equal(events[1].timeZone, "Europe/London");

	// No default. A fallback zone is the consumer's truth, not this package's.
	const [orphan] = normaliseEvents({ items: [payload.items[1]] });
	assert.equal(orphan.timeZone, undefined);
});

test("description and location are empty strings when unset, never undefined", () => {
	const [e] = normaliseEvents({
		items: [
			{
				...event("Bare", "2099-03-04T19:00:00+00:00"),
				description: undefined,
				location: undefined,
			},
		],
	});

	assert.equal(e.description, "");
	assert.equal(e.location, "");
});

test("normaliseEvents has no effect other than its return value", () => {
	// The rule covers both normalisers, so the guard does too
	// (`docs/adr/0002-the-normalisers-report-nothing.md`). The temptation is
	// arguably stronger here than in Drive: this function DROPS records, and a
	// dropped event leaves no trace in the return value to report it with — which
	// is exactly the reasoning that would justify a log line, and exactly the
	// decision the ADR settles. A cancelled and a startless event, then.
	const said = recordConsole(() =>
		normaliseEvents({
			items: [
				{
					...event("Cancelled", "2099-03-04T19:00:00+00:00"),
					status: "cancelled",
				},
				{
					...event("Startless", "2099-03-05T19:00:00+00:00"),
					start: undefined,
				},
			],
		}),
	);

	assert.deepEqual(said, [], "the normaliser reached for the console");
});

test("an events.list body with no items normalises to an empty array", () => {
	assert.deepEqual(normaliseEvents({ timeZone: "Europe/London" }), []);
	assert.deepEqual(normaliseEvents({}), []);
});

test("neither sorted nor partitioned — both need a clock, and the clock is the site's", () => {
	const events = normaliseEvents({
		items: [
			event("Later", "2099-03-05T19:00:00+00:00"),
			event("Earlier", "2019-03-04T19:00:00+00:00"),
		],
	});

	assert.deepEqual(
		events.map((e) => e.summary),
		["Later", "Earlier"],
		"the input order survives",
	);
});

// -------------------------------------------------------------- fetchEvents

test("fetchEvents is listEvents then normaliseEvents", async () => {
	const { fetch } = serve([
		{
			timeZone: "Europe/London",
			items: [event("Reading", "2099-03-04T19:00:00+00:00")],
		},
	]);

	const events = await fetchEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(events.length, 1);
	assert.equal(events[0].summary, "Reading");
	assert.equal(events[0].timeZone, "Europe/London");
});

test("an empty calendar returns [] rather than throwing", async () => {
	const { fetch } = serve([{ timeZone: "Europe/London", items: [] }]);

	assert.deepEqual(
		await fetchEvents({ calendarId: CALENDAR, auth, fetch }),
		[],
	);
});

// ------------------------------------------------------ the calendar contract

// THE SHARED CALENDAR, as Google sends it. The same calendar encoded for every
// other provider lives in that provider's test file, and
// `conformance.ts` holds the answers all of them must agree on.
//
// Note what Google has already done here: the weekly series arrives as THREE
// items, because `singleEvents=true` expanded it server-side. A provider reading
// a file receives one rule and has to expand it itself — that asymmetry is the
// point of running one suite against both.
const SHARED_CALENDAR_FROM_GOOGLE: EventsPayload = {
	timeZone: "Europe/London",
	items: [
		{
			id: "reading",
			status: "confirmed",
			summary: "Reading",
			start: { dateTime: "2099-03-04T19:00:00+00:00" },
			end: { dateTime: "2099-03-04T20:00:00+00:00" },
		},
		{
			id: "rehearsal-1",
			status: "confirmed",
			summary: "Weekly rehearsal",
			start: { dateTime: "2099-04-01T18:00:00+00:00" },
			end: { dateTime: "2099-04-01T20:00:00+00:00" },
		},
		{
			id: "rehearsal-2",
			status: "confirmed",
			summary: "Weekly rehearsal",
			start: { dateTime: "2099-04-08T18:00:00+00:00" },
			end: { dateTime: "2099-04-08T20:00:00+00:00" },
		},
		{
			id: "rehearsal-3",
			status: "confirmed",
			summary: "Weekly rehearsal",
			start: { dateTime: "2099-04-15T18:00:00+00:00" },
			end: { dateTime: "2099-04-15T20:00:00+00:00" },
		},
		{
			// No `summary` at all: Google omits the field for an untitled event.
			id: "untitled",
			status: "confirmed",
			start: { dateTime: "2099-05-01T09:00:00+00:00" },
			end: { dateTime: "2099-05-01T10:00:00+00:00" },
		},
		{
			// All-day, 13 to 16 June inclusive — stated as ending on the 17th.
			id: "festival",
			status: "confirmed",
			summary: "Festival",
			start: { date: "2099-06-13" },
			end: { date: "2099-06-17" },
		},
		{
			id: "open-studio",
			status: "confirmed",
			summary: "Open studio",
			start: { date: "2099-09-21" },
			end: { date: "2099-09-22" },
		},
		{
			// Must not survive: cancelled is transport-shaped noise.
			id: "cancelled",
			status: "cancelled",
			summary: "Cancelled talk",
			start: { dateTime: "2099-07-07T12:00:00+00:00" },
			end: { dateTime: "2099-07-07T13:00:00+00:00" },
		},
	],
};

conformsToTheCalendarContract("the Google provider", () =>
	normaliseEvents(SHARED_CALENDAR_FROM_GOOGLE),
);

test("an all-day end.date equal to start.date is one day, not a negative span", () => {
	// Google's own answers are always exclusive, so this is defensive rather than
	// observed — but the correction is shared with the ics provider, where the
	// equal form is what a mainstream feed actually writes. Both entry points
	// have to read it the same way or the same calendar renders differently
	// depending on which one a site imported.
	const [holiday] = normaliseEvents({
		items: [
			{
				...event("New Year's Day"),
				start: { date: "2025-01-01" },
				end: { date: "2025-01-01" },
			},
		],
	});

	assert.equal(holiday!.start, "2025-01-01");
	assert.equal(holiday!.end, "2025-01-01");
	assert.equal(holiday!.isMultiDay, false);
});
