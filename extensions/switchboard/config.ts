import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const DEFAULT_AUTH_BASE_URL = "https://api.valni.app";

interface LocalOverride {
	baseUrl?: string;
	authBaseUrl?: string;
}

function loadLocalOverride(): LocalOverride {
	try {
		const path = join(dirname(fileURLToPath(import.meta.url)), "switchboard.local.json");
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf8")) as LocalOverride;
	} catch {
		return {};
	}
}

const localOverride = loadLocalOverride();

let sessionEndUserId: string | null = null;

export function resolveBaseUrl(): string {
	return process.env.SWITCHBOARD_BASE_URL ?? localOverride.baseUrl ?? DEFAULT_BASE_URL;
}

export function resolveAuthBaseUrl(): string {
	return process.env.SWITCHBOARD_AUTH_BASE_URL ?? localOverride.authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
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
