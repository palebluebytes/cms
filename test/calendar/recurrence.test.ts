import test from "node:test";
import assert from "node:assert/strict";

import type { IcsTime } from "../../src/calendar/internal/ics-parse.ts";
import { expand } from "../../src/calendar/internal/recurrence.ts";

// Expanding an RRULE. The guarantee under test is that a consumer never receives
// an unexpanded series — Google gets it from `singleEvents`, a file-reading
// provider does it here.
//
// No clock and no zone anywhere: expansion moves the DATE part of a start and
// never its time of day, which is why a floating time can recur at all.

/** 1 April 2099 is a Wednesday; 18:00 UTC. */
const WEDNESDAY: IcsTime = {
	kind: "instant",
	value: "2099-04-01T18:00:00Z",
	timeZone: undefined,
};

const starts = (times: IcsTime[]) => times.map((t) => t.value);

// ------------------------------------------------------------------- the rules

test("a COUNT-bounded weekly series expands with no window and no clock", () => {
	const instances = expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;COUNT=3" });

	assert.deepEqual(starts(instances), [
		"2099-04-01T18:00:00Z",
		"2099-04-08T18:00:00Z",
		"2099-04-15T18:00:00Z",
	]);
});

test("the time of day rides along untouched, whatever form it is in", () => {
	// The point of moving only the date part: a floating time stays floating and
	// a zoned one stays in its zone, without this module knowing what either
	// means in minutes.
	const floating = expand({
		start: {
			kind: "floating",
			value: "2099-04-01T19:30:00",
			timeZone: undefined,
		},
		rule: "FREQ=DAILY;COUNT=2",
	});
	const zoned = expand({
		start: {
			kind: "zoned",
			value: "2099-04-01T19:30:00",
			timeZone: "Europe/London",
		},
		rule: "FREQ=DAILY;COUNT=2",
	});

	assert.deepEqual(starts(floating), [
		"2099-04-01T19:30:00",
		"2099-04-02T19:30:00",
	]);
	assert.equal(floating[1]!.kind, "floating");
	assert.equal(floating[1]!.timeZone, undefined);

	assert.deepEqual(starts(zoned), [
		"2099-04-01T19:30:00",
		"2099-04-02T19:30:00",
	]);
	assert.equal(zoned[1]!.kind, "zoned");
	assert.equal(zoned[1]!.timeZone, "Europe/London");
});

test("an all-day series recurs as dates", () => {
	const instances = expand({
		start: { kind: "date", value: "2099-04-01", timeZone: undefined },
		rule: "FREQ=WEEKLY;COUNT=2",
	});

	assert.deepEqual(starts(instances), ["2099-04-01", "2099-04-08"]);
	assert.equal(instances[0]!.kind, "date");
});

test("INTERVAL skips periods", () => {
	assert.deepEqual(
		starts(expand({ start: WEDNESDAY, rule: "FREQ=DAILY;INTERVAL=3;COUNT=3" })),
		["2099-04-01T18:00:00Z", "2099-04-04T18:00:00Z", "2099-04-07T18:00:00Z"],
	);
});

