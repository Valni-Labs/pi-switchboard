import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LOCAL_TOOL_CHANNEL = "valni:local-tool";
export const EXECUTION_META_KEY = "valni/execution";
export const LOCAL_EXECUTION = "local";
export const SERVER_EXECUTION = "server";
export type ToolExecution = typeof LOCAL_EXECUTION | typeof SERVER_EXECUTION;

const BROWSER_LOCAL_INSTALL = "pi install https://github.com/Valni-Labs/browser-local";

export interface LocalToolCall {
	name: string;
	params: unknown;
	signal: AbortSignal | undefined;
	claim(): void;
	resolve(result: AgentToolResult<unknown>): void;
	reject(error: Error): void;
}

export function executionOf(meta: unknown): ToolExecution {
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return SERVER_EXECUTION;
	return (meta as Record<string, unknown>)[EXECUTION_META_KEY] === LOCAL_EXECUTION ? LOCAL_EXECUTION : SERVER_EXECUTION;
}

export function makeLocalExecute(events: Pick<ExtensionAPI["events"], "emit">, name: string) {
	return (_toolCallId: string, params: unknown, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> =>
		new Promise((resolve, reject) => {
			let claimed = false;
			const call: LocalToolCall = {
				name,
				params,
				signal,
				claim: () => {
					claimed = true;
				},
				resolve,
				reject,
			};
			events.emit(LOCAL_TOOL_CHANNEL, call);
			if (!claimed) {
				reject(new Error(`${name} runs on this computer, but no installed extension runs it. For the browser tools, install browser-local: ${BROWSER_LOCAL_INSTALL}`));
			}
		});
}
