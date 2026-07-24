const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const DEFAULT_AUTH_BASE_URL = "https://api.valni.app";

let sessionEndUserId: string | null = null;

export function resolveBaseUrl(): string {
	return process.env.SWITCHBOARD_BASE_URL ?? DEFAULT_BASE_URL;
}

export function resolveAuthBaseUrl(): string {
	return process.env.SWITCHBOARD_AUTH_BASE_URL ?? DEFAULT_AUTH_BASE_URL;
}

export function setSessionEndUserId(id: string): void {
	sessionEndUserId = id;
}

export function resolveEndUserId(): string {
	const fromSession = sessionEndUserId ?? process.env.SWITCHBOARD_END_USER_ID;
	if (!fromSession) {
		throw new Error("Not signed in to Switchboard. Run /login in pi, or set SWITCHBOARD_API_KEY and SWITCHBOARD_END_USER_ID for key-based use.");
	}
	return fromSession;
}
