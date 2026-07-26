import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const DEFAULT_AUTH_BASE_URL = "https://api.valni.app";
const DEFAULT_RUNNER_BASE_URL = "https://runner.valni.app";

interface LocalOverride {
	baseUrl?: string;
	authBaseUrl?: string;
	runnerBaseUrl?: string;
}

function readOverrideUrl(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.length > 0) return value;
	console.error(`pi-switchboard: ignoring "${key}" in switchboard.local.json (must be a non-empty string)`);
	return undefined;
}

function loadLocalOverride(): LocalOverride {
	const path = join(dirname(fileURLToPath(import.meta.url)), "switchboard.local.json");
	if (!existsSync(path)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`pi-switchboard: ignoring switchboard.local.json (${String(error)})`);
		return {};
	}
	if (parsed === null || typeof parsed !== "object") {
		console.error("pi-switchboard: ignoring switchboard.local.json (expected a JSON object)");
		return {};
	}

	const source = parsed as Record<string, unknown>;
	return {
		baseUrl: readOverrideUrl(source, "baseUrl"),
		authBaseUrl: readOverrideUrl(source, "authBaseUrl"),
		runnerBaseUrl: readOverrideUrl(source, "runnerBaseUrl"),
	};
}

const localOverride = loadLocalOverride();

let sessionEndUserId: string | null = null;

let sessionId: string | null = null;

let sessionAccessToken: string | null = null;

export function resolveBaseUrl(): string {
	return process.env.SWITCHBOARD_BASE_URL ?? localOverride.baseUrl ?? DEFAULT_BASE_URL;
}

export function resolveAuthBaseUrl(): string {
	return process.env.SWITCHBOARD_AUTH_BASE_URL ?? localOverride.authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
}

export function resolveRunnerBaseUrl(): string {
	return process.env.SWITCHBOARD_RUNNER_BASE_URL ?? localOverride.runnerBaseUrl ?? DEFAULT_RUNNER_BASE_URL;
}

export function setSessionEndUserId(id: string): void {
	sessionEndUserId = id;
}

export function setSessionAccessToken(token: string): void {
	sessionAccessToken = token.length > 0 ? token : null;
}

export function resolveAccessToken(): string | null {
	return sessionAccessToken;
}

export function setSessionId(id: string): void {
	sessionId = id.length > 0 ? id : null;
}

export function resolveSessionId(): string | null {
	return sessionId;
}

export function resolveEndUserId(): string {
	const fromSession = sessionEndUserId ?? process.env.SWITCHBOARD_END_USER_ID;
	if (!fromSession) {
		throw new Error("Not signed in to Switchboard. Run /login in pi, or set SWITCHBOARD_API_KEY and SWITCHBOARD_END_USER_ID for key-based use.");
	}
	return fromSession;
}
