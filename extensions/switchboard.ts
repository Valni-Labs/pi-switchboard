import { existsSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Credential, Model, ModelsStoreEntry, OAuthCredentials, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "switchboard";
const PROVIDER_NAME = "Switchboard";
const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const DEFAULT_AUTH_BASE_URL = "https://api.valni.app";
const DEVICE_AUTHORIZE_PATH = "/v1/device/authorize";
const DEVICE_TOKEN_PATH = "/v1/device/token";
const DEVICE_CLIENT_ID = "pi-switchboard";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MILLISECONDS_PER_SECOND = 1000;
const SLOW_DOWN_EXTRA_SECONDS = 5;
const INFERENCE_PATH = "/v1/switchboard/inference";
const MODELS_PATH = "/v1/models";
const SENTINEL_SEGMENT = "/pi-switchboard/";
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const UNKNOWN_CONTEXT_WINDOW = 0;
const ERROR_DETAIL_LIMIT = 300;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
const PORTAL_URL = "https://platform.valni.ai";

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

function resolveAuthBaseUrl(): string {
	return process.env.SWITCHBOARD_AUTH_BASE_URL ?? DEFAULT_AUTH_BASE_URL;
}

let sessionEndUserId: string | null = null;

function resolveEndUserId(): string {
	const fromSession = sessionEndUserId ?? process.env.SWITCHBOARD_END_USER_ID;
	if (!fromSession) {
		throw new Error("Not signed in to Switchboard. Run /login in pi, or set SWITCHBOARD_API_KEY and SWITCHBOARD_END_USER_ID for key-based use.");
	}
	return fromSession;
}

interface DeviceTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	end_user_id?: string;
	error?: string;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Sign-in cancelled"));
		}, { once: true });
	});
}

function toCredentials(token: DeviceTokenResponse): OAuthCredentials {
	if (!token.access_token || !token.refresh_token || !token.expires_in || !token.end_user_id) {
		throw new Error(`Switchboard sign-in returned an incomplete token response`);
	}
	sessionEndUserId = token.end_user_id;
	return {
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * MILLISECONDS_PER_SECOND,
		endUserId: token.end_user_id,
	};
}

async function deviceLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const authBase = resolveAuthBaseUrl();
	const authorizeResponse = await fetch(`${authBase}${DEVICE_AUTHORIZE_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: DEVICE_CLIENT_ID, device_label: hostname() }),
	});
	if (!authorizeResponse.ok) {
		throw new Error(await describeFailure(authorizeResponse));
	}
	const authorization = (await authorizeResponse.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete: string;
		expires_in: number;
		interval: number;
	};

	callbacks.onDeviceCode({
		userCode: authorization.user_code,
		verificationUri: authorization.verification_uri_complete,
		intervalSeconds: authorization.interval,
		expiresInSeconds: authorization.expires_in,
	});

	let intervalSeconds = authorization.interval;
	while (true) {
		await sleep(intervalSeconds * MILLISECONDS_PER_SECOND, callbacks.signal);
		const pollResponse = await fetch(`${authBase}${DEVICE_TOKEN_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: DEVICE_CODE_GRANT,
				device_code: authorization.device_code,
				client_id: DEVICE_CLIENT_ID,
			}),
		});
		const token = (await pollResponse.json()) as DeviceTokenResponse;
		if (token.access_token) {
			callbacks.onProgress?.("Signed in to Switchboard");
			return toCredentials(token);
		}
		if (token.error === "authorization_pending") continue;
		if (token.error === "slow_down") {
			intervalSeconds += SLOW_DOWN_EXTRA_SECONDS;
			continue;
		}
		if (token.error === "access_denied") throw new Error("Sign-in was denied in the browser.");
		if (token.error === "expired_token") throw new Error("The sign-in code expired. Run /login again.");
		throw new Error(`Switchboard sign-in failed: ${token.error ?? pollResponse.status}`);
	}
}

async function deviceRefresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${resolveAuthBaseUrl()}${DEVICE_TOKEN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: DEVICE_CLIENT_ID,
		}),
	});
	const token = (await response.json()) as DeviceTokenResponse;
	if (!token.access_token) {
		throw new Error("Switchboard session expired. Run /login again.");
	}
	return toCredentials(token);
}

