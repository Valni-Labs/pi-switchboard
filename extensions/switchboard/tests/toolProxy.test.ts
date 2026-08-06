import assert from "node:assert/strict";
import { test } from "node:test";
import { withSpawnedConnectionId, discoverTools, toAgentContent } from "../toolProxy.ts";

test("discoverTools posts /mcp tools/list and maps inputSchema to parameters", async () => {
	const original = globalThis.fetch;
	let captured: { url: string; method: unknown } | null = null;
	globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
		captured = { url: String(url), method: (JSON.parse(String(init.body)) as { method: unknown }).method };
		return new Response(
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "browser_navigate", description: "Navigate", inputSchema: { type: "object" } }] } }),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const tools = await discoverTools("https://sb", "vst_x");
		assert.equal(captured?.url, "https://sb/mcp");
		assert.equal(captured?.method, "tools/list");
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "browser_navigate");
		assert.deepEqual(tools[0].parameters, { type: "object" });
	} finally {
		globalThis.fetch = original;
	}
});

test("toAgentContent maps MCP text and image content through unchanged", () => {
	assert.deepEqual(
		toAgentContent([
			{ type: "text", text: "the page" },
			{ type: "image", data: "BASE64", mimeType: "image/jpeg" },
		]),
		[
			{ type: "text", text: "the page" },
			{ type: "image", data: "BASE64", mimeType: "image/jpeg" },
		],
	);
});

test("toAgentContent dumps an unexpected non-array payload instead of dropping it", () => {
	assert.deepEqual(toAgentContent({ unexpected: true }), [{ type: "text", text: JSON.stringify({ unexpected: true }) }]);
	assert.deepEqual(toAgentContent([]), [{ type: "text", text: "[]" }]);
});

test("injects the spawned connection id into a send_message call that omits it", () => {
	assert.deepEqual(
		withSpawnedConnectionId("send_message", { message: "pong", expects_response: false }, "con_abc"),
		{ message: "pong", expects_response: false, connection_id: "con_abc" },
	);
});

test("injects the spawned connection id into a close_automation_connection call", () => {
	assert.deepEqual(
		withSpawnedConnectionId("close_automation_connection", { reason: "done" }, "con_abc"),
		{ reason: "done", connection_id: "con_abc" },
	);
});

test("does not override a connection id the caller already supplied", () => {
	assert.deepEqual(
		withSpawnedConnectionId("send_message", { message: "pong", expects_response: false, connection_id: "con_explicit" }, "con_abc"),
		{ message: "pong", expects_response: false, connection_id: "con_explicit" },
	);
});

test("treats a whitespace-only caller-supplied connection id as absent and injects", () => {
	assert.deepEqual(
		withSpawnedConnectionId("send_message", { message: "pong", expects_response: false, connection_id: "   " }, "con_abc"),
		{ message: "pong", expects_response: false, connection_id: "con_abc" },
	);
});

test("is a no-op for other tools (open_connection is never auto-filled)", () => {
	assert.deepEqual(
		withSpawnedConnectionId("open_connection", { message: "hi", expects_response: true }, "con_abc"),
		{ message: "hi", expects_response: true },
	);
});

test("is a no-op when there is no spawned connection id (an interactive seat session)", () => {
	assert.deepEqual(
		withSpawnedConnectionId("send_message", { message: "pong", expects_response: false }, null),
		{ message: "pong", expects_response: false },
	);
});
