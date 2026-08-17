/**
 * A recorder for anything a normaliser might say out loud.
 *
 * The normalisers' only effect is their return value
 * (`docs/adr/0002-the-normalisers-report-nothing.md`), and `console` is in
 * `lib.dom` — so a call to it compiles clean inside `src` and no test would
 * otherwise fail. This is the guard, and it is shared because the rule covers
 * both normalisers rather than one.
 *
 * It mutates a global, which the deleted `captureWarnings` helper did too. The
 * difference is the direction: that one reached around the seam to observe
 * something escaping through it, and this one holds the mutation for a single
 * call to establish that nothing does.
 */

// Every method a normaliser might plausibly reach for. `console.warn` was the one
// that actually got in.
const METHODS = ["warn", "log", "error", "info", "debug"] as const;

/**
 * The names of the `console` methods `during` called, in order — `[]` when it
 * said nothing.
 *
 * Restores the real `console` even if `during` throws, so one failing assertion
 * cannot silence the rest of the run.
 */
export function recordConsole(during: () => void): string[] {
	const real = METHODS.map((method) => console[method]);
	const called: string[] = [];

	for (const method of METHODS) console[method] = () => called.push(method);

	try {
		during();
	} finally {
		METHODS.forEach((method, i) => (console[method] = real[i]));
	}

	return called;
}