test("UNTIL on a bare date includes an instance on that day", () => {
	// A date-only UNTIL compared at midnight would drop the instance ON the last
	// day, which is the day a human writing the rule meant to include.
	assert.deepEqual(
		starts(expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;UNTIL=20990415" })),
		["2099-04-01T18:00:00Z", "2099-04-08T18:00:00Z", "2099-04-15T18:00:00Z"],
	);
});

test("UNTIL as a date-time stops at it", () => {
	assert.deepEqual(
		starts(
			expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;UNTIL=20990408T180000Z" }),
		),
		["2099-04-01T18:00:00Z", "2099-04-08T18:00:00Z"],
	);
});

test("BYDAY expands within the week, and INTERVAL counts calendar weeks", () => {
	// Wed 1 April, Mondays and Fridays, every other week. The Monday of the
	// first block is 30 March — BEFORE the series starts — so it is not an
	// instance, and the blocks are counted from WKST rather than from DTSTART.
	assert.deepEqual(
		starts(
			expand({
				start: WEDNESDAY,
				rule: "FREQ=WEEKLY;BYDAY=MO,FR;INTERVAL=2;COUNT=3",
			}),
		),
		[
			"2099-04-03T18:00:00Z", // Friday of the first block
			"2099-04-13T18:00:00Z", // Monday, two weeks on
			"2099-04-17T18:00:00Z", // Friday of that block
		],
	);
});

test("MONTHLY skips a month with no such day rather than clamping", () => {
	// 31 January monthly: February has no 31st. RFC 5545 says SKIP — clamping to
	// the 28th would invent an instance on a day the rule never named.
	assert.deepEqual(
		starts(
			expand({
				start: { kind: "date", value: "2099-01-31", timeZone: undefined },
				rule: "FREQ=MONTHLY;COUNT=3",
			}),
		),
		["2099-01-31", "2099-03-31", "2099-05-31"],
	);
});

test("YEARLY skips 29 February in a common year, century rule included", () => {
	// 2100 is NOT a leap year. A series from 29 February 2096 therefore skips
	// 2097-2103 entirely and lands next in 2104.
	assert.deepEqual(
		starts(
			expand({
				start: { kind: "date", value: "2096-02-29", timeZone: undefined },
				rule: "FREQ=YEARLY;COUNT=2",
			}),
		),
		["2096-02-29", "2104-02-29"],
	);
});

// -------------------------------------------------------------- the two windows

test("an unbounded rule expands into the window it is given", () => {
	assert.deepEqual(
		starts(
			expand({
				start: WEDNESDAY,
				rule: "FREQ=WEEKLY",
				toDay: "2099-04-20",
			}),
		),
		["2099-04-01T18:00:00Z", "2099-04-08T18:00:00Z", "2099-04-15T18:00:00Z"],
	);
});

test("an unbounded rule with no window throws, naming the option to pass", () => {
	// The alternative is choosing "now", which puts a clock in a pure function
	// and makes the output depend on when the build ran.
	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY" }),
		/never ends.*\bto\b.*no clock/s,
	);
});

// --------------------------------------------------------------------- EXDATE

test("EXDATE removes an instance, and COUNT counted before it did", () => {
	// RFC 5545 order: the rule produces COUNT occurrences, then EXDATE removes
	// from them. So excluding one leaves two, not three.
	const instances = expand({
		start: WEDNESDAY,
		rule: "FREQ=WEEKLY;COUNT=3",
		excluded: new Set(["2099-04-08T18:00:00"]),
	});

	assert.deepEqual(starts(instances), [
		"2099-04-01T18:00:00Z",
		"2099-04-15T18:00:00Z",
	]);
});

// ---------------------------------------------------------------- the refusals

test("refuses a rule part it does not implement, naming the part", () => {
	// Under-expanding is the failure this package exists to refuse: half a series
	// missing renders as a calendar that is merely quiet, and nothing downstream
	// can tell that from a calendar with fewer events in it.
	assert.throws(
		() =>
			expand({
				start: WEDNESDAY,
				rule: "FREQ=MONTHLY;BYMONTHDAY=13;COUNT=2",
			}),
		/does not implement RRULE BYMONTHDAY/,
	);

	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;BYSETPOS=1;COUNT=2" }),
		/does not implement RRULE BYSETPOS/,
	);
});

test("refuses an ordinal BYDAY, and BYDAY outside a weekly rule", () => {
	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=MONTHLY;BYDAY=2MO;COUNT=2" }),
		/BYDAY only with FREQ=WEEKLY/,
	);

	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;BYDAY=-1FR;COUNT=2" }),
		/ordinal BYDAY/,
	);
});

test("refuses a frequency it does not implement", () => {
	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=HOURLY;COUNT=2" }),
		/does not implement RRULE FREQ=HOURLY/,
	);

	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "COUNT=2" }),
		/FREQ=\(absent\)/,
	);
});

test("refuses a COUNT or INTERVAL that is not a positive whole number", () => {
	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;COUNT=0" }),
		/COUNT must be a positive whole number/,
	);

	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;INTERVAL=0;COUNT=2" }),
		/INTERVAL must be a positive whole number/,
	);
});

test("refuses an UNTIL it cannot read", () => {
	assert.throws(
		() => expand({ start: WEDNESDAY, rule: "FREQ=WEEKLY;UNTIL=soon" }),
		/UNTIL "soon"/,
	);
});

