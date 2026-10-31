import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl } from "./config.ts";
import { spawnedConnectionId } from "./constants.ts";
import { resolveStreamToken } from "./sessionStream.ts";

const BRIDGE_PATH = "/v1/remote/bridge";
const REMOTE_FLAG = "remote";
const REMOTE_COMMAND = "remote";
const STATUS_KEY = "switchboard-remote";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const REAUTH_INTERVAL_MS = 5 * 60_000;
const CLOSE_CODE_REPLACED = 4409;
const MAX_EVENT_TEXT_LENGTH = 16_000;
const REMOTE_MODES = new Set(["tui", "rpc"]);

export const SPEECH_INSTRUCTION =
	"\n\nThe user is talking to you by voice from a watch, and your final reply will be read aloud. End with a short spoken answer: a few plain sentences, no markdown, no code blocks, no lists, no URLs.";

export type RelayFrame =
	| { type: "message"; message_id: string; text: string }
	| { type: "abort"; message_id: string | null }
	| { type: "ready" };

export function parseRelayFrame(raw: unknown): RelayFrame | null {
	if (typeof raw !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const frame = parsed as Record<string, unknown>;
	if (frame.type === "ready") return { type: "ready" };
	if (frame.type === "message") {
		if (typeof frame.message_id !== "string" || typeof frame.text !== "string") return null;
		return { type: "message", message_id: frame.message_id, text: frame.text };
	}
	if (frame.type === "abort") {
		return { type: "abort", message_id: typeof frame.message_id === "string" ? frame.message_id : null };
	}
	return null;
}

interface AssistantLike {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

export type TurnOutcome = { type: "reply"; text: string } | { type: "error"; text: string };

export function turnOutcome(messages: readonly unknown[]): TurnOutcome {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as AssistantLike | null;
		if (message === null || typeof message !== "object" || message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return { type: "error", text: "Stopped." };
		if (message.stopReason === "error") {
			const detail = typeof message.errorMessage === "string" ? message.errorMessage : "The turn failed.";
			return { type: "error", text: clip(detail) };
		}
		const blocks = Array.isArray(message.content) ? message.content : [];
		const text = blocks
			.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n")
			.trim();
		return { type: "reply", text: clip(text) };
	}
	return { type: "error", text: "No reply was produced." };
}

function clip(text: string): string {
	return text.length > MAX_EVENT_TEXT_LENGTH ? text.slice(0, MAX_EVENT_TEXT_LENGTH) : text;
}

export function bridgeUrl(baseUrl: string): string {
	const url = new URL(`${baseUrl}${BRIDGE_PATH}`);
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

let activeSocket: WebSocket | null = null;
let activeContext: ExtensionContext | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reauthTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempt = 0;
let stopped = true;
let currentMessageId: string | null = null;
let watchTurnPending = false;

function send(frame: Record<string, unknown>): void {
	const socket = activeSocket;
	if (socket === null || socket.readyState !== WebSocket.OPEN) return;
	socket.send(JSON.stringify(frame));
}

function setStatus(text: string | undefined): void {
	activeContext?.ui.setStatus(STATUS_KEY, text);
}

function scheduleReconnect(pi: ExtensionAPI): void {
	if (stopped || reconnectTimer !== null) return;
	const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_CAP_MS);
	const delay = backoff / 2 + Math.random() * (backoff / 2);
	reconnectAttempt += 1;
	setStatus("remote: reconnecting");
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void connect(pi);
	}, delay);
	reconnectTimer.unref?.();
}

function handleFrame(pi: ExtensionAPI, raw: unknown): void {
	const frame = parseRelayFrame(raw);
	if (frame === null || activeContext === null) return;
	if (frame.type === "ready") {
		reconnectAttempt = 0;
		setStatus("remote: on");
		return;
	}
	if (frame.type === "abort") {
		activeContext.abort();
		return;
	}
	currentMessageId = frame.message_id;
	watchTurnPending = true;
	if (activeContext.isIdle()) pi.sendUserMessage(frame.text);
	else pi.sendUserMessage(frame.text, { deliverAs: "followUp" });
}

