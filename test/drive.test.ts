import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { apiKey } from "../src/auth.ts";
import {
	fetchBytes,
	fetchPhotos,
	listFiles,
	normalisePhotos,
	type DriveFile,
	type ImageMediaMetadata,
} from "../src/drive.ts";
import { serve, serveBytes } from "./support/serve.ts";

// Transport, normaliser and delivery. `listFiles` and `fetchBytes` take their
// `fetch` as an option, so nothing here touches `globalThis.fetch` or the
// network — and `normalisePhotos` is pure, so the interesting half needs no seam
// at all.

const realWarn = console.warn;

afterEach(() => {
	console.warn = realWarn;
});

function captureWarnings(): string[] {
	const warnings: string[] = [];
	console.warn = (msg: string) => warnings.push(msg);
	return warnings;
}

// The knobs the fixtures below turn. `width`/`height`/`rotation` are folded into
// an `imageMediaMetadata` block; everything else is a raw field.
interface FileExtras {
	id?: string;
	mimeType?: string;
	description?: string;
	modifiedTime?: string;
	webContentLink?: string | undefined;
	width?: number;
	height?: number;
	rotation?: number;
	imageMediaMetadata?: ImageMediaMetadata | undefined;
}

// A raw `files.list` entry, with dimensions defaulting to a square so cases that
// are not about ratios need not carry them.
function file(name: string, extra: FileExtras = {}): DriveFile {
	const { width = 1000, height = 1000, rotation, ...rest } = extra;
	const id = rest.id ?? `id-${name}`;
	return {
		id,
		name,
		mimeType: rest.mimeType ?? "image/jpeg",
		description: rest.description,
		modifiedTime: rest.modifiedTime ?? "2024-01-01T00:00:00.000Z",
		webContentLink:
			"webContentLink" in extra
				? extra.webContentLink
				: `https://drive.google.com/uc?id=${id}&export=download`,
		imageMediaMetadata:
			"imageMediaMetadata" in extra
				? extra.imageMediaMetadata
				: { width, height, ...(rotation === undefined ? {} : { rotation }) },
	};
}

// `searchParams.get` is nullable and the assertions below want a string. Asking
// for a parameter that is not there is a failure either way; this just says so
// at the point it happens.
function param(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	assert.ok(value !== null, `no ${name} parameter in ${url}`);
	return value;
}

const auth = apiKey("test-key");
const FOLDER = "folder-id";

// ------------------------------------------------------------- normalisePhotos

test("ratio is width/height for an unrotated photo", () => {
	const photos = normalisePhotos({
		files: [
			file("landscape.jpg", { width: 4000, height: 3000 }),
			file("portrait.jpg", { width: 1200, height: 1600 }),
		],
	});

	assert.equal(photos[0].ratio, 4000 / 3000);
	assert.equal(photos[1].ratio, 0.75);
});

test("an odd EXIF rotation swaps the axes — Drive reports the STORED orientation", () => {
	// The two live photos in this shape: 4032x3024 stored, rotation 1, displayed
	// portrait. sharp bakes the rotation into the pixels, so the ratio the page
	// lays out against is h/w, not w/h.
	const photos = normalisePhotos({
		files: [
			file("quarter.jpg", { width: 4032, height: 3024, rotation: 1 }),
			file("three-quarter.jpg", { width: 4032, height: 3024, rotation: 3 }),
			file("half.jpg", { width: 4032, height: 3024, rotation: 2 }),
			file("none.jpg", { width: 4032, height: 3024, rotation: 0 }),
		],
	});

	assert.equal(photos[0].ratio, 3024 / 4032, "rotation 1 swaps");
	assert.equal(photos[1].ratio, 3024 / 4032, "rotation 3 swaps");
	assert.equal(photos[2].ratio, 4032 / 3024, "rotation 2 does not swap");
	assert.equal(photos[3].ratio, 4032 / 3024, "rotation 0 does not swap");
});

test("width and height are the DISPLAYED pixels, swapped with the axes", () => {
	const [photo] = normalisePhotos({
		files: [file("quarter.jpg", { width: 4032, height: 3024, rotation: 1 })],
	});

	assert.equal(photo.width, 3024);
	assert.equal(photo.height, 4032);
	assert.equal(
		photo.rotation,
		1,
		"the reported rotation is kept, not consumed",
	);
});

test("missing dimensions fall back to a 1:1 ratio with a warning, never a failure", () => {
	const warnings = captureWarnings();

	const photos = normalisePhotos({
		files: [
			file("no-metadata.jpg", { imageMediaMetadata: undefined }),
			file("empty-metadata.jpg", { imageMediaMetadata: {} }),
			file("zero-height.jpg", { width: 100, height: 0 }),
			file("fine.jpg", { width: 1000, height: 500 }),
		],
	});

	assert.equal(photos.length, 4, "no photo is dropped");
	assert.equal(photos[0].ratio, 1);
	assert.equal(photos[1].ratio, 1);
	assert.equal(photos[2].ratio, 1);
	assert.equal(photos[3].ratio, 2);
	assert.equal(warnings.length, 3, "one warning per photo without dimensions");
	assert.ok(warnings.every((w) => w.includes("assuming 1:1")));
});

