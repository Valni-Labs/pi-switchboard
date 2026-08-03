import assert from "node:assert/strict";
import { test } from "node:test";
import { withSpawnedConnectionId } from "../toolProxy.ts";

test("injects the spawned connection id into a send_message call that omits it", () => {
	assert.deepEqual(
		withSpawnedConnectionId("send_message", { message: "pong", expects_response: false }, "con_abc"),
		{ message: "pong", expects_response: false, connection_id: "con_abc" },
	);
});

test("injects the spawned connection id into a close_connection call", () => {
	assert.deepEqual(
		withSpawnedConnectionId("close_connection", { reason: "done" }, "con_abc"),
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
