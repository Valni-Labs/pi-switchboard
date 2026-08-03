import assert from "node:assert/strict";
import { test } from "node:test";
import { PARTICIPANT_FRAMING, composeParticipantSystemPrompt } from "../participant.ts";

test("composeParticipantSystemPrompt uses the framing alone when there is no existing prompt", () => {
	assert.equal(composeParticipantSystemPrompt(undefined), PARTICIPANT_FRAMING);
	assert.equal(composeParticipantSystemPrompt("   "), PARTICIPANT_FRAMING);
});

test("composeParticipantSystemPrompt appends the framing after an existing prompt", () => {
	const composed = composeParticipantSystemPrompt("You are Pi.");
	assert.ok(composed.startsWith("You are Pi."));
	assert.ok(composed.endsWith(PARTICIPANT_FRAMING));
	assert.ok(composed.includes("\n\n"));
});

test("the framing points at send_message as the only reply channel, the expects_response hint, and close_automation_connection", () => {
	assert.ok(PARTICIPANT_FRAMING.includes("send_message"));
	assert.ok(PARTICIPANT_FRAMING.includes("expects_response"));
	assert.ok(PARTICIPANT_FRAMING.includes("close_automation_connection"));
	assert.ok(PARTICIPANT_FRAMING.includes("stays open"));
});