test("width and height are null when dimensions are missing, but ratio never is", () => {
	// Fabricating pixel counts would be a lie the consumer cannot detect; a 1:1
	// ratio is a stated fallback it can lay out against.
	captureWarnings();
	const [photo] = normalisePhotos({
		files: [file("no-metadata.jpg", { imageMediaMetadata: undefined })],
	});

	assert.equal(photo.width, null);
	assert.equal(photo.height, null);
	assert.equal(photo.ratio, 1);
});

test("caption is never empty: the description, else the filename", () => {
	captureWarnings();
	const photos = normalisePhotos({
		files: [
			file("1 - x.jpg", { description: "  My caption  " }),
			file("2 - hello-world.jpg", { description: "" }),
			file("3 - a_b.jpg"), // description undefined
		],
	});

	assert.equal(photos[0].caption, "My caption", "trimmed");
	assert.equal(photos[0].description, "My caption");
	// The fallback is the RAW name; prettifying it is a site convention, and
	// the fallback chain splits exactly here.
	assert.equal(photos[1].caption, "2 - hello-world.jpg");
	assert.equal(photos[1].description, "", "the raw field is empty, not absent");
	assert.equal(photos[2].caption, "3 - a_b.jpg");
	assert.equal(photos[2].description, "");
});

test("mimeType is returned and never filtered on", () => {
	// Which types a site shows is its policy, not Google's — the transport hands
	// everything over and the consumer decides.
	const photos = normalisePhotos({
		files: [
			file("a.heic", { mimeType: "image/heic" }),
			file("doc.pdf", { mimeType: "application/pdf" }),
		],
	});

	assert.deepEqual(
		photos.map((p) => p.mimeType),
		["image/heic", "application/pdf"],
	);
});

test("url is webContentLink, verbatim, and undefined when Drive omits it", () => {
	const photos = normalisePhotos({
		files: [
			file("1 - x.jpg", { id: "abc123" }),
			file("2 - y.jpg", { webContentLink: undefined }),
		],
	});

	assert.equal(
		photos[0].url,
		"https://drive.google.com/uc?id=abc123&export=download",
	);
	assert.equal(photos[1].url, undefined);
});

test("id, name and modifiedTime come through untouched", () => {
	const [photo] = normalisePhotos({
		files: [
			file("1 - x.jpg", { id: "abc123", modifiedTime: "2024-05-01T10:00:00Z" }),
		],
	});

	assert.equal(photo.id, "abc123");
	assert.equal(photo.name, "1 - x.jpg");
	assert.equal(photo.modifiedTime, "2024-05-01T10:00:00Z");
});

test("an empty or absent file list normalises to an empty array", () => {
	// Ambiguous-but-legal: an empty folder is not an error here. The caller that
	// knows its folder is never empty is the one that throws.
	assert.deepEqual(normalisePhotos({ files: [] }), []);
	assert.deepEqual(normalisePhotos({}), []);
});

// -------------------------------------------------------------------- listFiles

test("the query scopes to the folder and excludes the trash — and nothing else", async () => {
	// WHICH files are wanted is the caller's decision, so the base query says
	// nothing about mimeType.
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({ folderId: FOLDER, auth, fetch });

	const q = param(requested[0], "q");
	assert.match(q, /'folder-id' in parents/);
	assert.match(q, /trashed = false/);
	assert.ok(!q.includes("mimeType"), "no mimeType clause of its own");
});

test("imageMediaMetadata and webContentLink ride along on the listing call", async () => {
	// Both cost no extra request, which is the finding the whole gallery rests on.
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({ folderId: FOLDER, auth, fetch });

	const fields = param(requested[0], "fields");
	assert.match(fields, /imageMediaMetadata\(width,height,rotation\)/);
	assert.match(fields, /webContentLink/);
});

test("the walk is ordered by name, which is transport determinism, not display order", async () => {
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({ folderId: FOLDER, auth, fetch });

	assert.equal(requested[0].searchParams.get("orderBy"), "name");
});

test("the auth is applied — the key reaches the request", async () => {
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({ folderId: FOLDER, auth, fetch });

	assert.equal(requested[0].searchParams.get("key"), "test-key");
});

test("extraFields MERGE into the field list rather than replacing it", async () => {
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({
		folderId: FOLDER,
		auth,
		fetch,
		extraFields: ["thumbnailLink"],
	});

	const fields = param(requested[0], "fields");
	assert.match(fields, /thumbnailLink/);
	assert.match(fields, /imageMediaMetadata/, "the base fields survive");
});

test("extraQuery is AND-ed onto the base q rather than replacing it", async () => {
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({
		folderId: FOLDER,
		auth,
		fetch,
		extraQuery: "name contains 'launch'",
	});

	const q = param(requested[0], "q");
	assert.match(q, /name contains 'launch'/);
	assert.match(q, /trashed = false/, "the base query survives");
});

