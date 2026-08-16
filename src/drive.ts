/**
 * Reading a folder of files out of Google Drive: the transport, the pure
 * normaliser that turns its payload into something a page can lay out, and the
 * one delivery primitive that works under every auth model.
 *
 * Nothing here filters, orders or formats. Which files you want, what order they
 * go in and what they are called on the page are the caller's decisions — see
 * the README's "What this package does not do".
 */

// The type-only import says `.js` and the value import says `.ts`, deliberately:
// see the note in `internal/require-auth.ts`.
import type { Auth, FetchLike } from "./auth.js";
import { requireAuth } from "./internal/require-auth.ts";

// Everything a gallery needs, in ONE listing call. `imageMediaMetadata` rides
// along with only an API key, so build-time aspect ratios cost no extra request
// — that is the finding this package exists to carry, and no other package in
// any ecosystem asks for it. `webContentLink` comes along for the same price.
const BASE_FIELDS = [
	"id",
	"name",
	"description",
	"mimeType",
	"modifiedTime",
	"webContentLink",
	"imageMediaMetadata(width,height,rotation)",
];

// The API's ceiling for files.list.
const PAGE_SIZE = 1000;

// A backstop, not a budget: 10 x 1000 files is far past any folder a human
// curates, so tripping it means the walk is not terminating rather than that the
// folder is big. Failing loudly beats looping forever or truncating silently.
const MAX_PAGES = 10;

/**
 * Drive's `imageMediaMetadata`, in the STORED orientation. Every field is
 * optional because Drive omits the block entirely for a non-image, and omits
 * `rotation` for an image that carries no EXIF orientation.
 */
export interface ImageMediaMetadata {
	width?: number;
	height?: number;
	/** Quarter-turns clockwise. An ODD value means the axes are swapped. */
	rotation?: number;
}

/**
 * A raw `files.list` entry under this package's field mask — the shape a
 * checked-in fixture has, and what `normalisePhotos` interprets.
 */
export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	description?: string;
	webContentLink?: string;
	imageMediaMetadata?: ImageMediaMetadata;
	/** Whatever `extraFields` asked for: the mask is the caller's to extend. */
	[field: string]: unknown;
}

/** The raw `files.list` body, as `listFiles` hands it on. */
export interface DriveFilesPayload {
	files?: DriveFile[];
	/**
	 * Present only while the walk is in progress — `listFiles` exhausts it. It is
	 * modelled here rather than cast in at the call site because leaving it out of
	 * the field mask is the silent-truncation trap AGENTS.md is built around; a
	 * type that does not mention it invites the same omission.
	 */
	nextPageToken?: string;
}

/** A file, as this package hands it over. */
export interface Photo {
	/** Drive file id. */
	id: string;
	/** Filename, extension included, exactly as Drive has it. */
	name: string;
	/**
	 * Always returned, NEVER filtered on — which types you show is a site
	 * decision, so pass `extraQuery` or filter the result.
	 */
	mimeType: string;
	/** RFC3339. The only cache-busting input a consumer needs. */
	modifiedTime: string;
	/** Drive's description field, trimmed; `""` when unset. The raw field, not the caption. */
	description: string;
	/**
	 * Never empty: `description || name`. Guaranteed non-empty so a consumer can
	 * safely render `alt=""` and let a figcaption be the text alternative.
	 * Refining `name` into something prettier is a site convention and stays
	 * with the site.
	 */
	caption: string;
	/**
	 * DISPLAYED pixels — axes already swapped when the EXIF rotation is odd.
	 * `null` when Drive returns no `imageMediaMetadata`.
	 */
	width: number | null;
	/** DISPLAYED pixels. See `width`. */
	height: number | null;
	/**
	 * DISPLAYED width/height. Falls back to 1 when dimensions are missing —
	 * which is why `ratio` is never null while `width`/`height` can be: a 1:1
	 * fallback is a stated assumption a consumer can lay out against, whereas
	 * fabricated pixel counts would be a lie it cannot detect.
	 */
	ratio: number;
	/**
	 * Quarter-turns clockwise as Drive reported them, 0 when absent. Kept only
	 * so a consumer can tell a swap happened.
	 */
	rotation: number;
	/**
	 * `webContentLink` — credential-free, permanent, deterministic from the id,
	 * and serves the byte-identical original.
	 *
	 * READ THE PREDICATE: it resolves only for PUBLICLY SHARED files. Not "when
	 * you used an API key" — that is only accidentally true, because a key can
	 * never see anything else. A service-account consumer reading a private
	 * folder gets this field populated and it answers `200 text/html` with a
	 * sign-in page. `fetchBytes` is the path that always works; `url` is the
	 * optimisation that skips a download.
	 */
	url: string | undefined;
}

