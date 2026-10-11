import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { discoverTools } from "../toolProxy.ts";
import { executionOf, LOCAL_TOOL_CHANNEL, makeLocalExecute, type LocalToolCall } from "../localTools.ts";

function eventBus() {
	const emitter = new EventEmitter();
	return {
		emit: (channel: string, data: unknown) => {
			emitter.emit(channel, data);
		},
		on: (channel: string, handler: (data: unknown) => Promise<void> | void) => {
			const safe = async (data: unknown) => {
				try {
					await handler(data);
				} catch {
					return;
				}
			};
			emitter.on(channel, safe);
		},
	};
}

test("executionOf reads the local marker and treats anything else as server", () => {
	assert.equal(executionOf({ "valni/execution": "local" }), "local");
	assert.equal(executionOf({ "valni/execution": "server" }), "server");
	assert.equal(executionOf(undefined), "server");
	assert.equal(executionOf(["local"]), "server");
});

test("discoverTools carries the execution marker from tools/list", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					tools: [
						{ name: "browser_navigate", description: "Navigate", inputSchema: { type: "object" }, _meta: { "valni/execution": "local" } },
						{ name: "send_message", description: "Send", inputSchema: { type: "object" } },
					],
				},
			}),
			{ status: 200 },
		)) as typeof fetch;
	try {
		const tools = await discoverTools("https://sb", "vst_x");
		assert.deepEqual(
			tools.map((tool) => [tool.name, tool.execution]),
			[
				["browser_navigate", "local"],
				["send_message", "server"],
			],
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("a local tool call is answered by the extension that claims it", async () => {
	const bus = eventBus();
	const seen: unknown[] = [];
	bus.on(LOCAL_TOOL_CHANNEL, async (data) => {
		const call = data as LocalToolCall;
		if (call.name !== "browser_navigate") return;
		call.claim();
		seen.push(call.params);
		await Promise.resolve();
		call.resolve({ content: [{ type: "text", text: "navigated" }], details: null });
	});
	const result = await makeLocalExecute(bus, "browser_navigate")("call_1", { url: "https://example.com" }, undefined);
	assert.deepEqual(seen, [{ url: "https://example.com" }]);
	assert.deepEqual(result.content, [{ type: "text", text: "navigated" }]);
});

test("a local tool error reaches the agent as a rejected call", async () => {
	const bus = eventBus();
	bus.on(LOCAL_TOOL_CHANNEL, (data) => {
		const call = data as LocalToolCall;
		call.claim();
		call.reject(new Error("No open browser. Call open_browser_automation first."));
	});
	await assert.rejects(makeLocalExecute(bus, "browser_click")("call_2", { ref: "e1" }, undefined), /No open browser/);
});

test("a local tool nobody claims fails with the install command", async () => {
	const bus = eventBus();
	bus.on(LOCAL_TOOL_CHANNEL, () => undefined);
	await assert.rejects(makeLocalExecute(bus, "browser_snapshot")("call_3", {}, undefined), /pi install https:\/\/github\.com\/Valni-Labs\/browser-local/);
});
