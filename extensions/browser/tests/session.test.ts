import assert from "node:assert/strict";
import { test } from "node:test";
import { boundSnapshot, needsReauth, sameLocation, type BrowserPageState } from "../session.ts";

function state(url: string, hasPasswordField: boolean): BrowserPageState {
	return { url, title: "page", hasPasswordField };
}

test("boundSnapshot passes small snapshots through", () => {
	const result = boundSnapshot("- heading \"Hello\" [ref=e2]");
	assert.equal(result.snapshot, "- heading \"Hello\" [ref=e2]");
	assert.equal(result.truncated, false);
});

test("boundSnapshot truncates huge snapshots at a line break", () => {
	const line = `- listitem "${"x".repeat(80)}" [ref=e9]`;
	const huge = Array.from({ length: 500 }, () => line).join("\n");
	const result = boundSnapshot(huge);
	assert.equal(result.truncated, true);
	assert.ok(result.snapshot.length <= 24_000);
	assert.ok(result.snapshot.endsWith("[ref=e9]"));
});

test("sameLocation ignores trailing slashes and queries", () => {
	assert.equal(sameLocation("https://portal.example.com/home/", "https://portal.example.com/home?tab=1"), true);
	assert.equal(sameLocation("https://portal.example.com/home", "https://portal.example.com/login"), false);
	assert.equal(sameLocation("https://portal.example.com/home", "https://other.example.com/home"), false);
	assert.equal(sameLocation("not a url", "not a url"), false);
});

test("needsReauth is false without a password field", () => {
	assert.equal(needsReauth("https://a.example/home", null, state("https://a.example/login", false)), false);
});

test("needsReauth flags a navigation that lands on a login page", () => {
	assert.equal(needsReauth("https://a.example/home", null, state("https://a.example/login", true)), true);
});

test("needsReauth allows navigating to the login page on purpose", () => {
	assert.equal(needsReauth("https://a.example/login", null, state("https://a.example/login?next=home", true)), false);
});

test("needsReauth flags an action that redirects to a login page", () => {
	const previous = state("https://a.example/home", false);
	assert.equal(needsReauth(null, previous, state("https://a.example/login", true)), true);
});

test("needsReauth stays quiet while already on a login page", () => {
	const previous = state("https://a.example/login", true);
	assert.equal(needsReauth(null, previous, state("https://a.example/login", true)), false);
});

test("needsReauth stays quiet when a password field appears in place", () => {
	const previous = state("https://a.example/settings", false);
	assert.equal(needsReauth(null, previous, state("https://a.example/settings", true)), false);
});

test("needsReauth stays quiet with no prior state", () => {
	assert.equal(needsReauth(null, null, state("https://a.example/login", true)), false);
});
