import assert from "node:assert/strict";
import { test } from "node:test";
import { withSpawnedThreadId } from "../toolProxy.ts";

test("injects the spawned thread id into a send_message call that omits it", () => {
	assert.deepEqual(
		withSpawnedThreadId("send_message", { message: "pong", status: "noResponseNeeded" }, "thr_abc"),
		{ message: "pong", status: "noResponseNeeded", thread_id: "thr_abc" },
	);
});

test("does not override a thread id the caller already supplied", () => {
	assert.deepEqual(
		withSpawnedThreadId("send_message", { message: "pong", status: "noResponseNeeded", thread_id: "thr_explicit" }, "thr_abc"),
		{ message: "pong", status: "noResponseNeeded", thread_id: "thr_explicit" },
	);
});

test("is a no-op for other tools", () => {
	assert.deepEqual(
		withSpawnedThreadId("some_other_tool", { foo: 1 }, "thr_abc"),
		{ foo: 1 },
	);
});

test("is a no-op when no spawned thread id is present (an interactive seat session)", () => {
	assert.deepEqual(
		withSpawnedThreadId("send_message", { message: "pong", status: "noResponseNeeded" }, undefined),
		{ message: "pong", status: "noResponseNeeded" },
	);
	assert.deepEqual(
		withSpawnedThreadId("send_message", { message: "pong", status: "noResponseNeeded" }, ""),
		{ message: "pong", status: "noResponseNeeded" },
	);
});
