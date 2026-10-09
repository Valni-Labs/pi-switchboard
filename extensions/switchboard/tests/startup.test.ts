import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_URL, startupLines } from "../startup.ts";

test("startupLines names the signed-in email and points at the portal", () => {
	assert.deepEqual(startupLines("ben@example.com"), [
		"Signed in to Switchboard as ben@example.com.",
		`Configure skills, tools, permissions, and more in the Switchboard portal: ${PORTAL_URL}`,
	]);
});

test("startupLines omits the email when there is none", () => {
	assert.deepEqual(startupLines(null), [
		`Configure skills, tools, permissions, and more in the Switchboard portal: ${PORTAL_URL}`,
	]);
});
