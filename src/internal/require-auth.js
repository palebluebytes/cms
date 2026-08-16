/**
 * Internal. Not reachable through the package's export map.
 *
 * `auth` is required on every call. Passing nothing throws immediately, with a
 * message naming the constructors — because the alternative is an unauthorised
 * request and a 403 from Google that says nothing about which of the caller's
 * three options it should have used.
 *
 * @param {unknown} auth
 * @param {string} caller The function name, so the message says where to look.
 * @returns {asserts auth is import("../auth.js").Auth}
 */
export function requireAuth(auth, caller) {
	if (typeof auth !== "function") {
		throw new Error(
			`${caller}() needs an \`auth\` option — pass apiKey(key) or ` +
				`bearer(token) from "@palebluebytes/google-cms/auth", or any ` +
				`function from Request to authorised Request.`,
		);
	}
}
