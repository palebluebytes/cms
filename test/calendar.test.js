import test from "node:test";
import assert from "node:assert/strict";

import { apiKey } from "../src/auth.js";
import { fetchEvents, listEvents, normaliseEvents } from "../src/calendar.js";

// What the transport ASKS for, how it walks pages, and what the normaliser makes
// of the answer. Nothing here formats a date or knows what "now" is — a consumer
// owns both.
//
// `listEvents` takes its `fetch` as an option, so nothing here touches
// `globalThis.fetch` or the network.

const auth = apiKey("test-key");
const CALENDAR = "someone@example.test";

// Serve the given pages in order, recording every URL asked for. A page is a raw
// events.list body: `{timeZone, items, nextPageToken}`.
function serve(...pages) {
	const requested = [];
	let call = 0;
	const fetch = async (request) => {
		requested.push(new URL(request.url));
		const page = pages[Math.min(call++, pages.length - 1)];
		return { ok: true, status: 200, statusText: "OK", json: async () => page };
	};
	return { fetch, requested };
}

// A timed events.list item.
function event(summary, startDateTime, extra = {}) {
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
	const { fetch, requested } = serve({ timeZone: "Europe/London", items: [] });

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("singleEvents"), "true");
});

test("orders by startTime, which the API only allows alongside singleEvents", async () => {
	const { fetch, requested } = serve({ timeZone: "Europe/London", items: [] });

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("orderBy"), "startTime");
	assert.equal(
		requested[0].searchParams.get("singleEvents"),
		"true",
		"orderBy=startTime without singleEvents is a 400 from Google",
	);
});

test("asks for the largest page the API allows, not the 250 default", async () => {
	const { fetch, requested } = serve({ timeZone: "Europe/London", items: [] });

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("maxResults"), "2500");
});

test("sends no time window unless asked — a default one would hide past events", async () => {
	const { fetch, requested } = serve({ timeZone: "Europe/London", items: [] });

	await listEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(requested[0].searchParams.get("timeMin"), null);
	assert.equal(requested[0].searchParams.get("timeMax"), null);
});

test("timeMin and timeMax are passed through when a caller does ask", async () => {
	const { fetch, requested } = serve({ timeZone: "Europe/London", items: [] });

	await listEvents({
		calendarId: CALENDAR,
		auth,
		fetch,
		timeMin: "2020-01-01T00:00:00Z",
		timeMax: "2030-01-01T00:00:00Z",
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
	const { fetch, requested } = serve({ timeZone: "Europe/London", items: [] });

	await listEvents({ calendarId: "a b@example.test", auth, fetch });

	assert.match(
		requested[0].pathname,
		/calendars\/a%20b%40example\.test\/events/,
	);
	assert.equal(requested[0].searchParams.get("key"), "test-key");
});

// ---------------------------------------------------------------- pagination

test("follows nextPageToken and keeps every page's events", async () => {
	const { fetch, requested } = serve(
		{
			timeZone: "Europe/London",
			items: [event("Page one", "2099-03-04T19:00:00+00:00")],
			nextPageToken: "token-2",
		},
		{
			timeZone: "Europe/London",
			items: [event("Page two", "2099-03-05T19:00:00+00:00")],
		},
	);

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

test("throws rather than truncating when the API repeats a pageToken", async () => {
	// A token that hands back itself would loop forever; stopping quietly would
	// drop the tail, which is the bug this whole file guards.
	const { fetch } = serve({
		timeZone: "Europe/London",
		items: [event("Looping", "2099-03-04T19:00:00+00:00")],
		nextPageToken: "same-token",
	});

	await assert.rejects(
		() => listEvents({ calendarId: CALENDAR, auth, fetch }),
		/pageToken/,
	);
});

test("throws rather than paging forever past the cap", async () => {
	// An unbounded recurring series expands without end once singleEvents is on.
	let n = 0;
	const fetch = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			timeZone: "Europe/London",
			items: [event(`Instance ${n}`, "2099-03-04T19:00:00+00:00")],
			nextPageToken: `token-${++n}`,
		}),
	});

	await assert.rejects(
		() => listEvents({ calendarId: CALENDAR, auth, fetch }),
		/too many pages/i,
	);
});

test("maxPages is a caller's backstop, not a fixed one", async () => {
	let n = 0;
	let calls = 0;
	const fetch = async () => {
		calls++;
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ items: [], nextPageToken: `token-${++n}` }),
		};
	};

	await assert.rejects(
		() => listEvents({ calendarId: CALENDAR, auth, fetch, maxPages: 2 }),
		/too many pages/i,
	);
	assert.equal(calls, 2, "it stops after the caller's cap, not the default");
});

// ------------------------------------------------------------------ failures

test("throws on a non-OK events.list response", async () => {
	const fetch = async () => ({
		ok: false,
		status: 403,
		statusText: "Forbidden",
		json: async () => ({}),
	});

	await assert.rejects(
		() => listEvents({ calendarId: CALENDAR, auth, fetch }),
		/403/,
	);
});

test("throws immediately when no auth was passed", async () => {
	const { fetch } = serve({ items: [] });

	await assert.rejects(
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
		],
	});

	assert.deepEqual(
		events.map((e) => e.summary),
		["Kept"],
	);
});

test("a timed event keeps its offset and is not all-day", () => {
	const [e] = normaliseEvents({
		items: [event("Reading", "2099-03-04T19:00:00+00:00")],
	});

	assert.equal(e.isAllDay, false);
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

	assert.equal(festival.isAllDay, true);
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
				...event("Bare"),
				description: undefined,
				location: undefined,
			},
		],
	});

	assert.equal(e.description, "");
	assert.equal(e.location, "");
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
	const { fetch } = serve({
		timeZone: "Europe/London",
		items: [event("Reading", "2099-03-04T19:00:00+00:00")],
	});

	const events = await fetchEvents({ calendarId: CALENDAR, auth, fetch });

	assert.equal(events.length, 1);
	assert.equal(events[0].summary, "Reading");
	assert.equal(events[0].timeZone, "Europe/London");
});

test("an empty calendar returns [] rather than throwing", async () => {
	const { fetch } = serve({ timeZone: "Europe/London", items: [] });

	assert.deepEqual(
		await fetchEvents({ calendarId: CALENDAR, auth, fetch }),
		[],
	);
});
