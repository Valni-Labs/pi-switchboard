import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { remoteBrowserConnector } from "../remote.ts";

interface RecordedRequest {
	url: string;
	method: string;
	authorization: string | null;
	body: unknown;
}

const BASE_URL = "https://switchboard.test";
const originalFetch = globalThis.fetch;
let recorded: RecordedRequest[] = [];
let responses: Response[] = [];

function respondWith(...next: Response[]): void {
	responses = next;
}

beforeEach(() => {
	recorded = [];
	responses = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		recorded.push({
			url: String(input),
			method: init?.method ?? "GET",
			authorization: headers.get("Authorization"),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const next = responses.shift();
		if (!next) throw new Error("no stubbed response left");
		return next;
	};
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const bearer = async () => "token-123";

const wirePage = { url: "https://portal.example.com/home", title: "Home", has_password_field: false };

test("list maps wire connections to camelCase", async () => {
	respondWith(
		json(200, {
			connections: [{ name: "clinic", login_url: "https://portal.example.com/login", status: "needs_auth", created_at: 1_000, last_used_at: null }],
		}),
	);
	const connections = await remoteBrowserConnector(BASE_URL, bearer).list();
	assert.deepEqual(connections, [
		{ name: "clinic", loginUrl: "https://portal.example.com/login", status: "needs_auth", createdAt: 1_000, lastUsedAt: null },
	]);
	assert.equal(recorded[0].url, `${BASE_URL}/v1/browser/connections`);
	assert.equal(recorded[0].method, "GET");
	assert.equal(recorded[0].authorization, "Bearer token-123");
});

test("a bare 404 reads as service-not-available and an envelope passes through", async () => {
	respondWith(new Response("not found", { status: 404 }));
	await assert.rejects(remoteBrowserConnector(BASE_URL, bearer).list(), /not available on Switchboard yet/);
	respondWith(json(403, { code: "SWB-1301", error: "Company policy denied this tool call" }));
	await assert.rejects(remoteBrowserConnector(BASE_URL, bearer).list(), /Company policy denied this tool call \[SWB-1301\]/);
});

test("a missing bearer fails before any request", async () => {
	await assert.rejects(remoteBrowserConnector(BASE_URL, async () => null).list(), /Not signed in to Switchboard/);
	assert.equal(recorded.length, 0);
});

test("openEphemeral posts to the sessions endpoint with an optional url", async () => {
	respondWith(json(201, { session_id: "bws_e1", page: wirePage }));
	const opened = await remoteBrowserConnector(BASE_URL, bearer).openEphemeral("https://example.com/start");
	assert.deepEqual(opened.page, { url: wirePage.url, title: "Home", hasPasswordField: false });
	assert.equal(recorded[0].url, `${BASE_URL}/v1/browser/sessions`);
	assert.equal(recorded[0].method, "POST");
	assert.deepEqual(recorded[0].body, { url: "https://example.com/start" });

	respondWith(json(201, { session_id: "bws_e2", page: wirePage }));
	await remoteBrowserConnector(BASE_URL, bearer).openEphemeral();
	assert.equal(recorded[1].url, `${BASE_URL}/v1/browser/sessions`);
	assert.deepEqual(recorded[1].body, {});
});

test("open then act posts typed actions to the session endpoint", async () => {
	respondWith(json(200, { session_id: "bs_1", page: wirePage }));
	const opened = await remoteBrowserConnector(BASE_URL, bearer).open("clinic");
	assert.deepEqual(opened.page, { url: wirePage.url, title: "Home", hasPasswordField: false });
	assert.equal(recorded[0].url, `${BASE_URL}/v1/browser/connections/clinic/sessions`);
	assert.equal(recorded[0].method, "POST");

	respondWith(json(200, { page: wirePage }));
	await opened.session.click("e3");
	assert.equal(recorded[1].url, `${BASE_URL}/v1/browser/sessions/bs_1/actions`);
	assert.deepEqual(recorded[1].body, { action: "click", ref: "e3" });

	respondWith(json(200, { page: wirePage }));
	await opened.session.waitFor({ text: "Booked", timeoutMs: 5_000 });
	assert.deepEqual(recorded[2].body, { action: "wait_for", text: "Booked", timeout_ms: 5_000 });

	respondWith(json(200, { page: wirePage, snapshot: "- heading \"Home\" [ref=e2]", truncated: false }));
	const snapshot = await opened.session.snapshot();
	assert.equal(recorded[3].url, `${BASE_URL}/v1/browser/sessions/bs_1/snapshot`);
	assert.equal(snapshot.snapshot, "- heading \"Home\" [ref=e2]");
	assert.equal(snapshot.page.title, "Home");

	respondWith(json(200, { page: wirePage, data: "aGVsbG8=", mime_type: "image/jpeg" }));
	const screenshot = await opened.session.screenshot();
	assert.equal(screenshot.mimeType, "image/jpeg");
	assert.equal(screenshot.data, "aGVsbG8=");

	respondWith(new Response(null, { status: 204 }));
	await opened.session.close();
	assert.equal(recorded[5].url, `${BASE_URL}/v1/browser/sessions/bs_1`);
	assert.equal(recorded[5].method, "DELETE");
});
