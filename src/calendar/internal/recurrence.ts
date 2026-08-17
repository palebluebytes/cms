/**
 * Expanding an `RRULE` into the instances it stands for.
 *
 * Internal. Not reachable through the package's export map.
 *
 * WHY THIS EXISTS AT ALL: a consumer never receiving an unexpanded series is
 * this package's guarantee, and Google satisfies it server-side for free with
 * `singleEvents=true`. A provider reading a file has no server, so it does the
 * work here —
 * `docs/adr/0006-expansion-is-a-guarantee-and-a-window-terminates-it.md`.
 *
 * NO CLOCK, NO ZONE, and that is not an accident of implementation: expansion
 * moves the DATE part of a start and never its time of day. "Weekly at 19:00"
 * means the 19:00 the file wrote, in whatever form it wrote it, seven days
 * later. So a floating time stays floating, a zoned time stays in its zone, and
 * `Z` stays `Z` — none of which needs to know what any of them means in
 * minutes.
 *
 * The `Date` in here is arithmetic scaffolding on a UTC-pinned date string, the
 * same trick and the same rule as `inclusiveEnd`: it never escapes.
 */

import { addDays } from "../shared.ts";
import { dayOf, timeKey, type IcsTime } from "./ics-parse.ts";

/**
 * A backstop, not a budget. An unbounded rule against a wide window is a real
 * request; ten thousand instances from one `VEVENT` is a rule this expander has
 * misread, and looping or truncating would both be worse than saying so.
 */
const MAX_INSTANCES = 10_000;

/** `SU`..`SA` in the order `Date#getUTCDay` uses. */
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * The parts of an `RRULE` this expander implements. Everything else throws, by
 * name — see `expand`.
 */
const SUPPORTED = new Set([
	"FREQ",
	"INTERVAL",
	"COUNT",
	"UNTIL",
	"BYDAY",
	"WKST",
]);

const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

export interface ExpandOptions {
	/** The series' own start, which is always its first candidate instance. */
	start: IcsTime;
	/** `RRULE` value, without the property name. */
	rule: string;
	/** `EXDATE` keys (`timeKey`), removed AFTER the rule has produced its set. */
	excluded?: ReadonlySet<string>;
	/**
	 * The window's far end, as `YYYY-MM-DD`. Required for a rule with neither
	 * `COUNT` nor `UNTIL`, because there is otherwise nothing to expand into.
	 */
	toDay?: string;
}

/** `KEY=VALUE;KEY=VALUE` → a map, upper-cased keys. */
function parseRule(rule: string): Map<string, string> {
	const parts = new Map<string, string>();

	for (const part of rule.split(";")) {
		if (!part.trim()) continue;
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		parts.set(
			part.slice(0, eq).trim().toUpperCase(),
			part.slice(eq + 1).trim(),
		);
	}

	return parts;
}

/** The day-of-month a `YYYY-MM-DD` names, as a number. */
function dayOfMonth(day: string): number {
	return Number(day.slice(8, 10));
}

/**
 * Step whole months or years while KEEPING the day of the month, and report
 * when that day does not exist in the month landed on.
 *
 * The 31st of a 30-day month, and 29 February of a common year, are the two
 * cases. RFC 5545 says an invalid date is SKIPPED — not clamped to the 30th,
 * which would invent an instance on a day the rule never named.
 */
function stepMonths(day: string, months: number): string | undefined {
	const year = Number(day.slice(0, 4));
	const month = Number(day.slice(5, 7)) - 1;
	const date = dayOfMonth(day);

	const target = new Date(Date.UTC(year, month + months, 1));
	target.setUTCDate(date);

	// Rolling over into the next month is how `Date` reports "no such day".
	if (target.getUTCDate() !== date) return undefined;
	return target.toISOString().slice(0, 10);
}

/** The `SU`..`SA` code for a `YYYY-MM-DD`. */
function weekdayOf(day: string): string {
	return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
}

/** Move back to the most recent `WKST` day, so week blocks line up. */
function startOfWeek(day: string, weekStart: string): string {
	let cursor = day;
	// At most six steps; a loop rather than modular arithmetic because the
	// weekday codes are the spec's order and not a number a caller supplied.
	for (let i = 0; i < 7 && weekdayOf(cursor) !== weekStart; i++) {
		cursor = addDays(cursor, -1);
	}
	return cursor;
}

/**
 * Every instance of a recurring series, as starts.
 *
 * Only the start is returned: an instance's end is the series' own span applied
 * to its start, which is the provider's job because only it knows the span.
 *
 * THROWS, and both refusals are the point rather than an inconvenience:
 *
 * - **A part this expander does not implement** — `BYMONTHDAY`, `BYSETPOS`, an
 *   ordinal `BYDAY` like `2MO`, a sub-daily `FREQ`. Half a series missing
 *   renders as a calendar that is merely quiet, and nothing downstream can tell
 *   that from a calendar with fewer events in it.
 * - **An unbounded rule with no window.** No `COUNT`, no `UNTIL` and no `toDay`
 *   has no answer; picking "now" would put a clock in a pure function and make
 *   the output depend on when the build ran.
 */
