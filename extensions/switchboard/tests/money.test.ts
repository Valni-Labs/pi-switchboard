import assert from "node:assert/strict";
import test from "node:test";
import { MICRO_CENTS_PER_DOLLAR, dollarsPerMillionTokens, microCents, microCentsPerMillionTokens } from "../money.ts";

test("one dollar is 100,000,000 micro-cents", () => {
	assert.equal(MICRO_CENTS_PER_DOLLAR, 100_000_000);
});

test("microCents accepts safe integers and rejects fractions and NaN", () => {
	assert.equal(microCents(-5_568_090_000), -5_568_090_000);
	assert.throws(() => microCents(1.5));
	assert.throws(() => microCents(Number.NaN));
});

test("prices must be non-negative safe integers and convert to dollars per million tokens", () => {
	assert.equal(dollarsPerMillionTokens(microCentsPerMillionTokens(5_000_000_000)), 50);
	assert.throws(() => microCentsPerMillionTokens(-1));
	assert.throws(() => microCentsPerMillionTokens(0.5));
});
