import test from "node:test";
import assert from "node:assert/strict";

import { apiKey } from "../../src/auth.ts";
import {
	fetchEvents,
	listEvents,
	normaliseEvents,
} from "../../src/calendar/ics.ts";
import { recordConsole } from "../support/console.ts";
import { serveText } from "../support/serve.ts";
import { conformsToTheCalendarContract } from "./conformance.ts";

// The second provider of the calendar resource. What matters most here is not
// any single assertion but the conformance call at the bottom: the same logical
// calendar as the Google provider reads, arriving in a completely different
// shape, has to come out the same.

const URL = "https://example.test/private/basic.ics";

/** A file with one VEVENT holding the given lines. */
function file(...lines: string[]): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//EN",
		"BEGIN:VEVENT",
		"UID:one@example.test",
		...lines,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

// ---------------------------------------------------------------- the transport

test("reads the file with no credential at all — the secret URL is the credential", async () => {
	const { fetch, requested } = serveText([file("DTSTART:20990304T190000Z")]);

	const events = await fetchEvents({ url: URL, fetch });

	assert.equal(requested.length, 1);
	assert.equal(requested[0]!.href, URL);
	assert.equal(events.length, 1);
});

test("applies an auth when one is given, for an export behind Basic", async () => {
	const { fetch, requested } = serveText([file("DTSTART:20990304T190000Z")]);

	await fetchEvents({ url: URL, auth: apiKey("test-key"), fetch });

	assert.equal(requested[0]!.searchParams.get("key"), "test-key");
});

test("refuses a 200 text/html, which is a sign-in page and not a calendar", async () => {
	// Parsing it would find no VEVENT and return [] — a calendar that reads as
	// empty rather than as unreadable, which is the failure worth refusing.
	const { fetch } = serveText(["<html><body>Sign in</body></html>"], {
		contentType: "text/html; charset=utf-8",
	});

	await assert.rejects(
		() => fetchEvents({ url: URL, fetch }),
		/sign-in page, not a calendar/,
	);
});

test("throws on a non-OK response rather than treating it as empty", async () => {
	const { fetch } = serveText(["nope"], { status: 404 });

	await assert.rejects(
		() => listEvents({ url: URL, fetch }),
		/Failed to read the calendar: 404/,
	);
});

// --------------------------------------------------------------- the normaliser

test("an empty calendar is [] rather than an error", () => {
	assert.deepEqual(
		normaliseEvents("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR"),
		[],
	);
});

test("reports nothing, whatever it is handed", () => {
	// The same guard both other normalisers have — ADR-0002. `console` is in
	// lib.dom, so a call to it compiles clean inside `src` and nothing else here
	// would go red.
	const said = recordConsole(() =>
		normaliseEvents(
			file(
				"DTSTART;VALUE=DATE:20990613",
				"SUMMARY:Anything",
				"RRULE:FREQ=DAILY;COUNT=2",
			),
		),
	);

	assert.deepEqual(said, []);
});

