import test from "node:test";
import assert from "node:assert/strict";

import { addDays, inclusiveEnd } from "../../src/calendar/shared.ts";

// What every calendar provider shares. These are the rules that MUST NOT differ
// between providers — a disagreement here renders as the same event on two
// different days depending on which entry point a site imported.

test("addDays counts calendar days, forwards and back, across a month", () => {
	assert.equal(addDays("2099-06-13", 3), "2099-06-16");
	assert.equal(addDays("2099-06-17", -1), "2099-06-16");
	assert.equal(addDays("2099-01-31", 1), "2099-02-01");
	assert.equal(addDays("2099-03-01", -1), "2099-02-28");
});

test("addDays crosses a leap day only when the year has one", () => {
	// 2100 is not a leap year, by the century rule.
	assert.equal(addDays("2096-02-28", 1), "2096-02-29");
	assert.equal(addDays("2100-02-28", 1), "2100-03-01");
});

// ------------------------------------------------------------- inclusiveEnd

test("an exclusive end is stepped back to the last day it covers", () => {
	// The spec's form, and what Google writes: a 13th-to-16th event states the
	// 17th.
	assert.equal(inclusiveEnd("2099-06-17", "2099-06-13"), "2099-06-16");
	// A single day stated exclusively.
	assert.equal(inclusiveEnd("2099-09-22", "2099-09-21"), "2099-09-21");
});

test("an end EQUAL to the start is a one-day event, not a step back", () => {
	// Calendar Labs writes DTEND == DTSTART for every one-day holiday in its
	// feed, where Google writes the next day. Stepping an equal end back invents
	// an event ending the day BEFORE it starts — "1 January 2025 – 31 December
	// 2024" on the page, with no error anywhere.
	assert.equal(inclusiveEnd("2025-01-01", "2025-01-01"), "2025-01-01");
});

test("an end BEFORE the start throws rather than picking one to believe", () => {
	assert.throws(
		() => inclusiveEnd("2099-06-10", "2099-06-13"),
		/ends on 2099-06-10, before it starts on 2099-06-13/,
	);
});
