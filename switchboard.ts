import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AnthropicOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AnthropicMessagesModule {
	stream(
		model: Model<"anthropic-messages">,
		context: Context,
		options?: AnthropicOptions,
	): AssistantMessageEventStream;
}

interface SimpleOptionsModule {
	buildBaseOptions(
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
		apiKey?: string,
	): StreamOptions;
	adjustMaxTokensForThinking(
		baseMaxTokens: number | undefined,
		modelMaxTokens: number,
		reasoningLevel: ThinkingLevel,
		customBudgets?: ThinkingBudgets,
	): { maxTokens: number; thinkingBudget: number };
	clampMaxTokensToContext(model: Model<"anthropic-messages">, context: Context, maxTokens: number): number;
}

let anthropicMessages: AnthropicMessagesModule;
let simpleOptions: SimpleOptionsModule;

function findPiAiDist(): string {
	let current = dirname(realpathSync(process.argv[1]));
	while (true) {
		const candidate = join(current, "node_modules", "@earendil-works", "pi-ai", "dist");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) {
			throw new Error("pi-switchboard: cannot locate @earendil-works/pi-ai relative to the pi executable");
		}
		current = parent;
	}
}

async function loadPiAiModules(): Promise<void> {
	const distDirectory = findPiAiDist();
	anthropicMessages = (await import(
		pathToFileURL(join(distDirectory, "api", "anthropic-messages.js")).href
	)) as AnthropicMessagesModule;
	simpleOptions = (await import(
		pathToFileURL(join(distDirectory, "api", "simple-options.js")).href
	)) as SimpleOptionsModule;
}

const PROVIDER_ID = "switchboard";
const PROVIDER_NAME = "Switchboard";
const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const INFERENCE_PATH = "/v1/switchboard/inference";
const MODELS_PATH = "/v1/models";
const WIRE_FORMAT_ANTHROPIC_MESSAGES = "anthropic-messages";
const IMAGE_INPUT_FORMAT = "image";
const MINIMUM_OUTPUT_TOKENS = 1024;
const ERROR_DETAIL_LIMIT = 300;

interface PickerModel {
	id: string;
	display_name: string;
	context_window: number;
	max_output_tokens: number | null;
	input_formats: string[];
	capabilities: string[];
	wire_format: string;
}

interface ModelsPage {
	models: PickerModel[];
}

interface SwitchboardErrorEnvelope {
	code?: string;
	error?: string;
	fault?: string;
	requestId?: string;
}

function resolveBaseUrl(): string {
	return process.env.SWITCHBOARD_BASE_URL ?? DEFAULT_BASE_URL;
}

function requireEnvironmentVariable(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set; export it before starting pi (see pi-switchboard README)`);
	}
	return value;
}

async function describeFailure(response: Response): Promise<string> {
	const text = await response.text();
	let envelope: SwitchboardErrorEnvelope;
	try {
		envelope = JSON.parse(text) as SwitchboardErrorEnvelope;
	} catch {
		return `Switchboard HTTP ${response.status}: ${text.slice(0, ERROR_DETAIL_LIMIT)}`;
	}
	if (!envelope.code || !envelope.error) {
		return `Switchboard HTTP ${response.status}: ${text.slice(0, ERROR_DETAIL_LIMIT)}`;
	}
	const requestSuffix = envelope.requestId ? ` request ${envelope.requestId}` : "";
	const faultSuffix = envelope.fault ? ` fault ${envelope.fault}` : "";
	return `Switchboard ${envelope.code}: ${envelope.error} (HTTP ${response.status}${faultSuffix}${requestSuffix})`;
}

function switchboardClient(apiKey: string): Anthropic {
	const client = {
		messages: {
			create(params: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }) {
				const responsePromise = (async () => {
					const response = await fetch(`${resolveBaseUrl()}${INFERENCE_PATH}`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey}`,
						},
						body: JSON.stringify({
							user_id: requireEnvironmentVariable("SWITCHBOARD_END_USER_ID"),
							time: new Date().toISOString(),
							idempotency_key: crypto.randomUUID(),
							kind: { anthropic: params },
						}),
						signal: requestOptions?.signal ?? null,
					});
					if (!response.ok) {
						throw new Error(await describeFailure(response));
					}
					return response;
				})();
				return { asResponse: () => responsePromise };
			},
		},
	};
	return client as unknown as Anthropic;
}

function streamSwitchboard(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error("SWITCHBOARD_API_KEY is not set; export it before starting pi (see pi-switchboard README)");
	}
	const base = {
		...simpleOptions.buildBaseOptions(model, context, options, apiKey),
		client: switchboardClient(apiKey),
	};
	if (!options?.reasoning) {
		return anthropicMessages.stream(model, context, { ...base, thinkingEnabled: false });
	}
	const adjusted = simpleOptions.adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	const maxTokens = simpleOptions.clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return anthropicMessages.stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - MINIMUM_OUTPUT_TOKENS)),
	});
}

async function discoverModels(baseUrl: string, apiKey: string): Promise<PickerModel[]> {
	const response = await fetch(`${baseUrl}${MODELS_PATH}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		throw new Error(await describeFailure(response));
	}
	const page = (await response.json()) as ModelsPage;
	return page.models;
}

export default async function (pi: ExtensionAPI) {
	await loadPiAiModules();
	const baseUrl = resolveBaseUrl();
	const apiKey = requireEnvironmentVariable("SWITCHBOARD_API_KEY");
	const discovered = await discoverModels(baseUrl, apiKey);
	const anthropicModels = discovered.filter(model => model.wire_format === WIRE_FORMAT_ANTHROPIC_MESSAGES);
	const usable = anthropicModels.filter(model => model.max_output_tokens !== null);
	const skipped = anthropicModels.filter(model => model.max_output_tokens === null);
	if (skipped.length > 0) {
		console.error(
			`pi-switchboard: skipped ${skipped.length} model(s) missing max_output_tokens: ${skipped.map(model => model.id).join(", ")}`,
		);
	}
	if (usable.length === 0) {
		throw new Error(
			`pi-switchboard: no anthropic-messages models available from ${baseUrl}${MODELS_PATH} (${discovered.length} model(s) total)`,
		);
	}
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "$SWITCHBOARD_API_KEY",
		api: "anthropic-messages",
		models: usable.map(model => ({
			id: model.id,
			name: model.display_name,
			reasoning: model.capabilities.includes("reasoning"),
			input: model.input_formats.includes(IMAGE_INPUT_FORMAT) ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.context_window,
			maxTokens: model.max_output_tokens ?? MINIMUM_OUTPUT_TOKENS,
		})),
		streamSimple: streamSwitchboard,
	});
}
