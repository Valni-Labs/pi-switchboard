import assert from "node:assert/strict";
import { test } from "node:test";
import { withSpawnedConnectionId, withMintedConnectionId } from "../toolProxy.ts";

test("mints a fresh connection id for open when the caller supplies none", () => {
	const result = withMintedConnectionId("open_automation_connection", { message: "ping", expects_response: true }) as Record<string, unknown>;
	assert.match(String(result.connection_id), /^con_[0-9a-f]{32}$/);
	assert.equal(result.message, "ping");
});

test("open keeps a caller-supplied connection id and treats whitespace as absent", () => {
	assert.equal(
		(withMintedConnectionId("open_automation_connection", { connection_id: "con_explicit" }) as Record<string, unknown>).connection_id,
		"con_explicit",
	);
	assert.match(
		String((withMintedConnectionId("open_automation_connection", { connection_id: "   " }) as Record<string, unknown>).connection_id),
		/^con_[0-9a-f]{32}$/,
	);
});

test("minting is a no-op for send_message and close (those carry or inject the id)", () => {
	assert.deepEqual(
		withMintedConnectionId("send_message", { message: "x", expects_response: false }),
		{ message: "x", expects_response: false },
	);
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