test("throws immediately when no auth was passed", async () => {
	const { fetch } = serve([{ files: [] }]);

	await assert.rejects(
		// @ts-expect-error — the omission the runtime guard exists for
		() => listFiles({ folderId: FOLDER, fetch }),
		/auth/i,
		"the message has to name the constructors — this module reads no env",
	);
});

// ------------------------------------------------------------------ pagination

// The walk itself — the cap, a repeated token, a non-OK page — is
// `internal/page-walk.ts` and is tested in `test/page-walk.test.ts`. What
// belongs here is what Drive gets wrong: the mask that makes the walk possible
// at all, and that this transport keeps every page it is handed.

test("nextPageToken is in the field mask — without it the walk cannot happen", async () => {
	// A `fields=files(...)` mask OMITS nextPageToken, and then a folder past the
	// first page is silently truncated with no error anywhere. This is the whole
	// reason pagination is a trap rather than a loop.
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({ folderId: FOLDER, auth, fetch });

	assert.match(param(requested[0], "fields"), /^nextPageToken,files\(/);
});

test("follows nextPageToken and keeps every page's files", async () => {
	const { fetch, requested } = serve([
		{ files: [file("1 - a.jpg")], nextPageToken: "token-2" },
		{ files: [file("2 - b.jpg")] },
	]);

	const { files } = await listFiles({ folderId: FOLDER, auth, fetch });

	assert.equal(requested.length, 2);
	assert.equal(requested[0].searchParams.get("pageToken"), null);
	assert.equal(requested[1].searchParams.get("pageToken"), "token-2");
	assert.deepEqual(
		files.map((f) => f.name),
		["1 - a.jpg", "2 - b.jpg"],
	);
});

test("asks for the largest page the API allows", async () => {
	const { fetch, requested } = serve([{ files: [] }]);

	await listFiles({ folderId: FOLDER, auth, fetch });

	assert.equal(requested[0].searchParams.get("pageSize"), "1000");
});

// ------------------------------------------------------------------ fetchBytes

test("fetchBytes downloads alt=media, authorised, and returns a Uint8Array", async () => {
	// NOT a Buffer: Buffer is Node-only and this package targets any runtime.
	// A Node consumer wraps with Buffer.from(bytes.buffer, …) — see the README.
	const { fetch, requested } = serveBytes("JPEGDATA");

	const bytes = await fetchBytes({ id: "abc123" }, { auth, fetch });

	assert.ok(bytes instanceof Uint8Array);
	assert.ok(!Buffer.isBuffer(bytes), "a plain Uint8Array, deliberately");
	assert.equal(new TextDecoder().decode(bytes), "JPEGDATA");
	assert.match(requested[0].pathname, /\/drive\/v3\/files\/abc123$/);
	assert.equal(requested[0].searchParams.get("alt"), "media");
	assert.equal(requested[0].searchParams.get("key"), "test-key");
});

test("fetchBytes takes a whole Photo as happily as an id", async () => {
	const { fetch, requested } = serveBytes("BYTES");
	const [photo] = normalisePhotos({
		files: [file("1 - x.jpg", { id: "xyz" })],
	});

	await fetchBytes(photo, { auth, fetch });

	assert.match(requested[0].pathname, /\/files\/xyz$/);
});

test("fetchBytes throws on a non-OK response", async () => {
	const { fetch } = serveBytes("", { status: 404, statusText: "Not Found" });

	await assert.rejects(
		() => fetchBytes({ id: "abc123" }, { auth, fetch }),
		/404/,
	);
});

test("fetchBytes throws on the 200 text/html sign-in page", async () => {
	// The trap this guard exists for: a file the credential cannot read answers
	// 200 with ~900 KB of sign-in HTML. Unguarded, that gets cached as image
	// bytes and fails somewhere far away ("unsupported image format").
	const { fetch } = serveBytes("<html>Sign in</html>", {
		type: "text/html; charset=UTF-8",
	});

	await assert.rejects(
		() => fetchBytes({ id: "abc123" }, { auth, fetch }),
		/sign-in page/i,
	);
});

test("fetchBytes throws immediately when no auth was passed", async () => {
	const { fetch } = serveBytes("BYTES");

	await assert.rejects(
		// @ts-expect-error — the omission the runtime guard exists for
		() => fetchBytes({ id: "abc123" }, { fetch }),
		/auth/i,
	);
});

// ------------------------------------------------------------------ fetchPhotos

test("fetchPhotos is listFiles then normalisePhotos", async () => {
	const { fetch } = serve([
		{ files: [file("1 - x.jpg", { id: "abc", width: 1000, height: 500 })] },
	]);

	const photos = await fetchPhotos({ folderId: FOLDER, auth, fetch });

	assert.equal(photos.length, 1);
	assert.equal(photos[0].id, "abc");
	assert.equal(photos[0].ratio, 2);
});

test("an empty listing returns [] rather than throwing", async () => {
	// `200 {"files": []}` is also what a folder that stopped being shared looks
	// like — but "empty" is legal, and only the consumer knows whether its own
	// folder can ever be.
	const { fetch } = serve([{ files: [] }]);

	assert.deepEqual(await fetchPhotos({ folderId: FOLDER, auth, fetch }), []);
});
