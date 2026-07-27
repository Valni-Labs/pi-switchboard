import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl, resolveSessionId } from "./config.ts";
import { PROVIDER_ID } from "./constants.ts";

const TOOLS_PATH = "/v1/tools";
const DISCOVER_TIMEOUT_MS = 10_000;
const SESSION_HEADER = "X-Switchboard-Session";

export interface AdvertisedTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	version?: string;
}

export async function discoverTools(baseUrl: string, bearer: string): Promise<AdvertisedTool[]> {
	const response = await fetch(`${baseUrl}${TOOLS_PATH}`, {
		headers: { Authorization: `Bearer ${bearer}` },
		signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
	});
	if (!response.ok) return [];
	const body = (await response.json()) as { tools?: AdvertisedTool[] };
	return Array.isArray(body.tools) ? body.tools : [];
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function errorMessage(result: unknown, name: string, status: number): string {
	if (result !== null && typeof result === "object" && "error" in result) {
		const envelope = result as { error: unknown; code?: unknown };
		const code = typeof envelope.code === "string" ? ` [${envelope.code}]` : "";
		return `${String(envelope.error)}${code}`;
	}
	return `Tool ${name} failed (HTTP ${status}).`;
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
		const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
		const sessionId = resolveSessionId();
		if (sessionId !== null) headers[SESSION_HEADER] = sessionId;

		let response: Response;
		try {
			response = await fetch(`${resolveBaseUrl()}${TOOLS_PATH}/${encodeURIComponent(name)}/invoke`, {
				method: "POST",
				headers,
				body: JSON.stringify({ arguments: params }),
				signal,
			});
		} catch (error) {
			return textResult(`Could not reach Switchboard to run ${name}: ${String(error)}`, null);
		}

		const result: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			return textResult(errorMessage(result, name, response.status), result);
		}
		return textResult(JSON.stringify(result), result);
	};
}