export interface DriveOptions {
	folderId: string;
	/** Required. */
	auth: Auth;
	/**
	 * Defaults to the global. The integration-test seam; for unit tests prefer
	 * `normalisePhotos` and skip the network entirely.
	 */
	fetch?: FetchLike;
	/** MERGED into the field list, never replacing it. */
	extraFields?: string[];
	/** AND-ed onto the base `q`, never replacing it. */
	extraQuery?: string;
	/** Backstop on the page walk. Defaults to 10. */
	maxPages?: number;
}

/**
 * The raw `files.list` payload, paginated to exhaustion. Network, no
 * interpretation.
 *
 * `orderBy=name` is set for a deterministic walk. That is transport
 * correctness, not presentation — the returned order carries no meaning and
 * consumers sort.
 */
export async function listFiles({
	folderId,
	auth,
	fetch: fetchImpl = globalThis.fetch,
	extraFields = [],
	extraQuery,
	maxPages = MAX_PAGES,
}: DriveOptions): Promise<{ files: DriveFile[] }> {
	requireAuth(auth, "listFiles");

	// The folder and the trash are all this package decides. WHICH files you want
	// — images only, a name pattern — arrives as `extraQuery`, AND-ed on rather
	// than replacing, so nothing here can be lost by asking for more.
	// (`@localnerve/google-drive-folder`'s `fileQuery` replaces its own
	// `trashed = false` default; that trap is worth not reproducing.)
	const clauses = [`'${folderId}' in parents`, "trashed = false"];
	if (extraQuery) clauses.push(`(${extraQuery})`);

	const files: DriveFile[] = [];
	let pageToken: string | undefined;

	for (let page = 1; ; page++) {
		if (page > maxPages) {
			throw new Error(
				`Drive folder walk took too many pages (>${maxPages} x ${PAGE_SIZE} ` +
					`files). Raise maxPages if the folder really is that large.`,
			);
		}

		const params = new URLSearchParams({
			q: clauses.join(" and "),
			// `nextPageToken` MUST be in the field mask. A `fields=files(...)` mask
			// omits it, and then the walk silently stops after one page — a full
			// folder truncated to its first 1000 files, with no error anywhere.
			fields: `nextPageToken,files(${[...BASE_FIELDS, ...extraFields].join(",")})`,
			orderBy: "name",
			pageSize: String(PAGE_SIZE),
		});
		if (pageToken) params.set("pageToken", pageToken);

		const request = await auth(
			new Request(`https://www.googleapis.com/drive/v3/files?${params}`),
		);
		const res = await fetchImpl(request);

		if (!res.ok) {
			throw new Error(
				`Failed to list Drive files: ${res.status} ${res.statusText}`,
			);
		}

		const body = (await res.json()) as DriveFilesPayload;
		files.push(...(body.files ?? []));

		if (!body.nextPageToken) break;
		if (body.nextPageToken === pageToken) {
			throw new Error(
				`Drive returned the same pageToken twice — refusing to loop or to ` +
					`truncate at ${files.length} files.`,
			);
		}
		pageToken = body.nextPageToken;
	}

	return { files };
}

/**
 * The aspect ratio and pixel size the file is *displayed* at, once a transcoder
 * has baked EXIF orientation into the pixels (sharp does, and then strips the
 * tag).
 *
 * Drive's `imageMediaMetadata` width/height are the STORED orientation and
 * `rotation` is quarter-turns clockwise, so an ODD rotation SWAPS THE AXES. Two
 * lines of code, and the thing most consumers of this API get wrong.
 *
 * Missing dimensions fall back to 1:1 with a warning rather than an error: never
 * fail a build, and never drop a file, over metadata Google chose not to send.
 */
