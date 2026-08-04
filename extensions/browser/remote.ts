import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BROWSER_CONNECTIONS_PATH,
	BROWSER_SESSIONS_PATH,
	connectionFromWire,
	pageFromWire,
	type WireActionResponse,
	type WireBrowserAction,
	type WireConnectionsResponse,
	type WireOpenEphemeralSessionRequest,
	type WireOpenSessionResponse,
	type WireScreenshotResponse,
	type WireSnapshotResponse,
} from "./contract.ts";
import type { BrowserConnector, BrowserFormField, BrowserPageState, BrowserSession, BrowserWaitTarget } from "./session.ts";

const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const PROVIDER_ID = "switchboard";
const NOT_AVAILABLE_MESSAGE = "Server-side browser connections are not available on Switchboard yet.";
const NOT_SIGNED_IN_MESSAGE = "Not signed in to Switchboard. Run /login in pi, or set SWITCHBOARD_API_KEY for key-based use.";
const REQUEST_TIMEOUT_MS = 60_000;

export type BearerSupplier = () => Promise<string | null>;

export function resolveBaseUrl(): string {
	return process.env.SWITCHBOARD_BASE_URL ?? DEFAULT_BASE_URL;
}

export async function resolveBearer(ctx: ExtensionContext): Promise<string | null> {
	let resolution: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
	try {
		resolution = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	} catch {
		return null;
	}
	return resolution?.auth.apiKey ?? null;
}

async function requestFailure(response: Response): Promise<Error> {
	const body = await response.text();
	let envelope: { code?: unknown; error?: unknown };
	try {
		envelope = JSON.parse(body) as { code?: unknown; error?: unknown };
	} catch {
		envelope = {};
	}
	if (typeof envelope.code === "string" && typeof envelope.error === "string") {
		return new Error(`${envelope.error} [${envelope.code}]`);
	}
	if (response.status === 404) return new Error(NOT_AVAILABLE_MESSAGE);
	return new Error(`Switchboard browser request failed (HTTP ${response.status}).`);
}

async function request<T>(baseUrl: string, bearer: BearerSupplier, method: string, path: string, body?: unknown): Promise<T> {
	const token = await bearer();
	if (token === null) throw new Error(NOT_SIGNED_IN_MESSAGE);
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw await requestFailure(response);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

function remoteSession(baseUrl: string, bearer: BearerSupplier, sessionId: string): BrowserSession {
	const sessionPath = `${BROWSER_SESSIONS_PATH}/${encodeURIComponent(sessionId)}`;
	const act = async (action: WireBrowserAction): Promise<BrowserPageState> => {
		const result = await request<WireActionResponse>(baseUrl, bearer, "POST", `${sessionPath}/actions`, action);
		return pageFromWire(result.page);
	};
	return {
		navigate: (url: string) => act({ action: "navigate", url }),
		back: () => act({ action: "back" }),
		click: (ref: string) => act({ action: "click", ref }),
		type: (ref: string, text: string) => act({ action: "type", ref, text }),
		fillForm: (fields: BrowserFormField[]) => act({ action: "fill_form", fields }),
		select: (ref: string, value: string) => act({ action: "select", ref, value }),
		pressKey: (key: string) => act({ action: "press_key", key }),
		waitFor: (target: BrowserWaitTarget) =>
			act({ action: "wait_for", text: target.text, selector: target.selector, timeout_ms: target.timeoutMs }),
		snapshot: async () => {
			const result = await request<WireSnapshotResponse>(baseUrl, bearer, "POST", `${sessionPath}/snapshot`);
			return { page: pageFromWire(result.page), snapshot: result.snapshot, truncated: result.truncated };
		},
		screenshot: async () => {
			const result = await request<WireScreenshotResponse>(baseUrl, bearer, "POST", `${sessionPath}/screenshot`);
			return { page: pageFromWire(result.page), data: result.data, mimeType: result.mime_type };
		},
		close: () => request<undefined>(baseUrl, bearer, "DELETE", sessionPath),
	};
}

export function remoteBrowserConnector(baseUrl: string, bearer: BearerSupplier): BrowserConnector {
	return {
		list: async () => {
			const result = await request<WireConnectionsResponse>(baseUrl, bearer, "GET", BROWSER_CONNECTIONS_PATH);
			return result.connections.map(connectionFromWire);
		},
		open: async (name: string) => {
			const result = await request<WireOpenSessionResponse>(
				baseUrl,
				bearer,
				"POST",
				`${BROWSER_CONNECTIONS_PATH}/${encodeURIComponent(name)}/sessions`,
			);
			return {
				session: remoteSession(baseUrl, bearer, result.session_id),
				page: result.page === null ? null : pageFromWire(result.page),
			};
		},
		openEphemeral: async (url?: string) => {
			const body: WireOpenEphemeralSessionRequest = url === undefined ? {} : { url };
			const result = await request<WireOpenSessionResponse>(baseUrl, bearer, "POST", BROWSER_SESSIONS_PATH, body);
			return {
				session: remoteSession(baseUrl, bearer, result.session_id),
				page: result.page === null ? null : pageFromWire(result.page),
			};
		},
	};
}
