import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-ai";

const TASK_HISTORY_ENV = "RUNNER_TASK_HISTORY";
const ROLE_USER = "user";
const ROLE_ASSISTANT = "assistant";
const CONTENT_TYPE_TEXT = "text";
const HISTORY_API = "switchboard-history";
const HISTORY_PROVIDER = "switchboard";
const HISTORY_MODEL = "switchboard";
const HISTORY_STOP_REASON = "stop";
const HISTORY_TIMESTAMP = 0;
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface HistoryEntry {
	role: typeof ROLE_USER | typeof ROLE_ASSISTANT;
	content: string;
}

export function parseTaskHistory(raw: string | undefined): HistoryEntry[] {
	if (raw === undefined || raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${TASK_HISTORY_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`${TASK_HISTORY_ENV} must be a JSON array of messages`);
	}
	return parsed.map((entry, index) => {
		if (entry === null || typeof entry !== "object") {
			throw new Error(`${TASK_HISTORY_ENV}[${index}] must be an object`);
		}
		const record = entry as Record<string, unknown>;
		if (record.role !== ROLE_USER && record.role !== ROLE_ASSISTANT) {
			throw new Error(`${TASK_HISTORY_ENV}[${index}].role must be ${ROLE_USER} or ${ROLE_ASSISTANT}`);
		}
		if (typeof record.content !== "string" || record.content.length === 0) {
			throw new Error(`${TASK_HISTORY_ENV}[${index}].content must be a non-empty string`);
		}
		return { role: record.role, content: record.content };
	});
}

function toAgentMessage(entry: HistoryEntry): AgentMessage {
	const content = [{ type: CONTENT_TYPE_TEXT, text: entry.content }];
	if (entry.role === ROLE_ASSISTANT) {
		return {
			role: ROLE_ASSISTANT,
			content,
			api: HISTORY_API,
			provider: HISTORY_PROVIDER,
			model: HISTORY_MODEL,
			usage: ZERO_USAGE,
			stopReason: HISTORY_STOP_REASON,
			timestamp: HISTORY_TIMESTAMP,
		} as unknown as AgentMessage;
	}
	return { role: ROLE_USER, content, timestamp: HISTORY_TIMESTAMP } as unknown as AgentMessage;
}

function headText(message: AgentMessage): string | null {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === CONTENT_TYPE_TEXT) {
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : null;
		}
	}
	return null;
}

export function withHistoryPrepended(history: HistoryEntry[], current: AgentMessage[]): AgentMessage[] | null {
	if (history.length === 0) return null;
	const head = current[0];
	const first = history[0];
	if (head !== undefined && (head as { role?: unknown }).role === first.role && headText(head) === first.content) {
		return null;
	}
	return [...history.map(toAgentMessage), ...current];
}

export function registerTaskHistory(pi: ExtensionAPI): void {
	const history = parseTaskHistory(process.env[TASK_HISTORY_ENV]);
	if (history.length === 0) return;
	pi.on("context", event => {
		const next = withHistoryPrepended(history, event.messages);
		if (next === null) return;
		return { messages: next };
	});
}
