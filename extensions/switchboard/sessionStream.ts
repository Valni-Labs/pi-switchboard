import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl, resolveSessionId } from "./config.ts";
import { PROVIDER_ID } from "./constants.ts";
import { deliverSteers } from "./envelope.ts";

const STREAM_PATH = "/v1/switchboard/session-stream";
const SESSION_QUERY_PARAMETER = "session";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const STREAMING_MODES = new Set(["tui", "rpc"]);

let activeSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let stopped = true;

function streamUrl(sessionId: string): string {
	const base = new URL(resolveBaseUrl());
	base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
	base.pathname = STREAM_PATH;
	base.searchParams.set(SESSION_QUERY_PARAMETER, sessionId);
	return base.toString();
}

async function resolveStreamToken(context: ExtensionContext): Promise<string | null> {
	let resolution: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
	try {
		resolution = await context.modelRegistry.getProviderAuth(PROVIDER_ID);
	} catch {
		return null;
	}
	if (resolution?.source !== "OAuth") return null;
	return resolution.auth.apiKey ?? null;
}

function scheduleReconnect(context: ExtensionContext): void {
	if (stopped || reconnectTimer !== null) return;
	const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_CAP_MS);
	const delay = backoff / 2 + Math.random() * (backoff / 2);
	reconnectAttempt += 1;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void connect(context);
	}, delay);
}

function handleFrame(raw: unknown): void {
	if (typeof raw !== "string") return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (parsed === null || typeof parsed !== "object") return;
	if ((parsed as { type?: unknown }).type !== "steer") return;
	deliverSteers([parsed]);
}

async function connect(context: ExtensionContext): Promise<void> {
	if (stopped || activeSocket !== null) return;
	const sessionId = resolveSessionId();
	if (sessionId === null) return scheduleReconnect(context);
	const token = await resolveStreamToken(context);
	if (token === null) return scheduleReconnect(context);

	let socket: WebSocket;
	try {
		socket = new WebSocket(streamUrl(sessionId));
	} catch {
		return scheduleReconnect(context);
	}
	activeSocket = socket;

	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ type: "auth", token, session: sessionId }));
		reconnectAttempt = 0;
	});
	socket.addEventListener("message", (event: MessageEvent) => {
		handleFrame(event.data);
	});
	socket.addEventListener("close", () => {
		if (activeSocket === socket) activeSocket = null;
		scheduleReconnect(context);
	});
	socket.addEventListener("error", () => {
		if (activeSocket === socket) activeSocket = null;
		try {
			socket.close();
		} catch {
			return;
		}
	});
}

export function startSessionStream(context: ExtensionContext): void {
	if (!STREAMING_MODES.has(context.mode)) return;
	stopSessionStream();
	stopped = false;
	void connect(context);
}

export function stopSessionStream(): void {
	stopped = true;
	reconnectAttempt = 0;
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	const socket = activeSocket;
	activeSocket = null;
	if (socket !== null) {
		try {
			socket.close();
		} catch {
			return;
		}
	}
}
