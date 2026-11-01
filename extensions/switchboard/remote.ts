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

export interface WatchRequest {
	messageId: string;
	text: string;
}

export class WatchRequestQueue {
	private waiting: WatchRequest[] = [];
	private running: string | null = null;

	get current(): string | null {
		return this.running;
	}

	enqueue(request: WatchRequest): void {
		this.waiting.push(request);
	}

	startNext(): WatchRequest | null {
		if (this.running !== null) return null;
		const next = this.waiting.shift();
		if (next === undefined) return null;
		this.running = next.messageId;
		return next;
	}

	finish(): string | null {
		const finished = this.running;
		this.running = null;
		return finished;
	}

	abortTarget(messageId: string | null): "current" | "queued" | "none" {
		if (messageId === null) return this.running === null ? "none" : "current";
		if (messageId === this.running) return "current";
		const before = this.waiting.length;
		this.waiting = this.waiting.filter((request) => request.messageId !== messageId);
		return this.waiting.length < before ? "queued" : "none";
	}

	clear(): void {
		this.waiting = [];
		this.running = null;
	}
}

export const MAX_UNSENT_OUTCOMES = 20;

export class OutcomeOutbox {
	private frames: string[] = [];

	push(frame: string): void {
		this.frames = [...this.frames, frame].slice(-MAX_UNSENT_OUTCOMES);
	}

	drain(): string[] {
		const drained = this.frames;
		this.frames = [];
		return drained;
	}

	clear(): void {
		this.frames = [];
	}
}

let activeSocket: WebSocket | null = null;
let activeContext: ExtensionContext | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reauthTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempt = 0;
let stopped = true;
let generation = 0;
let watchTurnPending = false;
let settledOutcome: TurnOutcome | null = null;
const requests = new WatchRequestQueue();
const outbox = new OutcomeOutbox();

function socketOpen(): WebSocket | null {
	const socket = activeSocket;
	return socket !== null && socket.readyState === WebSocket.OPEN ? socket : null;
}

function sendStatus(frame: Record<string, unknown>): void {
	socketOpen()?.send(JSON.stringify(frame));
}

function sendOutcome(frame: Record<string, unknown>): void {
	const encoded = JSON.stringify(frame);
	const socket = socketOpen();
	if (socket === null) {
		outbox.push(encoded);
		return;
	}
	socket.send(encoded);
}

function flushOutbox(socket: WebSocket): void {
	for (const frame of outbox.drain()) socket.send(frame);
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

function dispatchNext(pi: ExtensionAPI): void {
	if (activeContext === null || !activeContext.isIdle()) return;
	const next = requests.startNext();
	if (next === null) return;
	watchTurnPending = true;
	pi.sendUserMessage(next.text);
}

function handleFrame(pi: ExtensionAPI, socket: WebSocket, raw: unknown): void {
	const frame = parseRelayFrame(raw);
	if (frame === null || activeContext === null) return;
	if (frame.type === "ready") {
		reconnectAttempt = 0;
		setStatus("remote: on");
		flushOutbox(socket);
		return;
	}
	if (frame.type === "abort") {
		const target = requests.abortTarget(frame.message_id);
		if (target === "current") activeContext.abort();
		if (target === "queued" && frame.message_id !== null) {
			sendOutcome({ type: "error", message_id: frame.message_id, text: "Stopped." });
		}
		return;
	}
	requests.enqueue({ messageId: frame.message_id, text: frame.text });
	dispatchNext(pi);
}

async function sendReauth(): Promise<void> {
	if (activeContext === null) return;
	const token = await resolveStreamToken(activeContext);
	if (token !== null) sendStatus({ type: "reauth", token });
}

async function connect(pi: ExtensionAPI): Promise<void> {
	const context = activeContext;
	if (stopped || activeSocket !== null || context === null) return;
	const attempt = generation;
	const token = await resolveStreamToken(context);
	if (stopped || attempt !== generation || activeSocket !== null) return;
	if (token === null || !token.startsWith("vst_")) {
		context.ui.notify("Remote needs a Switchboard login. Run /login and choose Switchboard.", "error");
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
		if (activeSocket !== socket) return;
		handleFrame(pi, socket, event.data);
	});
	socket.addEventListener("close", (event: CloseEvent) => {
		if (activeSocket !== socket) return;
		activeSocket = null;
		if (event.code === CLOSE_CODE_REPLACED) {
			activeContext?.ui.notify("Remote moved to another Valni session.", "warning");
			stopRemote();
			return;
		}
		scheduleReconnect(pi);
	});
	socket.addEventListener("error", () => {
		if (activeSocket !== socket) return;
		activeSocket = null;
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
	generation += 1;
	reconnectAttempt = 0;
	watchTurnPending = false;
	settledOutcome = null;
	requests.clear();
	outbox.clear();
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
		const messageId = requests.current;
		if (messageId === null) return;
		sendStatus({ type: "status", message_id: messageId, text: `Running ${event.toolName}` });
	});
	pi.on("agent_end", (event) => {
		if (requests.current === null) return;
		settledOutcome = turnOutcome(event.messages);
	});
	pi.on("agent_settled", () => {
		const outcome = settledOutcome;
		settledOutcome = null;
		if (outcome !== null) {
			const messageId = requests.finish();
			if (messageId !== null) sendOutcome({ type: outcome.type, message_id: messageId, text: outcome.text });
		}
		if (!stopped) dispatchNext(pi);
	});
	pi.on("session_shutdown", () => {
		stopRemote();
		activeContext = null;
	});
}
