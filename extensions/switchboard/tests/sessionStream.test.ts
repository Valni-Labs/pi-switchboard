import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnedStreamKey } from "../sessionStream.ts";

test("a spawned container streams with its injected swb_ key", () => {
	assert.equal(spawnedStreamKey("con_abc", "swb_live_key"), "swb_live_key");
});

test("no connection id (an interactive seat) uses the OAuth path, not the env key", () => {
	assert.equal(spawnedStreamKey(null, "swb_live_key"), null);
});

test("a spawned container with no key present yields no token", () => {
	assert.equal(spawnedStreamKey("con_abc", undefined), null);
	assert.equal(spawnedStreamKey("con_abc", "   "), null);
});