function displayDimensions(
	meta: ImageMediaMetadata | undefined,
	name: string,
): Pick<Photo, "width" | "height" | "ratio"> {
	const w = meta?.width;
	const h = meta?.height;

	if (!w || !h) {
		console.warn(
			`[google-cms] no image dimensions from Drive, assuming 1:1: ${name}`,
		);
		return { width: null, height: null, ratio: 1 };
	}

	const swap = (meta?.rotation ?? 0) % 2 !== 0;
	const width = swap ? h : w;
	const height = swap ? w : h;
	return { width, height, ratio: width / height };
}

/**
 * Pure. Raw payload in, `Photo[]` out — no network, no clock, no environment.
 *
 * This is the seam to feed checked-in JSON through: a `files.list` body saved to
 * a fixture goes straight in, so a test exercises every line of interpretation
 * without faking a `Response`. `null` and `undefined` are accepted for the same
 * reason — a fixture that read as nothing comes back as `[]`, not a crash.
 */
export function normalisePhotos(
	payload: DriveFilesPayload | null | undefined,
): Photo[] {
	return (payload?.files ?? []).map((file) => {
		const description = (file.description || "").trim();
		return {
			id: file.id,
			name: file.name,
			mimeType: file.mimeType,
			modifiedTime: file.modifiedTime,
			description,
			caption: description || file.name,
			...displayDimensions(file.imageMediaMetadata, file.name),
			rotation: file.imageMediaMetadata?.rotation ?? 0,
			url: file.webContentLink,
		};
	});
}

/**
 * `listFiles` + `normalisePhotos`, so the whole thing is one expression — which
 * is what lets an Eleventy `_data/*.js` module be a single `default` export over
 * imports, as Eleventy requires.
 *
 * Returns `[]` for an empty folder rather than throwing. `200 {"files": []}` is
 * also exactly what a folder that stopped being shared looks like, so if YOUR
 * folder is never legitimately empty, check for `[]` and throw — see the
 * README's error policy.
 */
export async function fetchPhotos(options: DriveOptions): Promise<Photo[]> {
	return normalisePhotos(await listFiles(options));
}

/**
 * The bytes of one file. The universal delivery primitive: an API key goes in
 * the query string and a token goes in a header, and that difference is the
 * whole difference between the two auth models — so this one call works under
 * both. No signed-URL mechanism exists to replace it (`expirationTime` cannot be
 * set on an `anyone` permission), and `thumbnailLink` is not a stable src: it
 * changes on every metadata call.
 *
 * Takes anything carrying an `id`, so a whole `Photo` goes in as happily as
 * `{ id }`.
 *
 * RETURNS `Uint8Array`, NOT `Buffer`. `Buffer` is Node-only and this package
 * targets any JS runtime. The consequence a Node consumer must know:
 * **eleventy-img tests `Buffer.isBuffer(src)`**
 * (`node_modules/@11ty/eleventy-img/src/image.js:135`), which is FALSE for a
 * plain `Uint8Array`, so pass
 * `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)` — a view, not
 * a copy.
 */
export async function fetchBytes(
	photo: { id: string },
	{
		auth,
		fetch: fetchImpl = globalThis.fetch,
	}: Pick<DriveOptions, "auth" | "fetch">,
): Promise<Uint8Array> {
	requireAuth(auth, "fetchBytes");

	const request = await auth(
		new Request(
			`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(photo.id)}?alt=media`,
		),
	);
	const res = await fetchImpl(request);

	if (!res.ok) {
		throw new Error(
			`Failed to download Drive file ${photo.id}: ${res.status} ${res.statusText}`,
		);
	}

	// `res.ok` is not enough here. A file the credential cannot read answers
	// `200 text/html` with a sign-in page — roughly 900 KB of it — and anything
	// downstream caches that as image bytes and then fails somewhere far away
	// ("sharp: unsupported image format"). A media download that returns HTML
	// contradicts what was asked for, so it throws.
	const type = res.headers?.get?.("content-type") ?? "";
	if (type.startsWith("text/html")) {
		throw new Error(
			`Drive answered 200 text/html for file ${photo.id} — that is a sign-in ` +
				`page, not file content. The credential cannot read this file.`,
		);
	}

	return new Uint8Array(await res.arrayBuffer());
}