function switchboardGuidance(envelope: SwitchboardErrorEnvelope & { code: string; error: string }): string {
	switch (envelope.code) {
		case "SWB-1001":
		case "SWB-1002":
			return `Wrong application key. Log in to Switchboard at ${PORTAL_URL} and get a key, then set your application key and restart pi.`;
		case "SWB-1013":
			return "Your Switchboard session expired. Run /login to sign in again.";
		case "SWB-1014":
			return "Your Switchboard session is invalid. Run /login to sign in again.";
		case "SWB-1007":
			return `Out of Switchboard credit. Top up at ${PORTAL_URL} and retry.`;
		case "SWB-1003":
		case "SWB-1004":
		case "SWB-1008":
			return "Over your rate limit. Wait a moment and retry, or raise the limit in the portal.";
		case "SWB-1005":
		case "SWB-1009":
		case "SWB-1011":
			return "A spend limit on this account was reached. Raise it in the portal to continue.";
		case "SWB-1010":
		case "SWB-1012":
			return "This model is not enabled for this account. Switch models, or enable it in the portal.";
		case "SWB-2005":
		case "SWB-2006":
		case "SWB-2007":
		case "SWB-2008":
			return "Your end user id is not registered on this account. Fix the end user id or register it in the portal, then restart pi.";
		case "SWB-3001":
		case "SWB-3005":
			return "This model is no longer available in the catalog. Pick a different model.";
	}
	if (envelope.fault === "provider") {
		return "The model provider is having trouble. Retry shortly, or switch to a different model.";
	}
	if (envelope.fault === "client") {
		return `Switchboard rejected the request: ${envelope.error}.`;
	}
	return "Switchboard hit an internal problem. Not your fault. Retry shortly, and report the request id if it keeps happening.";
}

function userFacingMessage(envelope: SwitchboardErrorEnvelope & { code: string; error: string }, status: number): string {
	const reference = envelope.requestId ? `${envelope.code}, request ${envelope.requestId}` : `${envelope.code}, HTTP ${status}`;
	return `${switchboardGuidance(envelope)} [${reference}]`;
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
	return userFacingMessage({ ...envelope, code: envelope.code, error: envelope.error }, response.status);
}

async function translatedErrorResponse(kindTag: SwitchboardKind, response: Response): Promise<Response> {
	const message = await describeFailure(response);
	const body =
		kindTag === "anthropic"
			? { type: "error", error: { type: "api_error", message } }
			: { error: { message, type: "api_error", param: null, code: null } };
	return new Response(JSON.stringify(body), {
		status: response.status,
		headers: { "Content-Type": "application/json" },
	});
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
		const response = await baseFetch(`${resolveBaseUrl()}${INFERENCE_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				user_id: resolveEndUserId(),
				time: new Date().toISOString(),
				idempotency_key: crypto.randomUUID(),
				kind: { [kindTag]: nativeBody },
			}),
			signal: request.signal,
		});
		if (response.ok) return response;
		return translatedErrorResponse(kindTag, response);
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

async function discoverCatalog(baseUrl: string, bearer: string): Promise<CatalogPage> {
	const response = await fetch(`${baseUrl}${MODELS_PATH}`, {
		headers: { Authorization: `Bearer ${bearer}` },
		signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(await describeFailure(response));
	}
	return (await response.json()) as CatalogPage;
}

function credentialBearer(credential: Credential | undefined): string | null {
	if (!credential) return null;
	if (credential.type === "oauth") {
		if (typeof credential.endUserId === "string") sessionEndUserId = credential.endUserId;
		return credential.access;
	}
	return credential.key ?? process.env.SWITCHBOARD_API_KEY ?? null;
}

function buildModelConfigs(catalog: CatalogPage, registry: Record<string, RegistryModel>) {
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
	return modelConfigs;
}

export default async function (pi: ExtensionAPI) {
	const baseUrl = resolveBaseUrl();
	const registry = await loadRegistryModels();
	const environmentKey = process.env.SWITCHBOARD_API_KEY;
	const startupModels = environmentKey
		? buildModelConfigs(await discoverCatalog(baseUrl, environmentKey), registry)
		: [];
	installEnvelopeFetch();
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "$SWITCHBOARD_API_KEY",
		oauth: {
			name: "Switchboard",
			login: deviceLogin,
			refreshToken: deviceRefresh,
			getApiKey: (credentials: OAuthCredentials) => {
				if (typeof credentials.endUserId === "string") sessionEndUserId = credentials.endUserId;
				return credentials.access;
			},
		},
		models: startupModels,
		refreshModels: async (context: RefreshModelsContext) => {
			const bearer = credentialBearer(context.credential);
			if (!bearer) {
				await context.store.delete();
				return [];
			}
			const stored = await context.store.read();
			if (!context.allowNetwork) {
				return stored ? ([...stored.models] as ReturnType<typeof buildModelConfigs>) : startupModels;
			}
			const catalog = await discoverCatalog(baseUrl, bearer);
			const configs = buildModelConfigs(catalog, registry);
			await context.store.write({
				models: configs as unknown as ModelsStoreEntry["models"],
				checkedAt: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
			});
			return configs;
		},
	});
}
