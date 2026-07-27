import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl, resolveSessionId } from "./config.ts";
import { PROVIDER_ID } from "./constants.ts";
import { deliverSteers } from "./envelope.ts";

const INBOX_PATH = "/v1/switchboard/steer-inbox";
const SESSION_HEADER = "X-Switchboard-Session";
const POLL_INTERVAL_MS = 45_000;
const POLL_TIMEOUT_MS = 10_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

async function drainOnce(context: ExtensionContext): Promise<void> {
	if (!context.isIdle()) return;
	const sessionId = resolveSessionId();
	if (sessionId === null) return;
	let resolution: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
	try {
		resolution = await context.modelRegistry.getProviderAuth(PROVIDER_ID);
	} catch {
		return;
	}
	if (resolution?.source !== "OAuth") return;
	const token = resolution.auth.apiKey ?? null;
	if (token === null) return;

	let response: Response;
	try {
		response = await fetch(`${resolveBaseUrl()}${INBOX_PATH}`, {
			headers: { Authorization: `Bearer ${token}`, [SESSION_HEADER]: sessionId },
			signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
		});
	} catch {
		return;
	}
	if (!response.ok) return;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return;
	}
	if (body === null || typeof body !== "object") return;
	if (resolveSessionId() !== sessionId) return;
	deliverSteers((body as { steers?: unknown }).steers);
}

export function startIdleInboxPoll(context: ExtensionContext): void {
	stopIdleInboxPoll();
	pollTimer = setInterval(() => {
		if (pollInFlight) return;
		pollInFlight = true;
		void drainOnce(context).finally(() => {
			pollInFlight = false;
		});
	}, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopIdleInboxPoll(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}
