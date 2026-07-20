import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "switchboard";
const PROVIDER_NAME = "Switchboard";
const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const INFERENCE_PATH = "/v1/switchboard/inference";
const MODELS_PATH = "/v1/models";
const SENTINEL_SEGMENT = "/pi-switchboard/";
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const UNKNOWN_CONTEXT_WINDOW = 0;
const ERROR_DETAIL_LIMIT = 300;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

const KIND_TO_API = {
	anthropic: "anthropic-messages",
	openai_generic: "openai-completions",
	openai_pro: "openai-responses",
} as const;

type SwitchboardKind = keyof typeof KIND_TO_API;

interface NativeProfile {
	model: string;
	maxTokensCeiling?: number;
	vision?: boolean;
	thinking?: { modes: string[] };
	reasoningEffort?: boolean | string[];
}

interface CatalogModel {
	id: string;
	kind: Partial<Record<SwitchboardKind, NativeProfile>>;
}

interface CatalogPrice {
	input_micro_cents_per_mtok: number;
	output_micro_cents_per_mtok: number;
	cached_input_micro_cents_per_mtok?: number;
}

interface CatalogPage {
	models: CatalogModel[];
	prices: Record<string, CatalogPrice>;
}

interface SwitchboardErrorEnvelope {
	code?: string;
	error?: string;
	fault?: string;
	requestId?: string;
}

type RegistryModel = Model<(typeof KIND_TO_API)[SwitchboardKind]>;

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

async function loadRegistryModels(): Promise<Record<string, RegistryModel>> {
	const distDirectory = findPiAiDist();
	const registry: Record<string, RegistryModel> = {};
	for (const file of ["anthropic.models.js", "openai.models.js"]) {
		const loaded = (await import(pathToFileURL(join(distDirectory, "providers", file)).href)) as Record<
			string,
			Record<string, RegistryModel>
		>;
		for (const exported of Object.values(loaded)) {
			if (exported === null || typeof exported !== "object") continue;
			for (const model of Object.values(exported)) {
				if (model && typeof model === "object" && "id" in model) registry[model.id] = model;
			}
		}
	}
	return registry;
}

function isEnvelopeTarget(url: string): SwitchboardKind | null {
	const sentinelIndex = url.indexOf(SENTINEL_SEGMENT);
	if (sentinelIndex === -1) return null;
	const kindTag = url.slice(sentinelIndex + SENTINEL_SEGMENT.length).split("/")[0];
	return kindTag in KIND_TO_API ? (kindTag as SwitchboardKind) : null;
}

let envelopeFetchInstalled = false;

function installEnvelopeFetch(): void {
	if (envelopeFetchInstalled) return;
	envelopeFetchInstalled = true;
	const baseFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		const kindTag = isEnvelopeTarget(url);
		if (kindTag === null) return baseFetch(input, init);
		const request = new Request(input, init);
		const nativeBody = (await request.json()) as Record<string, unknown>;
		const headers = new Headers(request.headers);
		headers.set("Content-Type", "application/json");
		const anthropicStyleKey = headers.get("x-api-key");
		if (!headers.has("Authorization") && anthropicStyleKey) {
			headers.set("Authorization", `Bearer ${anthropicStyleKey}`);
			headers.delete("x-api-key");
		}
		return baseFetch(`${resolveBaseUrl()}${INFERENCE_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				user_id: requireEnvironmentVariable("SWITCHBOARD_END_USER_ID"),
				time: new Date().toISOString(),
				idempotency_key: crypto.randomUUID(),
				kind: { [kindTag]: nativeBody },
			}),
			signal: request.signal,
		});
	};
}

function profileKind(catalogModel: CatalogModel): { kindTag: SwitchboardKind; profile: NativeProfile } | null {
	for (const kindTag of Object.keys(KIND_TO_API) as SwitchboardKind[]) {
		const profile = catalogModel.kind[kindTag];
		if (profile) return { kindTag, profile };
	}
	return null;
}

function profileSupportsReasoning(kindTag: SwitchboardKind, profile: NativeProfile): boolean {
	if (kindTag === "anthropic") {
		const modes = profile.thinking?.modes ?? [];
		return modes.some(mode => mode !== "disabled");
	}
	if (Array.isArray(profile.reasoningEffort)) return profile.reasoningEffort.length > 0;
	return profile.reasoningEffort === true;
}

function toCost(price: CatalogPrice | undefined, registryModel: RegistryModel | undefined) {
	if (price) {
		return {
			input: price.input_micro_cents_per_mtok / MICRO_CENTS_PER_DOLLAR,
			output: price.output_micro_cents_per_mtok / MICRO_CENTS_PER_DOLLAR,
			cacheRead: (price.cached_input_micro_cents_per_mtok ?? 0) / MICRO_CENTS_PER_DOLLAR,
			cacheWrite: 0,
		};
	}
	if (registryModel) return registryModel.cost;
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function toModelConfig(
	catalogModel: CatalogModel,
	kindTag: SwitchboardKind,
	profile: NativeProfile,
	price: CatalogPrice | undefined,
	registryModel: RegistryModel | undefined,
) {
	return {
		id: catalogModel.id,
		name: registryModel?.name ?? catalogModel.id,
		api: KIND_TO_API[kindTag],
		baseUrl: `${resolveBaseUrl()}${SENTINEL_SEGMENT}${kindTag}`,
		reasoning: profileSupportsReasoning(kindTag, profile),
		thinkingLevelMap: registryModel?.thinkingLevelMap,
		input: profile.vision ? ["text", "image"] : (registryModel?.input ?? ["text"]),
		cost: toCost(price, registryModel),
		contextWindow: registryModel?.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
		maxTokens: profile.maxTokensCeiling ?? registryModel?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		compat:
			registryModel?.compat ??
			(kindTag === "openai_generic" ? { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const } : undefined),
	};
}

async function discoverCatalog(baseUrl: string, apiKey: string): Promise<CatalogPage> {
	const response = await fetch(`${baseUrl}${MODELS_PATH}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(await describeFailure(response));
	}
	return (await response.json()) as CatalogPage;
}

export default async function (pi: ExtensionAPI) {
	const baseUrl = resolveBaseUrl();
	const apiKey = requireEnvironmentVariable("SWITCHBOARD_API_KEY");
	requireEnvironmentVariable("SWITCHBOARD_END_USER_ID");
	const [catalog, registry] = await Promise.all([discoverCatalog(baseUrl, apiKey), loadRegistryModels()]);
	const modelConfigs = [];
	const skipped: string[] = [];
	for (const catalogModel of catalog.models) {
		const resolved = profileKind(catalogModel);
		if (!resolved) {
			skipped.push(catalogModel.id);
			continue;
		}
		modelConfigs.push(
			toModelConfig(
				catalogModel,
				resolved.kindTag,
				resolved.profile,
				catalog.prices[catalogModel.id],
				registry[catalogModel.id],
			),
		);
	}
	if (skipped.length > 0) {
		console.error(`pi-switchboard: skipped model(s) with no recognized kind: ${skipped.join(", ")}`);
	}
	if (modelConfigs.length === 0) {
		throw new Error(
			`pi-switchboard: no models available from ${baseUrl}${MODELS_PATH} (${catalog.models.length} entries total)`,
		);
	}
	installEnvelopeFetch();
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "$SWITCHBOARD_API_KEY",
		models: modelConfigs,
	});
}
