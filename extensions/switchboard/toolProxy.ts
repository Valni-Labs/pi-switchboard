import { randomBytes } from "node:crypto";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl, resolveSessionId } from "./config.ts";
import { PROVIDER_ID, spawnedConnectionId } from "./constants.ts";

const MCP_PATH = "/mcp";
const DISCOVER_TIMEOUT_MS = 10_000;
const SESSION_HEADER = "X-Switchboard-Session";
const OPEN_CONNECTION_TOOL = "open_automation_connection";
const CONNECTION_TOOLS = new Set(["send_message", "close_automation_connection"]);
const CONNECTION_ID_PARAM = "connection_id";
const CONNECTION_ID_PREFIX = "con_";
const CONNECTION_ID_BYTES = 16;

function hasConnectionId(record: Record<string, unknown>): boolean {
	const existing = record[CONNECTION_ID_PARAM];
	return typeof existing === "string" && existing.trim() !== "";
}

export function withMintedConnectionId(name: string, params: unknown): unknown {
	if (name !== OPEN_CONNECTION_TOOL) return params;
	if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
	const record = params as Record<string, unknown>;
	if (hasConnectionId(record)) return params;
	return { ...record, [CONNECTION_ID_PARAM]: `${CONNECTION_ID_PREFIX}${randomBytes(CONNECTION_ID_BYTES).toString("hex")}` };
}

export function withSpawnedConnectionId(name: string, params: unknown, connectionId: string | null): unknown {
	if (!CONNECTION_TOOLS.has(name) || connectionId === null) return params;
	if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
	const record = params as Record<string, unknown>;
	if (hasConnectionId(record)) return params;
	return { ...record, [CONNECTION_ID_PARAM]: connectionId };
}

export interface AdvertisedTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	version?: string;
}

export async function discoverTools(baseUrl: string, bearer: string): Promise<AdvertisedTool[]> {
	let response: Response;
	try {
		response = await fetch(`${baseUrl}${MCP_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
		});
	} catch {
		return [];
	}
	if (!response.ok) return [];
	const body = (await response.json().catch(() => null)) as {
		result?: { tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> };
	} | null;
	const tools = body?.result?.tools;
	if (!Array.isArray(tools)) return [];
	const advertised: AdvertisedTool[] = [];
	for (const tool of tools) {
		if (typeof tool.name !== "string" || tool.name.length === 0) continue;
		advertised.push({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			parameters:
				tool.inputSchema !== null && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
					? (tool.inputSchema as Record<string, unknown>)
					: {},
		});
	}
	return advertised;
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

export function toAgentContent(content: unknown): AgentToolResult<unknown>["content"] {
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const items: AgentToolResult<unknown>["content"] = [];
	for (const raw of content) {
		if (raw === null || typeof raw !== "object") continue;
		const item = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
		if (item.type === "text" && typeof item.text === "string") {
			items.push({ type: "text", text: item.text });
		} else if (item.type === "image" && typeof item.data === "string") {
			items.push({ type: "image", data: item.data, mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png" });
		} else {
			items.push({ type: "text", text: JSON.stringify(raw) });
		}
	}
	return items.length > 0 ? items : [{ type: "text", text: "" }];
}

export async function resolveInvokeToken(ctx: ExtensionContext): Promise<string | null> {
	let resolution: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
	try {
		resolution = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	} catch {
		return null;
	}
	return resolution?.auth.apiKey ?? null;
}

export function makeProxyExecute(name: string) {
	return async (
		_toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => {
		const token = await resolveInvokeToken(ctx);
		if (!token) return textResult(`Not signed in to Switchboard — cannot run ${name}. Run /login in pi, or set SWITCHBOARD_API_KEY for key-based use.`, null);
		const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` };
		const sessionId = resolveSessionId();
		if (sessionId !== null) headers[SESSION_HEADER] = sessionId;

		const args = withSpawnedConnectionId(name, withMintedConnectionId(name, params), spawnedConnectionId());
		let response: Response;
		try {
			response = await fetch(`${resolveBaseUrl()}${MCP_PATH}`, {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
				signal,
			});
		} catch (error) {
			return textResult(`Could not reach Switchboard to run ${name}: ${String(error)}`, null);
		}

		const envelope = (await response.json().catch(() => null)) as {
			result?: { content?: unknown; isError?: boolean };
			error?: { message?: unknown; code?: unknown };
		} | null;
		if (envelope?.error) {
			return textResult(typeof envelope.error.message === "string" ? envelope.error.message : `Tool ${name} failed.`, envelope);
		}
		if (!response.ok || !envelope?.result) {
			return textResult(`Tool ${name} failed (HTTP ${response.status}).`, envelope);
		}
		return { content: toAgentContent(envelope.result.content), details: envelope.result };
	};
}
