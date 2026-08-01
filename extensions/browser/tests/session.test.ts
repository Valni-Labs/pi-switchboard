import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
	boundSnapshot,
	closeActiveBrowser,
	needsReauth,
	openConnection,
	runBrowserAction,
	sameLocation,
	takeScreenshot,
	takeSnapshot,
	type BrowserConnector,
	type BrowserPageState,
	type BrowserSession,
} from "../session.ts";

function state(url: string, hasPasswordField = false): BrowserPageState {
	return { url, title: "Portal", hasPasswordField };
}

interface FakeSession extends BrowserSession {
	closed: number;
}

function fakeSession(partial: Partial<BrowserSession> = {}): FakeSession {
	const home = state("https://a.example/home");
	const base: FakeSession = {
		closed: 0,
		navigate: async (url: string) => state(url),
		back: async () => home,
		snapshot: async () => ({ page: home, snapshot: '- button "Book" [ref=e3]', truncated: false }),
		screenshot: async () => ({ page: home, data: "aGVsbG8=", mimeType: "image/jpeg" }),
		click: async () => home,
		type: async () => home,
		fillForm: async () => home,
		select: async () => home,
		pressKey: async () => home,
		waitFor: async () => home,
		close: async () => {
			base.closed += 1;
		},
	};
	return Object.assign(base, partial);
}

function fakeConnector(session: BrowserSession, page: BrowserPageState | null = null): BrowserConnector {
	return { list: async () => [], open: async () => ({ session, page }) };
}

beforeEach(async () => {
	await closeActiveBrowser();
});

test("boundSnapshot passes small snapshots through", () => {
	const result = boundSnapshot('- heading "Hello" [ref=e2]');
	assert.equal(result.snapshot, '- heading "Hello" [ref=e2]');
	assert.equal(result.truncated, false);
});

test("boundSnapshot truncates huge snapshots at a line break", () => {
	const line = `- listitem "${"x".repeat(80)}" [ref=e9]`;
	const huge = Array.from({ length: 500 }, () => line).join("\n");
	const result = boundSnapshot(huge);
	assert.equal(result.truncated, true);
	assert.ok(result.snapshot.length <= 24_000);
	assert.ok(result.snapshot.endsWith("[ref=e9]"));
});

test("sameLocation ignores trailing slashes and queries", () => {
	assert.equal(sameLocation("https://portal.example.com/home/", "https://portal.example.com/home?tab=1"), true);
	assert.equal(sameLocation("https://portal.example.com/home", "https://portal.example.com/login"), false);
	assert.equal(sameLocation("https://portal.example.com/home", "https://other.example.com/home"), false);
	assert.equal(sameLocation("not a url", "not a url"), false);
});

test("needsReauth flags a navigation that lands on a login page", () => {
	assert.equal(needsReauth("https://a.example/home", null, state("https://a.example/login", true)), true);
	assert.equal(needsReauth("https://a.example/home", null, state("https://a.example/login", false)), false);
	assert.equal(needsReauth("https://a.example/login", null, state("https://a.example/login?next=home", true)), false);
});

test("needsReauth flags an action that redirects to a login page", () => {
	const previous = state("https://a.example/home");
	assert.equal(needsReauth(null, previous, state("https://a.example/login", true)), true);
	assert.equal(needsReauth(null, state("https://a.example/login", true), state("https://a.example/login", true)), false);
	assert.equal(needsReauth(null, previous, state("https://a.example/home", true)), false);
	assert.equal(needsReauth(null, null, state("https://a.example/login", true)), false);
});

test("actions without an open connection say to connect first", async () => {
	const result = await runBrowserAction("Clicked e3.", null, (session) => session.click("e3"));
	assert.match(result.text, /No browser connection is open/);
	assert.equal(result.state, null);
});

test("openConnection reports the opened connection and restored page", async () => {
	const opened = await openConnection(fakeConnector(fakeSession(), state("https://a.example/home")), "clinic");
	assert.match(opened.text, /Opened browser connection "clinic"/);
	assert.match(opened.text, /url: https:\/\/a.example\/home/);
	assert.match(opened.text, /title: Portal/);
});

test("openConnection surfaces connector errors and leaves no session open", async () => {
	const connector: BrowserConnector = {
		list: async () => [],
		open: async () => {
			throw new Error("Server-side browser connections are not available on Switchboard yet.");
		},
	};
	const result = await openConnection(connector, "clinic");
	assert.match(result.text, /not available on Switchboard yet/);
	const followUp = await runBrowserAction("Clicked e3.", null, (session) => session.click("e3"));
	assert.match(followUp.text, /No browser connection is open/);
});

