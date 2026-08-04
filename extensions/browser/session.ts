export interface BrowserPageState {
	url: string;
	title: string;
	hasPasswordField: boolean;
}

export interface BrowserSnapshot {
	page: BrowserPageState;
	snapshot: string;
	truncated: boolean;
}

export interface BrowserScreenshot {
	page: BrowserPageState;
	data: string;
	mimeType: string;
}

export interface BrowserFormField {
	ref: string;
	value: string;
}

export interface BrowserWaitTarget {
	text?: string;
	selector?: string;
	timeoutMs?: number;
}

export interface BrowserConnectionInfo {
	name: string;
	loginUrl: string;
	status: "ready" | "needs_auth";
	createdAt: number;
	lastUsedAt: number | null;
}

export interface BrowserSession {
	navigate(url: string): Promise<BrowserPageState>;
	back(): Promise<BrowserPageState>;
	snapshot(): Promise<BrowserSnapshot>;
	screenshot(): Promise<BrowserScreenshot>;
	click(ref: string): Promise<BrowserPageState>;
	type(ref: string, text: string): Promise<BrowserPageState>;
	fillForm(fields: BrowserFormField[]): Promise<BrowserPageState>;
	select(ref: string, value: string): Promise<BrowserPageState>;
	pressKey(key: string): Promise<BrowserPageState>;
	waitFor(target: BrowserWaitTarget): Promise<BrowserPageState>;
	close(): Promise<void>;
}

export interface BrowserOpenResult {
	session: BrowserSession;
	page: BrowserPageState | null;
}

export interface BrowserConnector {
	list(): Promise<BrowserConnectionInfo[]>;
	open(name: string): Promise<BrowserOpenResult>;
	openEphemeral(url?: string): Promise<BrowserOpenResult>;
}

export interface DriverResult {
	text: string;
	image?: { data: string; mimeType: string };
	state: BrowserPageState | null;
}

const SNAPSHOT_CHARACTER_LIMIT = 24_000;
const TRUNCATION_NOTE = "[snapshot truncated: the page is large; interact with what is visible or navigate closer to what you need]";
const NO_SESSION_MESSAGE = "No browser session is open. Call open_browser_automation to start browsing, or browser_connect to open a named signed-in connection.";

export function boundSnapshot(snapshot: string): { snapshot: string; truncated: boolean } {
	if (snapshot.length <= SNAPSHOT_CHARACTER_LIMIT) return { snapshot, truncated: false };
	const lineBreak = snapshot.lastIndexOf("\n", SNAPSHOT_CHARACTER_LIMIT);
	const end = lineBreak > 0 ? lineBreak : SNAPSHOT_CHARACTER_LIMIT;
	return { snapshot: snapshot.slice(0, end), truncated: true };
}

function comparableLocation(url: string): string | null {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

export function sameLocation(a: string, b: string): boolean {
	const left = comparableLocation(a);
	return left !== null && left === comparableLocation(b);
}

export function needsReauth(requestedUrl: string | null, previous: BrowserPageState | null, current: BrowserPageState): boolean {
	if (!current.hasPasswordField) return false;
	if (requestedUrl !== null) return !sameLocation(requestedUrl, current.url);
	if (previous === null || previous.hasPasswordField) return false;
	return !sameLocation(previous.url, current.url);
}

interface ActiveBrowser {
	reauthName: string | null;
	session: BrowserSession;
	lastState: BrowserPageState | null;
}

let active: ActiveBrowser | null = null;

function pageFooter(state: BrowserPageState): string {
	return `url: ${state.url}\ntitle: ${state.title}`;
}

function failure(error: unknown): DriverResult {
	return { text: error instanceof Error ? error.message : String(error), state: null };
}

function reauthMessage(name: string, state: BrowserPageState): string {
	return `The "${name}" connection looks signed out: this page is showing a login form. Re-authenticate the connection, then retry.\n${pageFooter(state)}`;
}

const NOTHING_TO_CLOSE_MESSAGE = "No browser session is open, so there is nothing to close.";

export async function closeActiveBrowser(): Promise<void> {
	const current = active;
	active = null;
	if (current === null) return;
	try {
		await current.session.close();
	} catch {
		void 0;
	}
}

export async function closeBrowserSession(): Promise<DriverResult> {
	const current = active;
	if (current === null) return { text: NOTHING_TO_CLOSE_MESSAGE, state: null };
	active = null;
	try {
		await current.session.close();
	} catch (error) {
		return failure(error);
	}
	const target = current.reauthName === null ? "the browser session" : `browser connection "${current.reauthName}"`;
	return {
		text: `Closed ${target}. The session ended and its worker was freed; for a signed-in connection this saved the session so it persists next time.`,
		state: null,
	};
}

export async function openConnection(connector: BrowserConnector, name: string): Promise<DriverResult> {
	await closeActiveBrowser();
	try {
		const opened = await connector.open(name);
		active = { reauthName: name, session: opened.session, lastState: opened.page };
		const location = opened.page === null ? "" : `\n${pageFooter(opened.page)}`;
		return {
			text: `Opened browser connection "${name}". Use browser_navigate to load a page, then browser_snapshot to see it.${location}`,
			state: opened.page,
		};
	} catch (error) {
		return failure(error);
	}
}

export async function openEphemeralSession(connector: BrowserConnector, url?: string): Promise<DriverResult> {
	await closeActiveBrowser();
	try {
		const opened = await connector.openEphemeral(url);
		active = { reauthName: null, session: opened.session, lastState: opened.page };
		const location = opened.page === null ? "" : `\n${pageFooter(opened.page)}`;
		return {
			text: `Opened a browser session. Use browser_navigate to load a page, then browser_snapshot to see it.${location}`,
			state: opened.page,
		};
	} catch (error) {
		return failure(error);
	}
}

export async function runBrowserAction(
	label: string,
	requestedUrl: string | null,
	action: (session: BrowserSession) => Promise<BrowserPageState>,
): Promise<DriverResult> {
	if (active === null) return { text: NO_SESSION_MESSAGE, state: null };
	const current = active;
	try {
		const previous = current.lastState;
		const state = await action(current.session);
		current.lastState = state;
		const reauthName = current.reauthName;
		if (reauthName !== null && needsReauth(requestedUrl, previous, state)) {
			return { text: reauthMessage(reauthName, state), state };
		}
		return { text: `${label}\n${pageFooter(state)}`, state };
	} catch (error) {
		return failure(error);
	}
}

export async function takeSnapshot(): Promise<DriverResult> {
	if (active === null) return { text: NO_SESSION_MESSAGE, state: null };
	const current = active;
	try {
		const previous = current.lastState;
		const result = await current.session.snapshot();
		const bounded = boundSnapshot(result.snapshot);
		current.lastState = result.page;
		const note = result.truncated || bounded.truncated ? `\n${TRUNCATION_NOTE}` : "";
		const text = `${bounded.snapshot}${note}\n${pageFooter(result.page)}`;
		const reauthName = current.reauthName;
		if (reauthName !== null && needsReauth(null, previous, result.page)) {
			return { text: `${reauthMessage(reauthName, result.page)}\n${text}`, state: result.page };
		}
		return { text, state: result.page };
	} catch (error) {
		return failure(error);
	}
}

export async function takeScreenshot(): Promise<DriverResult> {
	if (active === null) return { text: NO_SESSION_MESSAGE, state: null };
	const current = active;
	try {
		const result = await current.session.screenshot();
		current.lastState = result.page;
		return { text: pageFooter(result.page), image: { data: result.data, mimeType: result.mimeType }, state: result.page };
	} catch (error) {
		return failure(error);
	}
}
