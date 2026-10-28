import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure } from "../errors.ts";

function failure(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), { status: 402, headers: { "Content-Type": "application/json" } });
}

test("SWB-1032 names the most the request can cost and the free balance", async () => {
	const message = await describeFailure(failure({
		code: "SWB-1032",
		error: "This request could cost more than your available balance",
		fault: "client",
		requestId: "rqe_1",
		requiredMicros: 740_000_001,
		availableMicros: 150_000_000,
		balanceMicros: 150_000_000,
	}));
	assert.equal(
		message,
		"This request could cost up to $7.41, and $1.50 of your balance is free. Switchboard holds the most a request can cost until it finishes. Lower max_tokens, pick a smaller model, or add funds at https://valni.app/platform. [SWB-1032, request rqe_1]",
	);
});

test("SWB-1032 without amounts still says what to do", async () => {
	const message = await describeFailure(failure({ code: "SWB-1032", error: "x", fault: "client", requestId: "rqe_2" }));
	assert.match(message, /^This request could cost more than your free balance\. Lower max_tokens/);
});

test("SWB-1007 tells the user to upgrade or add funds", async () => {
	const message = await describeFailure(failure({ code: "SWB-1007", error: "Upgrade subscription or add funds to continue", fault: "client", requestId: "rqe_3" }));
	assert.equal(
		message,
		"Your Switchboard balance is below zero. Upgrade your subscription or add funds at https://valni.app/platform to continue. [SWB-1007, request rqe_3]",
	);
});
