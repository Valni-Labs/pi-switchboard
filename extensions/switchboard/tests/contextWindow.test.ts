import assert from "node:assert/strict";
import test from "node:test";
import { buildModelConfigs } from "../catalog.ts";
import type { ModelsPage, RegistryModel } from "../types.ts";
import { microCentsPerMillionTokens } from "../money.ts";

const price = {
	input_micro_cents_per_mtok: microCentsPerMillionTokens(100),
	output_micro_cents_per_mtok: microCentsPerMillionTokens(200),
	cached_input_micro_cents_per_mtok: null,
	effective_at: 0,
};

function catalog(ids: string[], contextWindows?: Record<string, number>): ModelsPage {
	return {
		models: ids.map((id) => ({ id, kind: { openai_generic: { model: id } } })),
		prices: Object.fromEntries(ids.map((id) => [id, price])),
		...(contextWindows ? { context_windows: contextWindows } : {}),
	};
}

function captureStderr(run: () => void): string[] {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		run();
	} finally {
		console.error = original;
	}
	return lines;
}

test("a model the registry does not know never reports a zero context window", () => {
	let configs: ReturnType<typeof buildModelConfigs> = [];
	captureStderr(() => {
		configs = buildModelConfigs(catalog(["grok-4.5-xai-sub"]), {});
	});
	assert.equal(configs.length, 1);
	assert.equal(configs[0].contextWindow, 128_000);
});

test("zero would make pi compact on every turn, which is why the default exists", () => {
	let configs: ReturnType<typeof buildModelConfigs> = [];
	captureStderr(() => {
		configs = buildModelConfigs(catalog(["grok-4.5-xai-sub"]), {});
	});
	const reserveTokens = 16_384;
	const contextTokens = 50_000;
	assert.equal(contextTokens > configs[0].contextWindow - reserveTokens, false);
	assert.equal(contextTokens > 0 - reserveTokens, true);
});

test("the assumption is reported rather than made silently", () => {
	const lines = captureStderr(() => buildModelConfigs(catalog(["a", "b"]), {}));
	const notice = lines.find((line) => line.includes("context window"));
	assert.ok(notice, "expected a notice naming the assumption");
	assert.match(notice, /2 of 2 models/u);
	assert.match(notice, /128,000/u);
});

test("a registry entry with no input list does not crash the catalog", () => {
	const registry = { known: { contextWindow: 200_000, maxTokens: 8192 } as unknown as RegistryModel };
	let configs: ReturnType<typeof buildModelConfigs> = [];
	captureStderr(() => {
		configs = buildModelConfigs(catalog(["known"]), registry);
	});
	assert.deepEqual(configs[0].input, ["text"]);
});

test("a registry match keeps its real window and is not counted as assumed", () => {
	const registry = { known: { contextWindow: 200_000, maxTokens: 8192, input: ["text"] } as unknown as RegistryModel };
	let configs: ReturnType<typeof buildModelConfigs> = [];
	const lines = captureStderr(() => {
		configs = buildModelConfigs(catalog(["known"]), registry);
	});
	assert.equal(configs[0].contextWindow, 200_000);
	assert.equal(lines.filter((line) => line.includes("context window")).length, 0);
});

test("the catalog's own context window wins over the assumption", () => {
	let configs: ReturnType<typeof buildModelConfigs> = [];
	const lines = captureStderr(() => {
		configs = buildModelConfigs(catalog(["grok-4.5-xai-sub"], { "grok-4.5-xai-sub": 3_000_000 }), {});
	});
	assert.equal(configs[0].contextWindow, 3_000_000);
	assert.equal(lines.filter((line) => line.includes("context window")).length, 0);
});

test("the catalog also beats a registry match, because the catalog is the source of truth", () => {
	const registry = { known: { contextWindow: 200_000, maxTokens: 8192, input: ["text"] } as unknown as RegistryModel };
	let configs: ReturnType<typeof buildModelConfigs> = [];
	captureStderr(() => {
		configs = buildModelConfigs(catalog(["known"], { known: 1_000_000 }), registry);
	});
	assert.equal(configs[0].contextWindow, 1_000_000);
});

test("a model the catalog omits still falls back, and is still reported", () => {
	let configs: ReturnType<typeof buildModelConfigs> = [];
	const lines = captureStderr(() => {
		configs = buildModelConfigs(catalog(["a", "b"], { a: 500_000 }), {});
	});
	assert.equal(configs[0].contextWindow, 500_000);
	assert.equal(configs[1].contextWindow, 128_000);
	assert.ok(lines.find((line) => /1 of 2 models/u.test(line)));
});

test("a real window that happens to equal the default is not called an assumption", () => {
	const registry = {
		exactly128k: { contextWindow: 128_000, maxTokens: 8192, input: ["text"] } as unknown as RegistryModel,
	};
	let configs: ReturnType<typeof buildModelConfigs> = [];
	const lines = captureStderr(() => {
		configs = buildModelConfigs(catalog(["exactly128k"]), registry);
	});
	assert.equal(configs[0].contextWindow, 128_000);
	assert.equal(lines.filter((line) => line.includes("context window")).length, 0);
});

test("a catalog value equal to the default is also a real value", () => {
	const lines = captureStderr(() => buildModelConfigs(catalog(["m"], { m: 128_000 }), {}));
	assert.equal(lines.filter((line) => line.includes("context window")).length, 0);
});

test("a model is named the way the catalog names it", () => {
	const configs = buildModelConfigs(
		{
			models: [{ id: "kimi-k3-coding-sub", access_tier: "pro", kind: { anthropic: { kind: "anthropic", model: "k3" } } }],
			prices: {},
			context_windows: { "kimi-k3-coding-sub": 1_048_576 },
			display_names: { "kimi-k3-coding-sub": "Kimi K3 (coding subscription)" },
		} as never,
		{},
	);
	assert.equal(configs[0].name, "Kimi K3 (coding subscription)");
});

test("without a catalog name a model falls back to its id, not to nothing", () => {
	const configs = buildModelConfigs(
		{
			models: [{ id: "kimi-k3-coding-sub", access_tier: "pro", kind: { anthropic: { kind: "anthropic", model: "k3" } } }],
			prices: {},
			context_windows: { "kimi-k3-coding-sub": 1_048_576 },
		} as never,
		{},
	);
	assert.equal(configs[0].name, "kimi-k3-coding-sub");
});
