import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskHistory, withHistoryPrepended, type HistoryEntry } from "../taskHistory.ts";

function userMessage(text: string): unknown {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMessage(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 };
}

test("parseTaskHistory returns an empty list when the variable is unset or blank", () => {
	assert.deepEqual(parseTaskHistory(undefined), []);
	assert.deepEqual(parseTaskHistory("   "), []);
});

test("parseTaskHistory reads a verbatim conversation with roles", () => {
	const raw = JSON.stringify([
		{ role: "user", content: "review PR #42" },
		{ role: "assistant", content: "the auth check is wrong" },
	]);
	assert.deepEqual(parseTaskHistory(raw), [
		{ role: "user", content: "review PR #42" },
		{ role: "assistant", content: "the auth check is wrong" },
	]);
});

test("parseTaskHistory fails loudly on malformed input rather than dropping context", () => {
	assert.throws(() => parseTaskHistory("{not json"), /not valid JSON/);
	assert.throws(() => parseTaskHistory(JSON.stringify({ role: "user" })), /must be a JSON array/);
	assert.throws(() => parseTaskHistory(JSON.stringify([{ role: "system", content: "x" }])), /role must be/);
	assert.throws(() => parseTaskHistory(JSON.stringify([{ role: "user", content: "" }])), /content must be/);
});

test("withHistoryPrepended prepends the prior turns as real role-tagged messages", () => {
	const history: HistoryEntry[] = [
		{ role: "user", content: "review PR #42" },
		{ role: "assistant", content: "the auth check is wrong" },
	];
	const current = [userMessage("fix it")];
	const next = withHistoryPrepended(history, current as never);
	assert.notEqual(next, null);
	const roles = (next as { role: string }[]).map(message => message.role);
	assert.deepEqual(roles, ["user", "assistant", "user"]);
	const lastContent = (next as { content: { text: string }[] }[])[2].content[0].text;
	assert.equal(lastContent, "fix it");
});

test("withHistoryPrepended is a no-op when there is no history", () => {
	assert.equal(withHistoryPrepended([], [userMessage("hello")] as never), null);
});

test("withHistoryPrepended does not double-prepend when the whole history is already at the head", () => {
	const history: HistoryEntry[] = [
		{ role: "user", content: "review PR #42" },
		{ role: "assistant", content: "the auth check is wrong" },
	];
	const alreadySeeded = [
		userMessage("review PR #42"),
		assistantMessage("the auth check is wrong"),
		userMessage("fix it"),
	];
	assert.equal(withHistoryPrepended(history, alreadySeeded as never), null);
});

test("withHistoryPrepended still prepends when only the first turn matches but the rest of the history is missing", () => {
	const history: HistoryEntry[] = [
		{ role: "user", content: "review PR #42" },
		{ role: "assistant", content: "the auth check is wrong" },
	];
	const partial = [userMessage("review PR #42"), userMessage("fix it")];
	const next = withHistoryPrepended(history, partial as never);
	assert.notEqual(next, null);
	const roles = (next as { role: string }[]).map(message => message.role);
	assert.deepEqual(roles, ["user", "assistant", "user", "user"]);
});