test("takes the calendar's zone when an event states none", () => {
	const text = [
		"BEGIN:VCALENDAR",
		"X-WR-TIMEZONE:Europe/London",
		"BEGIN:VEVENT",
		"UID:a@example.test",
		"DTSTART;TZID=America/New_York:20990304T190000",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:b@example.test",
		"DTSTART:20990304T190000",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	const [own, fallback] = normaliseEvents(text);

	assert.equal(own!.timeZone, "America/New_York");
	assert.equal(own!.kind, "zoned");
	// X-WR-TIMEZONE is non-standard and is what Google's own .ics export emits.
	// The event has no zone of its own, so the calendar's answers for it — and
	// the kind stays "floating", because the file stated no zone FOR THE TIME.
	assert.equal(fallback!.timeZone, "Europe/London");
	assert.equal(fallback!.kind, "floating");
});

test("an untitled event has no summary, and an empty SUMMARY is untitled too", () => {
	const [absent] = normaliseEvents(file("DTSTART:20990304T190000Z"));
	const [empty] = normaliseEvents(file("DTSTART:20990304T190000Z", "SUMMARY:"));

	assert.equal(absent!.summary, undefined);
	assert.equal(empty!.summary, undefined);
});

test("drops a cancelled event and one with no DTSTART", () => {
	const text = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:kept@example.test",
		"SUMMARY:Kept",
		"DTSTART:20990304T190000Z",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:cancelled@example.test",
		"SUMMARY:Cancelled",
		"STATUS:CANCELLED",
		"DTSTART:20990305T190000Z",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:startless@example.test",
		"SUMMARY:Startless",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	assert.deepEqual(
		normaliseEvents(text).map((e) => e.summary),
		["Kept"],
	);
});

test("DURATION stands in for a missing DTEND", () => {
	const [timed] = normaliseEvents(
		file("DTSTART:20990304T190000Z", "DURATION:PT2H30M"),
	);
	const [allDay] = normaliseEvents(
		file("DTSTART;VALUE=DATE:20990613", "DURATION:P4D"),
	);

	assert.equal(timed!.end, "2099-03-04T21:30:00Z");

	// P4D from the 13th covers the 13th to the 16th: the duration's end is
	// exclusive exactly as a DTEND would be, so the inclusive end is the 16th.
	assert.equal(allDay!.end, "2099-06-16");
	assert.equal(allDay!.isMultiDay, true);
});

test("a DURATION crossing midnight carries the day", () => {
	const [event] = normaliseEvents(
		file("DTSTART:20990304T230000Z", "DURATION:PT2H"),
	);

	assert.equal(event!.end, "2099-03-05T01:00:00Z");
	assert.equal(event!.isMultiDay, true);
});

test("an all-day event with an hours-long DURATION is refused", () => {
	assert.throws(
		() => normaliseEvents(file("DTSTART;VALUE=DATE:20990613", "DURATION:PT2H")),
		/all-day event cannot have a DURATION carrying a time/,
	);
});

// ----------------------------------------------------------------- recurrence

test("expands a series, giving each instance the span and an id of its own", () => {
	const events = normaliseEvents(
		file(
			"SUMMARY:Rehearsal",
			"DTSTART:20990401T180000Z",
			"DTEND:20990401T200000Z",
			"RRULE:FREQ=WEEKLY;COUNT=3",
		),
	);

	assert.deepEqual(
		events.map((e) => [e.start, e.end]),
		[
			["2099-04-01T18:00:00Z", "2099-04-01T20:00:00Z"],
			["2099-04-08T18:00:00Z", "2099-04-08T20:00:00Z"],
			["2099-04-15T18:00:00Z", "2099-04-15T20:00:00Z"],
		],
	);

	// One UID covers every instance, so the id has to carry the start or a
	// consumer keying by id can only hold one of them.
	assert.deepEqual(new Set(events.map((e) => e.id)).size, 3);
	assert.match(events[1]!.id, /^one@example\.test_2099-04-08T18:00:00$/);
});

test("a multi-day span survives expansion", () => {
	const events = normaliseEvents(
		file(
			"DTSTART;VALUE=DATE:20990601",
			"DTEND;VALUE=DATE:20990604",
			"RRULE:FREQ=MONTHLY;COUNT=2",
		),
	);

	// Three days inclusive, in June and again in July.
	assert.deepEqual(
		events.map((e) => [e.start, e.end, e.isMultiDay]),
		[
			["2099-06-01", "2099-06-03", true],
			["2099-07-01", "2099-07-03", true],
		],
	);
});

test("EXDATE removes an instance", () => {
	const events = normaliseEvents(
		file(
			"DTSTART:20990401T180000Z",
			"RRULE:FREQ=WEEKLY;COUNT=3",
			"EXDATE:20990408T180000Z",
		),
	);

	assert.deepEqual(
		events.map((e) => e.start),
		["2099-04-01T18:00:00Z", "2099-04-15T18:00:00Z"],
	);
});

test("a RECURRENCE-ID override replaces just its own instance", () => {
	const text = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:series@example.test",
		"SUMMARY:Rehearsal",
		"DTSTART:20990401T180000Z",
		"DTEND:20990401T200000Z",
		"RRULE:FREQ=WEEKLY;COUNT=3",
		"END:VEVENT",
		// The middle one moved, and was renamed.
		"BEGIN:VEVENT",
		"UID:series@example.test",
		"RECURRENCE-ID:20990408T180000Z",
		"SUMMARY:Rehearsal (moved)",
		"DTSTART:20990409T170000Z",
		"DTEND:20990409T190000Z",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	assert.deepEqual(
		normaliseEvents(text).map((e) => [e.summary, e.start]),
		[
			["Rehearsal", "2099-04-01T18:00:00Z"],
			["Rehearsal (moved)", "2099-04-09T17:00:00Z"],
			["Rehearsal", "2099-04-15T18:00:00Z"],
		],
	);
});

test("an override may cancel only its own instance", () => {
	const text = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:series@example.test",
		"DTSTART:20990401T180000Z",
		"RRULE:FREQ=WEEKLY;COUNT=3",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:series@example.test",
		"RECURRENCE-ID:20990408T180000Z",
		"STATUS:CANCELLED",
		"DTSTART:20990408T180000Z",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	assert.deepEqual(
		normaliseEvents(text).map((e) => e.start),
		["2099-04-01T18:00:00Z", "2099-04-15T18:00:00Z"],
	);
});

test("an unbounded series with no window throws, rather than guessing at now", () => {
	assert.throws(
		() =>
			normaliseEvents(file("DTSTART:20990401T180000Z", "RRULE:FREQ=WEEKLY")),
		/never ends.*\bto\b/s,
	);
});

test("an unbounded series expands into the window it is given", () => {
	const events = normaliseEvents(
		file("DTSTART:20990401T180000Z", "RRULE:FREQ=WEEKLY"),
		{ to: "2099-04-20T00:00:00Z" },
	);

	assert.deepEqual(
		events.map((e) => e.start),
		["2099-04-01T18:00:00Z", "2099-04-08T18:00:00Z", "2099-04-15T18:00:00Z"],
	);
});

// --------------------------------------------------------------- the window

test("keeps an event overlapping the window, including one already in progress", () => {
	// Google's rule and therefore the contract's: timeMin bounds an event's END.
	// `start >= from` would drop the conference, which is the case this pins.
	const text = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:before@example.test",
		"SUMMARY:Before",
		"DTSTART:20990301T090000Z",
		"DTEND:20990301T100000Z",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:straddling@example.test",
		"SUMMARY:In progress",
		"DTSTART:20990304T090000Z",
		"DTEND:20990306T170000Z",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:after@example.test",
		"SUMMARY:After",
		"DTSTART:20990401T090000Z",
		"DTEND:20990401T100000Z",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	assert.deepEqual(
		normaliseEvents(text, {
			from: "2099-03-05T00:00:00Z",
			to: "2099-03-10T00:00:00Z",
		}).map((e) => e.summary),
		["In progress"],
	);
});

test("an all-day event is compared day-wise against the window", () => {
	// A floating date has no instant, so comparing it to a boundary needs a zone
	// this package will not invent: the comparison is on the first ten
	// characters, and an event covering the window's opening day overlaps it.
	const text = file("DTSTART;VALUE=DATE:20990613", "DTEND;VALUE=DATE:20990617");

	assert.equal(
		normaliseEvents(text, { from: "2099-06-16T00:00:00Z" }).length,
		1,
		"the festival still covers the 16th",
	);
	assert.equal(
		normaliseEvents(text, { from: "2099-06-17T00:00:00Z" }).length,
		0,
		"and is over by the 17th",
	);
});

// ------------------------------------------------------ the calendar contract

// THE SHARED CALENDAR, as an .ics file. The same calendar as a Google
// `events.list` body lives in `google.test.ts`, and `conformance.ts` holds the
// answers both must give.
//
// Read the weekly series: ONE VEVENT with an RRULE, where Google sent three
// separate items. Everything this provider had to be built for is in that one
// difference.
const SHARED_CALENDAR_AS_ICS = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"PRODID:-//Test//EN",
	"X-WR-TIMEZONE:Europe/London",
	"BEGIN:VEVENT",
	"UID:reading@example.test",
	"SUMMARY:Reading",
	"DTSTART:20990304T190000Z",
	"DTEND:20990304T200000Z",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"UID:rehearsal@example.test",
	"SUMMARY:Weekly rehearsal",
	"DTSTART:20990401T180000Z",
	"DTEND:20990401T200000Z",
	"RRULE:FREQ=WEEKLY;COUNT=3",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"UID:untitled@example.test",
	"DTSTART:20990501T090000Z",
	"DTEND:20990501T100000Z",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"UID:festival@example.test",
	"SUMMARY:Festival",
	"DTSTART;VALUE=DATE:20990613",
	"DTEND;VALUE=DATE:20990617",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"UID:open-studio@example.test",
	"SUMMARY:Open studio",
	"DTSTART;VALUE=DATE:20990921",
	"DTEND;VALUE=DATE:20990922",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"UID:cancelled@example.test",
	"SUMMARY:Cancelled talk",
	"STATUS:CANCELLED",
	"DTSTART:20990707T120000Z",
	"DTEND:20990707T130000Z",
	"END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

conformsToTheCalendarContract("the ics provider", () =>
	normaliseEvents(SHARED_CALENDAR_AS_ICS),
);

test("an all-day DTEND equal to DTSTART is one day, not a negative span", () => {
	// Calendar Labs writes every one-day holiday this way — DTEND == DTSTART,
	// where Google writes the next day. Both readings exist in the wild, and
	// treating this one as exclusive renders an event that ends before it starts.
	const [holiday] = normaliseEvents(
		file(
			"SUMMARY:New Year's Day",
			"DTSTART;VALUE=DATE:20250101",
			"DTEND;VALUE=DATE:20250101",
		),
	);

	assert.equal(holiday!.start, "2025-01-01");
	assert.equal(holiday!.end, "2025-01-01");
	assert.equal(holiday!.isMultiDay, false);
});
