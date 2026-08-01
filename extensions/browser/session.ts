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

export type BrowserTransport = "remote" | "local";

export interface BrowserConnector {
	transport: BrowserTransport;
	list(): Promise<BrowserConnectionInfo[]>;
	open(name: string): Promise<BrowserOpenResult>;
}

const SNAPSHOT_CHARACTER_LIMIT = 24_000;

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