// ------------------------------------------------- checked against rrule.js
//
// The expectations below are NOT hand-derived. Every one was produced by
// rrule.js, the reference implementation, for the same DTSTART and rule, and
// this expander agreed with all of them. That matters because the tests above
// were written from the same reading of RFC 5545 as the code, so a misreading
// consistent across both would pass them; an independent implementation is the
// only thing that catches it.
//
// rrule.js is deliberately NOT a dependency here — its answers are baked in as
// golden values instead, so the suite keeps this evidence without the package
// gaining a devDependency it would otherwise never need. Re-derive them by
// running the same rules through rrule.js if one is ever disputed.

test("BYDAY across a week matches the reference implementation", () => {
	assert.deepEqual(
		starts(
			expand({
				start: WEDNESDAY,
				rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=8",
			}),
		),
		[
			"2099-04-01T18:00:00Z",
			"2099-04-03T18:00:00Z",
			"2099-04-06T18:00:00Z",
			"2099-04-08T18:00:00Z",
			"2099-04-10T18:00:00Z",
			"2099-04-13T18:00:00Z",
			"2099-04-15T18:00:00Z",
			"2099-04-17T18:00:00Z",
		],
	);
});

test("BYDAY with INTERVAL skips whole calendar weeks, not pairs of instances", () => {
	// The 2nd and the 14th, not the 2nd and the 7th: INTERVAL counts weeks, so
	// the week of the 6th is skipped entirely. This is the case a naive
	// "every other matching day" reading gets wrong.
	assert.deepEqual(
		starts(
			expand({
				start: WEDNESDAY,
				rule: "FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=2;COUNT=7",
			}),
		),
		[
			"2099-04-02T18:00:00Z",
			"2099-04-14T18:00:00Z",
			"2099-04-16T18:00:00Z",
			"2099-04-28T18:00:00Z",
			"2099-04-30T18:00:00Z",
			"2099-05-12T18:00:00Z",
			"2099-05-14T18:00:00Z",
		],
	);
});

test("WKST decides which days fall in which block, and changes the answer", () => {
	// The same rule under two week starts, giving two different sets — which is
	// why WKST cannot be ignored when INTERVAL is greater than 1. Sunday and
	// Monday are in the SAME week under WKST=SU and in ADJACENT weeks under
	// WKST=MO.
	const sunday = starts(
		expand({
			start: WEDNESDAY,
			rule: "FREQ=WEEKLY;BYDAY=SU,MO;INTERVAL=2;COUNT=6;WKST=SU",
		}),
	);
	const monday = starts(
		expand({
			start: WEDNESDAY,
			rule: "FREQ=WEEKLY;BYDAY=SU,MO;INTERVAL=2;COUNT=6;WKST=MO",
		}),
	);

	assert.deepEqual(sunday, [
		"2099-04-12T18:00:00Z",
		"2099-04-13T18:00:00Z",
		"2099-04-26T18:00:00Z",
		"2099-04-27T18:00:00Z",
		"2099-05-10T18:00:00Z",
		"2099-05-11T18:00:00Z",
	]);
	assert.deepEqual(monday, [
		"2099-04-05T18:00:00Z",
		"2099-04-13T18:00:00Z",
		"2099-04-19T18:00:00Z",
		"2099-04-27T18:00:00Z",
		"2099-05-03T18:00:00Z",
		"2099-05-11T18:00:00Z",
	]);
	assert.notDeepEqual(sunday, monday, "WKST must not be inert");
});

test("MONTHLY with INTERVAL crosses years, including a non-leap century", () => {
	assert.deepEqual(
		starts(
			expand({ start: WEDNESDAY, rule: "FREQ=MONTHLY;INTERVAL=4;COUNT=5" }),
		),
		[
			"2099-04-01T18:00:00Z",
			"2099-08-01T18:00:00Z",
			"2099-12-01T18:00:00Z",
			"2100-04-01T18:00:00Z",
			"2100-08-01T18:00:00Z",
		],
	);
});

test("a 31st monthly lands only in the months that have one", () => {
	assert.deepEqual(
		starts(
			expand({
				start: {
					kind: "instant",
					value: "2099-03-31T12:00:00Z",
					timeZone: undefined,
				},
				rule: "FREQ=MONTHLY;COUNT=6",
			}),
		),
		[
			"2099-03-31T12:00:00Z",
			"2099-05-31T12:00:00Z",
			"2099-07-31T12:00:00Z",
			"2099-08-31T12:00:00Z",
			"2099-10-31T12:00:00Z",
			"2099-12-31T12:00:00Z",
		],
	);
});