test("every action result carries the page url and title", async () => {
	await openConnection(fakeConnector(fakeSession()), "clinic");
	const result = await runBrowserAction("Clicked e3.", null, (session) => session.click("e3"));
	assert.equal(result.text, "Clicked e3.\nurl: https://a.example/home\ntitle: Portal");
	assert.deepEqual(result.state, state("https://a.example/home"));
});

test("a navigation that lands on a login page returns the re-auth message", async () => {
	const session = fakeSession({ navigate: async () => state("https://a.example/login", true) });
	await openConnection(fakeConnector(session), "clinic");
	const result = await runBrowserAction("Navigated.", "https://a.example/home", (open) => open.navigate("https://a.example/home"));
	assert.match(result.text, /"clinic" connection looks signed out/);
	assert.match(result.text, /url: https:\/\/a.example\/login/);
});

test("an action that redirects to a login page returns the re-auth message", async () => {
	const session = fakeSession({ click: async () => state("https://a.example/login", true) });
	await openConnection(fakeConnector(session), "clinic");
	await runBrowserAction("Navigated.", "https://a.example/home", (open) => open.navigate("https://a.example/home"));
	const result = await runBrowserAction("Clicked e3.", null, (open) => open.click("e3"));
	assert.match(result.text, /looks signed out/);
});

test("action errors come back as text without dropping the session", async () => {
	const session = fakeSession({
		click: async () => {
			throw new Error("Ref e9 was not found [SWB-9999]");
		},
	});
	await openConnection(fakeConnector(session), "clinic");
	const result = await runBrowserAction("Clicked e9.", null, (open) => open.click("e9"));
	assert.equal(result.text, "Ref e9 was not found [SWB-9999]");
	const next = await runBrowserAction("Pressed Enter.", null, (open) => open.pressKey("Enter"));
	assert.match(next.text, /Pressed Enter\./);
});

test("takeSnapshot returns the tree with refs and the footer", async () => {
	await openConnection(fakeConnector(fakeSession()), "clinic");
	const result = await takeSnapshot();
	assert.match(result.text, /- button "Book" \[ref=e3\]/);
	assert.match(result.text, /url: https:\/\/a.example\/home/);
	assert.doesNotMatch(result.text, /snapshot truncated/);
});

test("takeSnapshot bounds oversized snapshots and notes truncation", async () => {
	const line = `- listitem "${"x".repeat(80)}" [ref=e9]`;
	const session = fakeSession({
		snapshot: async () => ({ page: state("https://a.example/home"), snapshot: Array.from({ length: 500 }, () => line).join("\n"), truncated: false }),
	});
	await openConnection(fakeConnector(session), "clinic");
	const result = await takeSnapshot();
	assert.match(result.text, /snapshot truncated/);
	assert.ok(result.text.length < 25_000);
});

test("takeSnapshot keeps the server's truncation note", async () => {
	const session = fakeSession({
		snapshot: async () => ({ page: state("https://a.example/home"), snapshot: '- button "Book" [ref=e3]', truncated: true }),
	});
	await openConnection(fakeConnector(session), "clinic");
	const result = await takeSnapshot();
	assert.match(result.text, /snapshot truncated/);
});

test("takeSnapshot flags a login page reached before snapshotting", async () => {
	const session = fakeSession({ snapshot: async () => ({ page: state("https://a.example/login", true), snapshot: "- textbox [ref=e4]", truncated: false }) });
	await openConnection(fakeConnector(session), "clinic");
	await runBrowserAction("Navigated.", "https://a.example/home", async () => state("https://a.example/home"));
	const result = await takeSnapshot();
	assert.match(result.text, /looks signed out/);
	assert.match(result.text, /- textbox \[ref=e4\]/);
});

test("takeScreenshot returns the image and the footer text", async () => {
	await openConnection(fakeConnector(fakeSession()), "clinic");
	const result = await takeScreenshot();
	assert.deepEqual(result.image, { data: "aGVsbG8=", mimeType: "image/jpeg" });
	assert.equal(result.text, "url: https://a.example/home\ntitle: Portal");
});

test("connecting again closes the previous session", async () => {
	const first = fakeSession();
	const second = fakeSession();
	await openConnection(fakeConnector(first), "clinic");
	await openConnection(fakeConnector(second), "supplier");
	assert.equal(first.closed, 1);
	assert.equal(second.closed, 0);
	await closeActiveBrowser();
	assert.equal(second.closed, 1);
});
