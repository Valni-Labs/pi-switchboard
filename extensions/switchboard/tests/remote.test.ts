import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_UNSENT_OUTCOMES, OutcomeOutbox, WatchRequestQueue, bridgeUrl, parseRelayFrame, turnOutcome } from "../remote.ts";

test("bridge url switches https to wss", () => {
	assert.equal(bridgeUrl("https://switchboard.valni.app"), "wss://switchboard.valni.app/v1/remote/bridge");
	assert.equal(bridgeUrl("http://localhost:8787"), "ws://localhost:8787/v1/remote/bridge");
});

test("relay frames parse message, abort, and ready", () => {
	assert.deepEqual(parseRelayFrame('{"type":"message","message_id":"rmsg_a","text":"hi"}'), {
		type: "message",
		message_id: "rmsg_a",
		text: "hi",
	});
	assert.deepEqual(parseRelayFrame('{"type":"abort","message_id":null}'), { type: "abort", message_id: null });
	assert.deepEqual(parseRelayFrame('{"type":"ready"}'), { type: "ready" });
});

test("unknown or malformed relay frames are ignored", () => {
	assert.equal(parseRelayFrame('{"type":"steer"}'), null);
	assert.equal(parseRelayFrame("not json"), null);
	assert.equal(parseRelayFrame('{"type":"message","text":"no id"}'), null);
	assert.equal(parseRelayFrame(42), null);
});

test("the reply is the last assistant message's text", () => {
	const outcome = turnOutcome([
		{ role: "user", content: [{ type: "text", text: "list PRs" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" },
		{ role: "toolResult", content: [{ type: "text", text: "..." }] },
		{ role: "assistant", content: [{ type: "text", text: "You have three open PRs." }], stopReason: "stop" },
	]);
	assert.deepEqual(outcome, { type: "reply", text: "You have three open PRs." });
});

test("an aborted or failed turn becomes an error outcome", () => {
	assert.deepEqual(turnOutcome([{ role: "assistant", content: [], stopReason: "aborted" }]), {
		type: "error",
		text: "Stopped.",
	});
	assert.deepEqual(turnOutcome([{ role: "assistant", content: [], stopReason: "error", errorMessage: "SWB-1007" }]), {
		type: "error",
		text: "SWB-1007",
	});
	assert.deepEqual(turnOutcome([]), { type: "error", text: "No reply was produced." });
});

test("watch requests run one at a time in arrival order", () => {
	const queue = new WatchRequestQueue();
	queue.enqueue({ messageId: "a", text: "first" });
	queue.enqueue({ messageId: "b", text: "second" });
	assert.deepEqual(queue.startNext(), { messageId: "a", text: "first" });
	assert.equal(queue.startNext(), null);
	assert.equal(queue.current, "a");
	assert.equal(queue.finish(), "a");
	assert.deepEqual(queue.startNext(), { messageId: "b", text: "second" });
});

test("a stop aimed at a finished request does not abort the current one", () => {
	const queue = new WatchRequestQueue();
	queue.enqueue({ messageId: "a", text: "first" });
	queue.startNext();
	queue.finish();
	queue.enqueue({ messageId: "b", text: "second" });
	queue.startNext();
	assert.equal(queue.abortTarget("a"), "none");
	assert.equal(queue.abortTarget("b"), "current");
	assert.equal(queue.abortTarget(null), "current");
});

test("a stop aimed at a queued request removes it without touching the current one", () => {
	const queue = new WatchRequestQueue();
	queue.enqueue({ messageId: "a", text: "first" });
	queue.enqueue({ messageId: "b", text: "second" });
	queue.startNext();
	assert.equal(queue.abortTarget("b"), "queued");
	queue.finish();
	assert.equal(queue.startNext(), null);
});

test("undelivered outcomes are kept, bounded, and drained once", () => {
	const outbox = new OutcomeOutbox();
	for (let index = 0; index < MAX_UNSENT_OUTCOMES + 3; index += 1) outbox.push(String(index));
	const drained = outbox.drain();
	assert.equal(drained.length, MAX_UNSENT_OUTCOMES);
	assert.equal(drained[0], "3");
	assert.deepEqual(outbox.drain(), []);
});
