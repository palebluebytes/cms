/**
 * Reading RFC 5545 text into properties, and one property into a time.
 *
 * Internal. Not reachable through the package's export map.
 *
 * THE SEAM: text in, a list of `VEVENT`s as raw properties out, plus whatever
 * the `VCALENDAR` itself said. Nothing here knows what an event IS — no
 * `summary`, no inclusive end, no recurrence. That belongs to the provider and
 * to `../shared.ts`, so this module can be read for one question only: does it
 * take the file apart correctly?
 *
 * WHY BY HAND. A dependency is not available (`docs/agents/runtime-audience.md`),
 * and the subset that matters here is small: unfolding, parameters, escaped
 * text, and the four ways a date can be written. What is NOT small is
 * recurrence, which is why it is `./recurrence.ts` and not this file.
 */

import type { EventKind } from "../shared.js";

/** One property line, taken apart but not interpreted. */
export interface IcsProperty {
	/** Upper-cased: `DTSTART`, `SUMMARY`, `X-WR-TIMEZONE`. */
	name: string;
	/** Upper-cased keys, values as written minus any surrounding quotes. */
	params: Record<string, string>;
	/** The raw value, still escaped. `textValue` unescapes it. */
	value: string;
}

/** A file taken apart: the calendar's own properties, and each `VEVENT`'s. */
export interface IcsDocument {
	/** Properties directly on `VCALENDAR` — `X-WR-TIMEZONE` is the one read. */
	calendar: IcsProperty[];
	/** One entry per `VEVENT`, in the order the file listed them. */
	events: IcsProperty[][];
}

/** A time as the file stated it, and therefore which `kind` it is. */
export interface IcsTime {
	kind: EventKind;
	/**
	 * ISO-shaped: `YYYY-MM-DD` for a date, `YYYY-MM-DDTHH:MM:SS` for a wall
	 * time, with a trailing `Z` only when the file said `Z`. This is the string
	 * a consumer ends up holding.
	 */
	value: string;
	/** The `TZID`, when there was one. Not validated — see ADR-0005. */
	timeZone: string | undefined;
}

/**
 * Undo line folding, then split.
 *
 * A folded line continues on the next one, which begins with a space or a tab —
 * so splitting a file into lines without unfolding first CORRUPTS every long
 * `DESCRIPTION` in it, and does so silently, because the tail of the value
 * simply becomes a property name nobody asked about.
 *
 * `\r\n` is what the spec says; plenty of real files use `\n` alone.
 */
function unfoldedLines(text: string): string[] {
	return text
		.replace(/\r\n[ \t]/g, "")
		.replace(/\n[ \t]/g, "")
		.split(/\r\n|\n|\r/);
}

/**
 * `NAME;PARAM=value;OTHER="quoted:value":the value`
 *
 * The value is everything after the first colon that is not inside a quoted
 * parameter — a `DESCRIPTION` holding a URL is the ordinary case that breaks a
 * naive `split(":")`.
 */
function parseLine(line: string): IcsProperty | undefined {
	let quoted = false;
	let colon = -1;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') quoted = !quoted;
		else if (ch === ":" && !quoted) {
			colon = i;
			break;
		}
	}

	if (colon === -1) return undefined;

	const value = line.slice(colon + 1);
	const parts = splitParams(line.slice(0, colon));
	const name = parts[0]?.toUpperCase();
	if (!name) return undefined;

	const params: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).toUpperCase();
		params[key] = part.slice(eq + 1).replace(/^"|"$/g, "");
	}

	return { name, params, value };
}

/** Split on `;` except inside quotes, which may legally contain one. */
function splitParams(head: string): string[] {
	const parts: string[] = [];
	let quoted = false;
	let start = 0;

	for (let i = 0; i < head.length; i++) {
		const ch = head[i];
		if (ch === '"') quoted = !quoted;
		else if (ch === ";" && !quoted) {
			parts.push(head.slice(start, i));
			start = i + 1;
		}
	}

	parts.push(head.slice(start));
	return parts;
}

/**
 * Every `VEVENT` in the file, plus the calendar's own properties.
 *
 * Components are tracked as a STACK, not a flag, and the reason is `VALARM`: it
 * nests inside a `VEVENT`, and a flat "am I in an event" test would read the
 * alarm's own `TRIGGER` and `DESCRIPTION` as the event's. `VTIMEZONE`,
 * `VTODO`, `VJOURNAL` and `VFREEBUSY` are skipped whole.
 */
export function parseIcs(text: string): IcsDocument {
	const document: IcsDocument = { calendar: [], events: [] };
	const stack: string[] = [];
	let current: IcsProperty[] | undefined;

	for (const line of unfoldedLines(text)) {
		if (!line.trim()) continue;

		const property = parseLine(line);
		if (!property) continue;

		if (property.name === "BEGIN") {
			const component = property.value.toUpperCase();
			stack.push(component);
			if (component === "VEVENT") {
				current = [];
				document.events.push(current);
			}
			continue;
		}

		if (property.name === "END") {
			if (stack.pop() === "VEVENT") current = undefined;
			continue;
		}

		const innermost = stack[stack.length - 1];
		if (innermost === "VEVENT" && current) current.push(property);
		else if (innermost === "VCALENDAR") document.calendar.push(property);
	}

	return document;
}