async function sendReauth(): Promise<void> {
	if (activeContext === null) return;
	const token = await resolveStreamToken(activeContext);
	if (token !== null) send({ type: "reauth", token });
}

async function connect(pi: ExtensionAPI): Promise<void> {
	if (stopped || activeSocket !== null || activeContext === null) return;
	const token = await resolveStreamToken(activeContext);
	if (token === null || !token.startsWith("vst_")) {
		activeContext.ui.notify("Remote needs a Switchboard login. Run /login and choose Switchboard.", "error");
		stopRemote();
		return;
	}

	let socket: WebSocket;
	try {
		const init = { headers: { Authorization: `Bearer ${token}` } };
		socket = new WebSocket(bridgeUrl(resolveBaseUrl()), init as unknown as string[]);
	} catch {
		return scheduleReconnect(pi);
	}
	activeSocket = socket;

	socket.addEventListener("message", (event: MessageEvent) => {
		handleFrame(pi, event.data);
	});
	socket.addEventListener("close", (event: CloseEvent) => {
		if (activeSocket === socket) activeSocket = null;
		if (event.code === CLOSE_CODE_REPLACED) {
			activeContext?.ui.notify("Remote moved to another Valni session.", "warning");
			stopRemote();
			return;
		}
		scheduleReconnect(pi);
	});
	socket.addEventListener("error", () => {
		if (activeSocket === socket) activeSocket = null;
		try {
			socket.close();
		} catch {
			void 0;
		}
		scheduleReconnect(pi);
	});
}

export function startRemote(pi: ExtensionAPI, context: ExtensionContext): void {
	if (!REMOTE_MODES.has(context.mode) || spawnedConnectionId() !== null) return;
	stopRemote();
	stopped = false;
	activeContext = context;
	setStatus("remote: connecting");
	reauthTimer = setInterval(() => void sendReauth(), REAUTH_INTERVAL_MS);
	reauthTimer.unref?.();
	void connect(pi);
}

export function stopRemote(): void {
	stopped = true;
	reconnectAttempt = 0;
	currentMessageId = null;
	watchTurnPending = false;
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (reauthTimer !== null) {
		clearInterval(reauthTimer);
		reauthTimer = null;
	}
	setStatus(undefined);
	const socket = activeSocket;
	activeSocket = null;
	if (socket !== null) {
		try {
			socket.close();
		} catch {
			void 0;
		}
	}
}

export function registerRemote(pi: ExtensionAPI): void {
	pi.registerFlag(REMOTE_FLAG, {
		description: "Let Valni Watch send messages to this session through Switchboard",
		type: "boolean",
		default: false,
	});
	pi.registerCommand(REMOTE_COMMAND, {
		description: "Turn Valni Watch remote control on or off for this session",
		handler: async (_args, ctx) => {
			if (stopped) {
				startRemote(pi, ctx);
				ctx.ui.notify("Remote is on. Talk to this session from Valni Watch.", "info");
			} else {
				stopRemote();
				ctx.ui.notify("Remote is off.", "info");
			}
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag(REMOTE_FLAG) === true) startRemote(pi, ctx);
	});
	pi.on("before_agent_start", (event) => {
		if (!watchTurnPending) return;
		watchTurnPending = false;
		return { systemPrompt: event.systemPrompt + SPEECH_INSTRUCTION };
	});
	pi.on("tool_execution_start", (event) => {
		if (currentMessageId === null) return;
		send({ type: "status", message_id: currentMessageId, text: `Running ${event.toolName}` });
	});
	pi.on("agent_end", (event) => {
		if (currentMessageId === null) return;
		const outcome = turnOutcome(event.messages);
		send({ type: outcome.type, message_id: currentMessageId, text: outcome.text });
		currentMessageId = null;
	});
	pi.on("session_shutdown", () => {
		stopRemote();
		activeContext = null;
	});
}
