// `.js`, not `.ts`, and only because this import is type-only: the specifier
// survives into the emitted `.d.ts` verbatim (`rewriteRelativeImportExtensions`
// rewrites the value imports, not these), and a published declaration file must
// not point at a `.ts` that does not ship. Node erases the line entirely, so
// nothing resolves it at runtime.
import type { Auth } from "../auth.js";

/**
 * Internal. Not reachable through the package's export map.
 *
 * `auth` is required on every call. Passing nothing throws immediately, with a
 * message naming the constructors — because the alternative is an unauthorised
 * request and a 403 from Google that says nothing about which of the caller's
 * three options it should have used.
 *
 * The option types already say `auth` is required; this is the same guard for
 * the JS caller the types never reach.
 *
 * @param caller The function name, so the message says where to look.
 */
export function requireAuth(
	auth: unknown,
	caller: string,
): asserts auth is Auth {
	if (typeof auth !== "function") {
		throw new Error(
			`${caller}() needs an \`auth\` option — pass apiKey(key) or ` +
				`bearer(token) from "@palebluebytes/cms/auth", or any ` +
				`function from Request to authorised Request.`,
		);
	}
}
