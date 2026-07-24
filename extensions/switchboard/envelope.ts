import { EVENT_STREAM_CONTENT_TYPE, SENTINEL_SEGMENT } from "./constants.ts";
import { resolveBaseUrl, resolveEndUserId } from "./config.ts";
import { describeNetworkFailure, isAbortError, streamErrorResponse, translatedErrorResponse } from "./errors.ts";
import { KIND_TO_API, type SwitchboardKind } from "./types.ts";

const INFERENCE_PATH = "/v1/switchboard/inference";
const TOOL_ASK_HEADER = "X-Switchboard-Tool-Ask";
const TOOL_ASK_STREAM_MARKER = ":switchboard.tool_ask ";

export interface AskTag {
	tool: string;
	rule: string;
	layer: string;
}

interface AskEntry {
	id?: string;
	tool: string;
	rule: string;
	layer: string;
}

const pendingAsks = new Map<string, AskTag>();

export function consumePendingAsk(id: string): AskTag | undefined {
	const ask = pendingAsks.get(id);
	if (ask !== undefined) pendingAsks.delete(id);
	return ask;
}

export function clearPendingAsks(): void {
	pendingAsks.clear();
}

function recordAskEntries(entries: AskEntry[]): void {
	for (const entry of entries) {
		if (typeof entry.id !== "string") {
			console.error("pi-switchboard: ignoring a tool-ask tag without a tool-call id; cannot correlate it to a tool call");
			continue;
		}
		pendingAsks.set(entry.id, { tool: entry.tool, rule: entry.rule, layer: entry.layer });
	}
}

function recordAskHeader(response: Response): void {
	const header = response.headers.get(TOOL_ASK_HEADER);
	if (header === null) return;
	try {
		const entries = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as AskEntry[];
		if (Array.isArray(entries)) recordAskEntries(entries);
	} catch (error) {
		console.error("pi-switchboard: failed to parse the tool-ask header", error);
	}
}

function recordAskMarkerLine(line: string): void {
	if (!line.startsWith(TOOL_ASK_STREAM_MARKER)) return;
	try {
		const parsed = JSON.parse(line.slice(TOOL_ASK_STREAM_MARKER.length).trim()) as { asks?: AskEntry[] };
		if (Array.isArray(parsed.asks)) recordAskEntries(parsed.asks);
	} catch (error) {
		console.error("pi-switchboard: failed to parse a tool-ask stream marker", error);
	}
}

function scanStreamForAsks(response: Response): Response {
	if (response.body === null) return response;
	const decoder = new TextDecoder();
	let buffer = "";
	const scanner = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			buffer += decoder.decode(chunk, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				recordAskMarkerLine(buffer.slice(0, newlineIndex));
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
			}
		},
		flush() {
			recordAskMarkerLine(buffer);
		},
	});
	return new Response(response.body.pipeThrough(scanner), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function captureAskTags(response: Response): Response {
	recordAskHeader(response);
	if ((response.headers.get("content-type") ?? "").includes(EVENT_STREAM_CONTENT_TYPE)) {
		return scanStreamForAsks(response);
	}
	return response;
}

function isEnvelopeTarget(url: string): SwitchboardKind | null {
	const sentinelIndex = url.indexOf(SENTINEL_SEGMENT);
	if (sentinelIndex === -1) return null;
	const kindTag = url.slice(sentinelIndex + SENTINEL_SEGMENT.length).split("/")[0];
	return kindTag in KIND_TO_API ? (kindTag as SwitchboardKind) : null;
}

let envelopeFetchInstalled = false;

export function installEnvelopeFetch(): void {
	if (envelopeFetchInstalled) return;
	envelopeFetchInstalled = true;
	const baseFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		const kindTag = isEnvelopeTarget(url);
		if (kindTag === null) return baseFetch(input, init);
		const request = new Request(input, init);
		const nativeBody = (await request.json()) as Record<string, unknown>;
		const headers = new Headers(request.headers);
		headers.set("Content-Type", "application/json");
		const anthropicStyleKey = headers.get("x-api-key");
		if (!headers.has("Authorization") && anthropicStyleKey) {
			headers.set("Authorization", `Bearer ${anthropicStyleKey}`);
			headers.delete("x-api-key");
		}
		let response: Response;
		try {
			response = await baseFetch(`${resolveBaseUrl()}${INFERENCE_PATH}`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					user_id: resolveEndUserId(),
					time: new Date().toISOString(),
					idempotency_key: crypto.randomUUID(),
					kind: { [kindTag]: nativeBody },
				}),
				signal: request.signal,
			});
		} catch (error) {
			if (isAbortError(error)) throw error;
			return streamErrorResponse(kindTag, describeNetworkFailure(error));
		}
		if (response.ok) return captureAskTags(response);
		return translatedErrorResponse(kindTag, response);
	};
}
