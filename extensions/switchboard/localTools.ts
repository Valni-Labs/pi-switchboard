import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LOCAL_TOOL_CHANNEL = "valni:local-tool";
export const EXECUTION_META_KEY = "valni/execution";
export const EXTENSION_META_KEY = "valni/extension";
export const LOCAL_EXECUTION = "local";
export const SERVER_EXECUTION = "server";
export type ToolExecution = typeof LOCAL_EXECUTION | typeof SERVER_EXECUTION;

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

export function extensionOf(meta: unknown): string | null {
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
	const extension = (meta as Record<string, unknown>)[EXTENSION_META_KEY];
	return typeof extension === "string" && extension.trim() !== "" ? extension.trim() : null;
}

export function unclaimedMessage(name: string, extension: string | null): string {
	const lead = `${name} runs on this computer, but no installed extension runs it.`;
	return extension === null ? lead : `${lead} Install the extension that runs it: pi install ${extension}`;
}

export function makeLocalExecute(events: Pick<ExtensionAPI["events"], "emit">, name: string, extension: string | null) {
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
				reject(new Error(unclaimedMessage(name, extension)));
			}
		});
}
