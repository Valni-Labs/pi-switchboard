import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test, type TestContext } from "node:test";
import { captureLocalLogin, localBrowserConnector } from "../local.ts";
import { needsReauth, type BrowserSession } from "../session.ts";
import { listConnections, saveConnection } from "../store.ts";

async function chromiumAvailable(): Promise<boolean> {
	try {
		const { chromium } = await import("playwright");
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
}

async function ensureChromium(t: TestContext): Promise<boolean> {
	if (await chromiumAvailable()) return true;
	t.skip("playwright chromium is not installed; run: npx playwright install chromium");
	return false;
}

const fixtureDir = mkdtempSync(join(tmpdir(), "pi-browser-fixtures-"));
const baseDir = join(fixtureDir, "state");
const sessions: BrowserSession[] = [];

writeFileSync(
	join(fixtureDir, "portal.html"),
	`<!doctype html><title>Portal</title><h1>Dental Portal</h1>
	<button onclick="document.getElementById('status').textContent='Booked'">Book</button>
	<p id="status">Idle</p>
	<label>Patient name <input></label>
	<label>Slot <select><option value="am">Morning</option><option value="pm">Afternoon</option></select></label>
	<a href="page2.html">Next</a>
	<a href="login.html">Log out</a>`,
);
writeFileSync(join(fixtureDir, "page2.html"), "<!doctype html><title>Two</title><h1>Second page</h1>");
writeFileSync(
	join(fixtureDir, "login.html"),
	"<!doctype html><title>Sign in</title><h1>Sign in</h1><label>Password <input type=\"password\"></label>",
);

function fixtureUrl(name: string): string {
	return pathToFileURL(join(fixtureDir, name)).href;
}

function refFor(snapshot: string, pattern: RegExp): string {
	const match = snapshot.match(pattern);
	assert.ok(match, `no ref matching ${pattern} in:\n${snapshot}`);
	return match[1];
}

after(async () => {
	for (const session of sessions) {
		try {
			await session.close();
		} catch {
			void 0;
		}
	}
	rmSync(fixtureDir, { recursive: true, force: true });
});

test("open rejects unknown connections with the available list", async (t) => {
	if (!(await ensureChromium(t))) return;
	saveConnection(baseDir, "clinic", fixtureUrl("login.html"), Date.now());
	await assert.rejects(localBrowserConnector(baseDir).open("missing"), /Unknown browser connection "missing"\. Available connections: clinic\./);
});

test("the local session drives fixture pages end to end", async (t) => {
	if (!(await ensureChromium(t))) return;
	const opened = await localBrowserConnector(baseDir).open("clinic");
	sessions.push(opened.session);
	const session = opened.session;

	const home = await session.navigate(fixtureUrl("portal.html"));
	assert.equal(home.title, "Portal");
	assert.equal(home.hasPasswordField, false);

	let snapshot = await session.snapshot();
	assert.equal(snapshot.truncated, false);
	assert.match(snapshot.snapshot, /\[ref=/);
	const bookRef = refFor(snapshot.snapshot, /button "Book" \[ref=([a-z0-9]+)\]/i);

	await session.click(bookRef);
	await session.waitFor({ text: "Booked" });
	snapshot = await session.snapshot();
	assert.match(snapshot.snapshot, /Booked/);

	const nameRef = refFor(snapshot.snapshot, /textbox "Patient name" \[ref=([a-z0-9]+)\]/i);
	const slotRef = refFor(snapshot.snapshot, /combobox "Slot" \[ref=([a-z0-9]+)\]/i);
	await session.fillForm([{ ref: nameRef, value: "Ada Lovelace" }]);
	await session.select(slotRef, "pm");
	snapshot = await session.snapshot();
	assert.match(snapshot.snapshot, /Ada Lovelace/);
	assert.match(snapshot.snapshot, /Afternoon/);

	const pressed = await session.pressKey("Tab");
	assert.equal(pressed.title, "Portal");

	await session.waitFor({ selector: "#status" });

	const nextRef = refFor(snapshot.snapshot, /link "Next" \[ref=([a-z0-9]+)\]/i);
	const second = await session.click(nextRef);
	assert.equal(second.title, "Two");
	const backAgain = await session.back();
	assert.equal(backAgain.title, "Portal");

	const screenshot = await session.screenshot();
	assert.equal(screenshot.mimeType, "image/jpeg");
	assert.equal(Buffer.from(screenshot.data, "base64")[0], 0xff);
	assert.equal(screenshot.page.title, "Portal");
});

test("clicking through to a login page trips the re-auth heuristic", async (t) => {
	if (!(await ensureChromium(t))) return;
	const opened = await localBrowserConnector(baseDir).open("clinic");
	sessions.push(opened.session);
	const session = opened.session;

	const previous = await session.navigate(fixtureUrl("portal.html"));
	const snapshot = await session.snapshot();
	const logoutRef = refFor(snapshot.snapshot, /link "Log out" \[ref=([a-z0-9]+)\]/i);
	const current = await session.click(logoutRef);

	assert.equal(current.hasPasswordField, true);
	assert.equal(needsReauth(null, previous, current), true);
	assert.equal(needsReauth(fixtureUrl("login.html"), null, current), false);
});

test("captureLocalLogin saves only after the user confirms", async (t) => {
	if (!(await ensureChromium(t))) return;
	const loginBase = join(fixtureDir, "login-state");
	const cancelled = await captureLocalLogin(loginBase, "clinic", fixtureUrl("login.html"), async () => false);
	assert.equal(cancelled, false);
	assert.equal(listConnections(loginBase).length, 0);
	assert.equal(existsSync(join(loginBase, "profiles", "clinic")), false);

	const confirmed = await captureLocalLogin(loginBase, "clinic", fixtureUrl("login.html"), async () => true);
	assert.equal(confirmed, true);
	const connections = listConnections(loginBase);
	assert.equal(connections.length, 1);
	assert.equal(connections[0].name, "clinic");
	assert.equal(existsSync(join(loginBase, "profiles", "clinic")), true);
});