/** The first property with this name, or `undefined`. */
export function property(
	properties: readonly IcsProperty[],
	name: string,
): IcsProperty | undefined {
	return properties.find((p) => p.name === name);
}

/** Every property with this name — `EXDATE` may legally appear more than once. */
export function properties(
	properties: readonly IcsProperty[],
	name: string,
): IcsProperty[] {
	return properties.filter((p) => p.name === name);
}

/**
 * A TEXT value with its escapes undone: `\n` and `\N` are newlines, and `\\`,
 * `\,` and `\;` are the characters themselves.
 *
 * Order matters — unescaping `\\` first would turn the literal backslash of
 * `\\n` into an escape and eat the following `n`. So one pass, left to right.
 */
export function textValue(property: IcsProperty | undefined): string {
	if (!property) return "";

	let out = "";
	for (let i = 0; i < property.value.length; i++) {
		const ch = property.value[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}

		const next = property.value[++i];
		if (next === "n" || next === "N") out += "\n";
		else if (next === undefined) out += "\\";
		else out += next;
	}

	return out;
}

/**
 * One `DTSTART`/`DTEND`/`RECURRENCE-ID` as the four forms of RFC 5545, which is
 * exactly `EventKind` — see `docs/adr/0005-an-events-time-is-a-kind-not-a-boolean.md`.
 *
 *   VALUE=DATE:20990613            → "date",     2099-06-13
 *   :20990304T190000Z              → "instant",  2099-03-04T19:00:00Z
 *   :20990304T190000               → "floating", 2099-03-04T19:00:00
 *   TZID=Europe/London:...T190000  → "zoned",    2099-03-04T19:00:00 + zone
 *
 * A `TZID` alongside a trailing `Z` is contradictory; the `Z` wins, because it
 * is the half that names an actual moment.
 *
 * Throws on a value it cannot read. A date this module guessed at would become
 * an event on the wrong day, which is the failure mode the whole package is
 * built to refuse.
 */
export function icsTime(property: IcsProperty): IcsTime {
	const raw = property.value.trim();
	const timeZone = property.params["TZID"];

	const date = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
	if (date) {
		return {
			kind: "date",
			value: `${date[1]}-${date[2]}-${date[3]}`,
			timeZone: undefined,
		};
	}

	const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(
		raw,
	);
	if (dateTime) {
		const [, y, m, d, hh, mm, ss, utc] = dateTime;
		const value = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;

		if (utc)
			return { kind: "instant", value: `${value}Z`, timeZone: undefined };
		if (timeZone) return { kind: "zoned", value, timeZone };
		return { kind: "floating", value, timeZone: undefined };
	}

	throw new Error(
		`Could not read ${property.name} "${raw}" as an iCalendar date or ` +
			`date-time. Refusing to guess: a misread date is an event on the wrong ` +
			`day, which nothing downstream would catch.`,
	);
}

/** The `YYYY-MM-DD` of a time, whatever its kind. */
export function dayOf(time: Pick<IcsTime, "value">): string {
	return time.value.slice(0, 10);
}

/**
 * A key that sorts and compares two times of the SAME shape correctly.
 *
 * The trailing `Z` is dropped rather than resolved: `UNTIL` and `EXDATE` are
 * compared against instances of the same event, written the same way by the
 * same client, so what matters is that the comparison is total and stable — not
 * that it is meaningful across zones, which no key could be without inventing
 * an offset.
 */
export function timeKey(time: Pick<IcsTime, "value">): string {
	return time.value.replace(/Z$/, "");
}

/**
 * `P3D`, `PT2H30M`, `P1W` — the `DURATION` a `VEVENT` may carry INSTEAD of a
 * `DTEND`. Legal, common in Apple's exports, and an event whose end is silently
 * dropped for want of reading it looks exactly like an instantaneous one.
 *
 * Returns the span in whole days and in seconds-within-the-day, kept separate
 * on purpose: days are calendar arithmetic and seconds are clock arithmetic,
 * and mixing them is what makes a zoned event drift across a DST boundary.
 */
export function parseDuration(value: string): {
	days: number;
	seconds: number;
} {
	const match =
		/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
			value.trim(),
		);

	if (!match) {
		throw new Error(
			`Could not read DURATION "${value}". Refusing to guess at an event's ` +
				`length.`,
		);
	}

	const [, negative, weeks, days, hours, minutes, seconds] = match;
	const sign = negative ? -1 : 1;
	const number = (part: string | undefined) => (part ? Number(part) : 0);

	// `+ 0` only to keep a negative zero out of the result: `-1 * 0` is `-0`,
	// which is equal to `0` everywhere except in a deep-equal assertion.
	return {
		days: sign * (number(weeks) * 7 + number(days)) + 0,
		seconds:
			sign * (number(hours) * 3600 + number(minutes) * 60 + number(seconds)) +
			0,
	};
}
