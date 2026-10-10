// typebox directly, not through a harness package: this extension runs in
// more than one host and must not name any of them at runtime.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl } from "./config.ts";
import { type AdvertisedTool, discoverTools, makeProxyExecute, resolveInvokeToken } from "./toolProxy.ts";

export function registerServerTools(pi: ExtensionAPI, tools: AdvertisedTool[]): void {
	for (const tool of tools) {
		if (!tool.name) continue;
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: Type.Unsafe(tool.parameters),
			execute: makeProxyExecute(tool.name),
		});
	}
}

export function registerServedTools(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const token = await resolveInvokeToken(ctx);
		if (!token) return;
		registerServerTools(pi, await discoverTools(resolveBaseUrl(), token));
	});
}