export function expand({
	start,
	rule,
	excluded,
	toDay,
}: ExpandOptions): IcsTime[] {
	const parts = parseRule(rule);

	for (const key of parts.keys()) {
		if (!SUPPORTED.has(key)) {
			throw new Error(
				`This iCalendar reader does not implement RRULE ${key} (in ` +
					`"${rule}"). Refusing to expand a series it would get wrong: a ` +
					`missing instance looks exactly like an event nobody scheduled.`,
			);
		}
	}

	const frequency = (parts.get("FREQ") ?? "").toUpperCase();
	if (!FREQUENCIES.has(frequency)) {
		throw new Error(
			`This iCalendar reader does not implement RRULE FREQ=${frequency || "(absent)"} ` +
				`(in "${rule}"). Daily, weekly, monthly and yearly are supported.`,
		);
	}

	const byDay = parts.get("BYDAY")?.toUpperCase();
	if (byDay) {
		if (frequency !== "WEEKLY") {
			throw new Error(
				`This iCalendar reader implements BYDAY only with FREQ=WEEKLY, not ` +
					`FREQ=${frequency} (in "${rule}").`,
			);
		}
		if (/[0-9+-]/.test(byDay)) {
			throw new Error(
				`This iCalendar reader does not implement an ordinal BYDAY like ` +
					`"${byDay}" (in "${rule}") — only plain weekdays.`,
			);
		}
	}

	const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : undefined;
	const untilRaw = parts.get("UNTIL");
	const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;

	if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
		throw new Error(
			`RRULE COUNT must be a positive whole number (in "${rule}").`,
		);
	}
	if (!Number.isInteger(interval) || interval < 1) {
		throw new Error(
			`RRULE INTERVAL must be a positive whole number (in "${rule}").`,
		);
	}

	if (count === undefined && !untilRaw && !toDay) {
		throw new Error(
			`"${rule}" never ends, and no window was given to expand it into. Pass ` +
				`\`to\` (the window's far end) — this reader will not choose one, ` +
				`because "now" is the site's to decide and a normaliser has no clock.`,
		);
	}

	// UNTIL is compared against instance starts written by the same client, so a
	// text key is enough and is all that is available without inventing offsets.
	const untilKey = untilRaw
		? timeKey({ value: normaliseUntil(untilRaw) })
		: undefined;

	const time = start.value.slice(10); // "", "T19:00:00" or "T19:00:00Z"
	const at = (day: string): IcsTime => ({
		kind: start.kind,
		value: `${day}${time}`,
		timeZone: start.timeZone,
	});

	const startDay = dayOf(start);
	const days: string[] = [];

	/** Beyond the window, or beyond `UNTIL`: no later day can be an instance. */
	const past = (day: string) => {
		if (toDay && day > toDay) return true;
		if (untilKey && timeKey({ value: `${day}${time}` }) > untilKey) return true;
		return false;
	};

	/** `COUNT` is the rule's own limit, applied before `EXDATE` removes any. */
	const enough = () => count !== undefined && days.length >= count;

	if (frequency === "WEEKLY" && byDay) {
		const wanted = byDay.split(",").map((day) => day.trim());
		const weekStart = (parts.get("WKST") ?? "MO").toUpperCase();

		// Week blocks are counted from the WKST day, not from DTSTART: with
		// INTERVAL=2 the skipped week is a calendar week, so where the week
		// begins decides which days land in which block.
		let week = startOfWeek(startDay, weekStart);

		blocks: for (let block = 0; !enough(); block++) {
			if (block > MAX_INSTANCES) throw tooMany(rule);
			if (past(week)) break;

			for (let offset = 0; offset < 7 && !enough(); offset++) {
				const day = addDays(week, offset);
				if (!wanted.includes(weekdayOf(day))) continue;
				// The first block starts before DTSTART whenever DTSTART is not
				// itself the WKST day; those earlier weekdays are not instances.
				if (day < startDay) continue;
				if (past(day)) break blocks;
				days.push(day);
			}

			week = addDays(week, 7 * interval);
		}
	} else {
		const firstOfStartMonth = `${startDay.slice(0, 8)}01`;

		for (let n = 0; !enough(); n++) {
			if (n > MAX_INSTANCES) throw tooMany(rule);

			const months = frequency === "MONTHLY" ? n * interval : n * 12 * interval;

			const day =
				frequency === "DAILY"
					? addDays(startDay, n * interval)
					: frequency === "WEEKLY"
						? addDays(startDay, n * 7 * interval)
						: stepMonths(startDay, months);

			// A skipped 31st or 29 February. Not an instance — and not the end of
			// the series either, so the window test has to fall back to the month
			// itself, whose first day always exists.
			if (day === undefined) {
				if (past(stepMonths(firstOfStartMonth, months)!)) break;
				continue;
			}

			if (past(day)) break;
			days.push(day);
		}
	}

	const keep = excluded
		? days.filter((day) => !excluded.has(timeKey({ value: `${day}${time}` })))
		: days;

	return keep.map(at);
}

function tooMany(rule: string): Error {
	return new Error(
		`"${rule}" produced more than ${MAX_INSTANCES} instances. That is a rule ` +
			`this reader has misread rather than a series that long — refusing to ` +
			`loop or to truncate.`,
	);
}

/**
 * `UNTIL` is written as a date or a date-time, and a bare date has to compare
 * against instances that carry a time — so it is stretched to the end of its
 * day rather than to its midnight, which would drop an instance ON the last day.
 */
function normaliseUntil(raw: string): string {
	const value = raw.trim();

	const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
	if (date) return `${date[1]}-${date[2]}-${date[3]}T23:59:59`;

	const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(
		value,
	);
	if (dateTime) {
		const [, y, m, d, hh, mm, ss] = dateTime;
		return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
	}

	throw new Error(
		`Could not read RRULE UNTIL "${raw}" as a date or date-time. Refusing to ` +
			`guess at where a series stops.`,
	);
}
