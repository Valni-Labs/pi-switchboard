import type { BrowserConnectionInfo, BrowserPageState } from "./session.ts";

export const BROWSER_CONNECTIONS_PATH = "/v1/browser/connections";
export const BROWSER_SESSIONS_PATH = "/v1/browser/sessions";

export interface WireBrowserPage {
	url: string;
	title: string;
	has_password_field: boolean;
}

export interface WireBrowserConnection {
	name: string;
	login_url: string;
	status: "ready" | "needs_auth";
	created_at: number;
	last_used_at: number | null;
}

export interface WireConnectionsResponse {
	connections: WireBrowserConnection[];
}

export interface WireOpenSessionResponse {
	session_id: string;
	page: WireBrowserPage | null;
}

export type WireBrowserAction =
	| { action: "navigate"; url: string }
	| { action: "back" }
	| { action: "click"; ref: string }
	| { action: "type"; ref: string; text: string }
	| { action: "fill_form"; fields: { ref: string; value: string }[] }
	| { action: "select"; ref: string; value: string }
	| { action: "press_key"; key: string }
	| { action: "wait_for"; text?: string; selector?: string; timeout_ms?: number };

export interface WireActionResponse {
	page: WireBrowserPage;
}

export interface WireSnapshotResponse {
	page: WireBrowserPage;
	snapshot: string;
	truncated: boolean;
}

export interface WireScreenshotResponse {
	page: WireBrowserPage;
	data: string;
	mime_type: string;
}

export function pageFromWire(page: WireBrowserPage): BrowserPageState {
	return { url: page.url, title: page.title, hasPasswordField: page.has_password_field };
}

export function connectionFromWire(connection: WireBrowserConnection): BrowserConnectionInfo {
	return {
		name: connection.name,
		loginUrl: connection.login_url,
		status: connection.status,
		createdAt: connection.created_at,
		lastUsedAt: connection.last_used_at,
	};
}
