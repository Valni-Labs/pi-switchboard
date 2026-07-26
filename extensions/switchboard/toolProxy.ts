import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveAccessToken, resolveBaseUrl, resolveSessionId } from "./config.ts";

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

export function makeProxyExecute(name: string) {
	return async (_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
		const token = resolveAccessToken();
		if (!token) return textResult(`Not signed in to Switchboard — cannot run ${name}.`, null);
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
			const message =
				result !== null && typeof result === "object" && "error" in result
					? String((result as { error: unknown }).error)
					: `Tool ${name} failed (HTTP ${response.status}).`;
			return textResult(message, result);
		}
		return textResult(JSON.stringify(result), result);
	};
}
