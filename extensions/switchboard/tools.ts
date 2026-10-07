// typebox directly, not through a harness package: this extension runs in
// more than one host and must not name any of them at runtime.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AdvertisedTool, makeProxyExecute } from "./toolProxy.ts";

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
