import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeUrl, parseRelayFrame, turnOutcome } from "../remote.ts";

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
