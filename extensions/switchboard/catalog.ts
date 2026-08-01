import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Credential } from "@earendil-works/pi-ai";
import { SENTINEL_SEGMENT } from "./constants.ts";
import { rememberSessionCredentials, resolveBaseUrl, setSessionEndUserId } from "./config.ts";
import { describeFailure, describeNetworkFailure, isAbortError, singleLine } from "./errors.ts";
import { KIND_TO_API, type KindProfile, type ModelRecord, type ModelRecordPrice, type ModelsPage, type RegistryModel, type SwitchboardKind } from "./types.ts";

const MODELS_PATH = "/v1/models";
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const UNKNOWN_CONTEXT_WINDOW = 0;

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

export async function loadRegistryModels(): Promise<Record<string, RegistryModel>> {
	const distDirectory = findPiAiDist();
	const registry: Record<string, RegistryModel> = {};
	for (const file of ["anthropic.models.js", "openai.models.js"]) {
		let loaded: Record<string, Record<string, RegistryModel>>;
		try {
			loaded = (await import(pathToFileURL(join(distDirectory, "providers", file)).href)) as Record<
				string,
				Record<string, RegistryModel>
			>;
		} catch (error) {
			if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") continue;
			throw error;
		}
		for (const exported of Object.values(loaded)) {
			if (exported === null || typeof exported !== "object") continue;
			for (const model of Object.values(exported)) {
				if (model && typeof model === "object" && "id" in model) registry[model.id] = model;
			}
		}
	}
	return registry;
}

function supportsReasoning(kindTag: SwitchboardKind, profile: KindProfile): boolean | undefined {
	const declared = kindTag === "anthropic" ? profile.thinking : profile.reasoningEffort;
	if (declared === undefined) return undefined;
	if (declared === false) return false;
	if (Array.isArray(declared)) return declared.length > 0;
	return declared.modes.length > 0;
}

function toCost(price: ModelRecordPrice | undefined, registryModel: RegistryModel | undefined) {
	if (price === undefined) return registryModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: price.input_micro_cents_per_mtok / MICRO_CENTS_PER_DOLLAR,
		output: price.output_micro_cents_per_mtok / MICRO_CENTS_PER_DOLLAR,
		cacheRead: (price.cached_input_micro_cents_per_mtok ?? 0) / MICRO_CENTS_PER_DOLLAR,
		cacheWrite: 0,
	};
}

function toModelConfig(
	record: ModelRecord,
	kindTag: SwitchboardKind,
	profile: KindProfile,
	price: ModelRecordPrice | undefined,
	registryModel: RegistryModel | undefined,
) {
	return {
		id: record.id,
		name: registryModel?.name ?? record.id,
		api: KIND_TO_API[kindTag],
		baseUrl: `${resolveBaseUrl()}${SENTINEL_SEGMENT}${kindTag}`,
		reasoning: supportsReasoning(kindTag, profile) ?? registryModel?.reasoning ?? false,
		thinkingLevelMap: registryModel?.thinkingLevelMap,
		input: (profile.vision ?? registryModel?.input.includes("image") ?? false) ? ["text", "image"] : ["text"],
		cost: toCost(price, registryModel),
		contextWindow: registryModel?.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
		maxTokens: profile.maxTokensCeiling ?? registryModel?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		compat:
			registryModel?.compat ??
			(kindTag === "openai_generic" ? { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const } : undefined),
	};
}

export async function discoverCatalog(baseUrl: string, bearer: string): Promise<ModelsPage> {
	let response: Response;
	try {
		response = await fetch(`${baseUrl}${MODELS_PATH}`, {
			headers: { Authorization: `Bearer ${bearer}` },
			signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw new Error(describeNetworkFailure(error));
	}
	if (!response.ok) {
		throw new Error(singleLine(await describeFailure(response)));
	}
	return (await response.json()) as ModelsPage;
}

export function credentialBearer(credential: Credential | undefined): string | null {
	if (!credential) return null;
	if (credential.type === "oauth") {
		if (typeof credential.endUserId === "string") setSessionEndUserId(credential.endUserId);
		rememberSessionCredentials(credential);
		return credential.access;
	}
	return credential.key ?? process.env.SWITCHBOARD_API_KEY ?? null;
}

export function buildModelConfigs(catalog: ModelsPage, registry: Record<string, RegistryModel>) {
	const modelConfigs = [];
	const skipped: string[] = [];
	for (const record of catalog.models) {
		const tags = Object.keys(record.kind);
		const kindTag = tags.length === 1 && tags[0] in KIND_TO_API ? (tags[0] as SwitchboardKind) : undefined;
		if (kindTag === undefined) {
			skipped.push(record.id);
			continue;
		}
		modelConfigs.push(toModelConfig(record, kindTag, record.kind[kindTag], catalog.prices[record.id], registry[record.id]));
	}
	if (skipped.length > 0) {
		console.error(`pi-switchboard: skipped model(s) with an unsupported model kind: ${skipped.join(", ")}`);
	}
	return modelConfigs;
}
