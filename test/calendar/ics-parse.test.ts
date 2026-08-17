import test from "node:test";
import assert from "node:assert/strict";

import {
	icsTime,
	parseDuration,
	parseIcs,
	properties,
	property,
	textValue,
} from "../../src/calendar/internal/ics-parse.ts";

// Taking an .ics file apart. Nothing here knows what an event MEANS — no
// inclusive end, no recurrence, no `CalendarEvent`. Those are the provider's and
// are tested through it.

/** A minimal file with one VEVENT holding the given lines. */
function file(...lines: string[]): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		...lines,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

// -------------------------------------------------------------- taking it apart

test("unfolds a folded line, consuming the fold's whitespace and no more", () => {
	// A continuation line begins with a space or tab, and unfolding removes the
	// line break AND THAT ONE CHARACTER (RFC 5545 §3.1) — so a space belonging to
	// the value is written twice by whoever folded it. Getting this wrong the
	// other way inserts a space into every long DESCRIPTION in the file.
	//
	// Splitting without unfolding at all is the worse failure: the tail of the
	// value becomes a property name nobody asked about, and the value is
	// silently truncated.
	const document = parseIcs(
		file(
			"DESCRIPTION:A long description that the c",
			" lient folded mid-word.",
		),
	);

	assert.equal(
		textValue(property(document.events[0]!, "DESCRIPTION")),
		"A long description that the client folded mid-word.",
	);
});

test("unfolds a tab continuation, and a file with bare newlines", () => {
	// Two spaces: the first is the fold marker, the second is the value's.
	const document = parseIcs(
		"BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:One\n\t two\nEND:VEVENT\nEND:VCALENDAR",
	);

	assert.equal(textValue(property(document.events[0]!, "SUMMARY")), "One two");
});

test("keeps a colon inside a value", () => {
	// The value is everything after the FIRST colon; a URL has more.
	const document = parseIcs(file("URL:https://example.test/a:b"));

	assert.equal(
		property(document.events[0]!, "URL")?.value,
		"https://example.test/a:b",
	);
});

test("reads parameters, including a quoted one carrying a colon", () => {
	const document = parseIcs(
		file('DTSTART;TZID="Europe/London";X-ODD="a:b;c":20990304T190000'),
	);
	const dtstart = property(document.events[0]!, "DTSTART")!;

	assert.equal(dtstart.params["TZID"], "Europe/London");
	assert.equal(dtstart.params["X-ODD"], "a:b;c");
	assert.equal(dtstart.value, "20990304T190000");
});

test("undoes text escapes, and a literal backslash before an n", () => {
	const document = parseIcs(
		file(String.raw`DESCRIPTION:Line\nnext\, then\; end\\done\\nliteral`),
	);

	assert.equal(
		textValue(property(document.events[0]!, "DESCRIPTION")),
		"Line\nnext, then; end\\done\\nliteral",
	);
});

test("a VALARM inside a VEVENT does not lend it its properties", () => {
	// VALARM nests, and it carries DESCRIPTION and TRIGGER of its own. A flat
	// "am I inside an event" flag reads the alarm's text as the event's.
	const document = parseIcs(
		file(
			"SUMMARY:Real summary",
			"BEGIN:VALARM",
			"TRIGGER:-PT15M",
			"DESCRIPTION:Alarm text",
			"END:VALARM",
		),
	);

	assert.equal(
		textValue(property(document.events[0]!, "SUMMARY")),
		"Real summary",
	);
	assert.equal(property(document.events[0]!, "DESCRIPTION"), undefined);
	assert.equal(property(document.events[0]!, "TRIGGER"), undefined);
});

test("skips components that are not events, and keeps the calendar's own", () => {
	const document = parseIcs(
		[
			"BEGIN:VCALENDAR",
			"X-WR-TIMEZONE:Europe/London",
			"BEGIN:VTIMEZONE",
			"TZID:Europe/London",
			"BEGIN:DAYLIGHT",
			"TZOFFSETTO:+0100",
			"END:DAYLIGHT",
			"END:VTIMEZONE",
			"BEGIN:VTODO",
			"SUMMARY:Not an event",
			"END:VTODO",
			"BEGIN:VEVENT",
			"SUMMARY:An event",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n"),
	);

	assert.equal(document.events.length, 1);
	assert.equal(textValue(property(document.events[0]!, "SUMMARY")), "An event");
	assert.equal(
		textValue(property(document.calendar, "X-WR-TIMEZONE")),
		"Europe/London",
	);
	// The VTIMEZONE's own TZID must not have been collected as the calendar's.
	assert.equal(property(document.calendar, "TZOFFSETTO"), undefined);
});

test("collects every EXDATE, not just the first", () => {
	const document = parseIcs(
		file("EXDATE:20990408T180000Z", "EXDATE:20990415T180000Z"),
	);

	assert.deepEqual(
		properties(document.events[0]!, "EXDATE").map((p) => p.value),
		["20990408T180000Z", "20990415T180000Z"],
	);
});

// ------------------------------------------------------------ the four forms

test("reads each of RFC 5545's four time forms as its kind", () => {
	const forms = parseIcs(
		file(
			"DTSTART;VALUE=DATE:20990613",
			"DTEND:20990304T190000Z",
			"RECURRENCE-ID:20990304T190000",
			"X-WALL;TZID=Europe/London:20990304T190000",
		),
	).events[0]!;

	assert.deepEqual(icsTime(property(forms, "DTSTART")!), {
		kind: "date",
		value: "2099-06-13",
		timeZone: undefined,
	});
	assert.deepEqual(icsTime(property(forms, "DTEND")!), {
		kind: "instant",
		value: "2099-03-04T19:00:00Z",
		timeZone: undefined,
	});
	assert.deepEqual(icsTime(property(forms, "RECURRENCE-ID")!), {
		kind: "floating",
		value: "2099-03-04T19:00:00",
		timeZone: undefined,
	});
	assert.deepEqual(icsTime(property(forms, "X-WALL")!), {
		kind: "zoned",
		value: "2099-03-04T19:00:00",
		timeZone: "Europe/London",
	});
});

test("a trailing Z wins over a TZID, because it is the half that names a moment", () => {
	const document = parseIcs(
		file("DTSTART;TZID=Europe/London:20990304T190000Z"),
	);

	assert.deepEqual(icsTime(property(document.events[0]!, "DTSTART")!), {
		kind: "instant",
		value: "2099-03-04T19:00:00Z",
		timeZone: undefined,
	});
});

test("refuses a date it cannot read rather than guessing at one", () => {
	const document = parseIcs(file("DTSTART:not-a-date"));

	assert.throws(
		() => icsTime(property(document.events[0]!, "DTSTART")!),
		/DTSTART "not-a-date".*wrong day/s,
	);
});

// ----------------------------------------------------------------- durations

test("reads a DURATION, keeping days and seconds apart", () => {
	assert.deepEqual(parseDuration("P3D"), { days: 3, seconds: 0 });
	assert.deepEqual(parseDuration("PT2H30M"), { days: 0, seconds: 9000 });
	assert.deepEqual(parseDuration("P1W"), { days: 7, seconds: 0 });
	assert.deepEqual(parseDuration("P1WT1H"), { days: 7, seconds: 3600 });
	assert.deepEqual(parseDuration("-PT1H"), { days: 0, seconds: -3600 });
});

test("refuses a DURATION it cannot read", () => {
	assert.throws(() => parseDuration("2 hours"), /DURATION "2 hours"/);
});
