import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const UNKNOWN_CONTEXT_WINDOW = 0;
const ERROR_DETAIL_LIMIT = 300;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const PORTAL_URL = "https://valni.app/platform";
const TOOL_ASK_HEADER = "X-Switchboard-Tool-Ask";
const TOOL_ASK_STREAM_MARKER = ":switchboard.tool_ask ";
const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";
const APPROVAL_DIALOG_TITLE = "Switchboard approval required";

const KIND_TO_API = {
	anthropic: "anthropic-messages",
	openai_generic: "openai-completions",
	openai_pro: "openai-responses",
} as const;

type SwitchboardKind = keyof typeof KIND_TO_API;

interface KindProfile {
	model: string;
	maxTokensCeiling?: number;
	vision?: boolean;
	thinking?: { modes: string[] } | false;
	reasoningEffort?: string[] | false;
}

interface ModelRecord {
	id: string;
	kind: Record<string, KindProfile>;
}

interface ModelRecordPrice {
	input_micro_cents_per_mtok: number;
	output_micro_cents_per_mtok: number;
	cached_input_micro_cents_per_mtok: number | null;
	effective_at: number;
}

interface ModelsPage {
	models: ModelRecord[];
	prices: Record<string, ModelRecordPrice>;
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

function openInBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const commandArguments = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(command, commandArguments, { detached: true, stdio: "ignore" }).unref();
	} catch {
	}
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
	openInBrowser(authorization.verification_uri_complete);

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
		case "SWB-1301":
			return "Company policy denied this tool call. Change the policy in the portal, or ask the agent for a different approach.";
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

function isEnvelopeTarget(url: string): SwitchboardKind | null {
	const sentinelIndex = url.indexOf(SENTINEL_SEGMENT);
	if (sentinelIndex === -1) return null;
	const kindTag = url.slice(sentinelIndex + SENTINEL_SEGMENT.length).split("/")[0];
	return kindTag in KIND_TO_API ? (kindTag as SwitchboardKind) : null;
}

interface AskTag {
	tool: string;
	rule: string;
	layer: string;
}

interface AskEntry {
	id?: string;
	tool: string;
	rule: string;
	layer: string;
}

const pendingAsks = new Map<string, AskTag>();

function recordAskEntries(entries: AskEntry[]): void {
	for (const entry of entries) {
		if (typeof entry.id !== "string") {
			console.error("pi-switchboard: ignoring a tool-ask tag without a tool-call id; cannot correlate it to a tool call");
			continue;
		}
		pendingAsks.set(entry.id, { tool: entry.tool, rule: entry.rule, layer: entry.layer });
	}
}

function recordAskHeader(response: Response): void {
	const header = response.headers.get(TOOL_ASK_HEADER);
	if (header === null) return;
	try {
		const entries = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as AskEntry[];
		if (Array.isArray(entries)) recordAskEntries(entries);
	} catch (error) {
		console.error("pi-switchboard: failed to parse the tool-ask header", error);
	}
}

function recordAskMarkerLine(line: string): void {
	if (!line.startsWith(TOOL_ASK_STREAM_MARKER)) return;
	try {
		const parsed = JSON.parse(line.slice(TOOL_ASK_STREAM_MARKER.length).trim()) as { asks?: AskEntry[] };
		if (Array.isArray(parsed.asks)) recordAskEntries(parsed.asks);
	} catch (error) {
		console.error("pi-switchboard: failed to parse a tool-ask stream marker", error);
	}
}

function scanStreamForAsks(response: Response): Response {
	if (response.body === null) return response;
	const [drain, forward] = response.body.tee();
	void (async () => {
		const reader = drain.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex !== -1) {
					recordAskMarkerLine(buffer.slice(0, newlineIndex));
					buffer = buffer.slice(newlineIndex + 1);
					newlineIndex = buffer.indexOf("\n");
				}
			}
			recordAskMarkerLine(buffer);
		} catch (error) {
			console.error("pi-switchboard: tool-ask stream scan failed", error);
		}
	})();
	return new Response(forward, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function captureAskTags(response: Response): Response {
	recordAskHeader(response);
	if ((response.headers.get("content-type") ?? "").includes(EVENT_STREAM_CONTENT_TYPE)) {
		return scanStreamForAsks(response);
	}
	return response;
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
		if (response.ok) return captureAskTags(response);
		return translatedErrorResponse(kindTag, response);
	};
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

async function discoverCatalog(baseUrl: string, bearer: string): Promise<ModelsPage> {
	const response = await fetch(`${baseUrl}${MODELS_PATH}`, {
		headers: { Authorization: `Bearer ${bearer}` },
		signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(await describeFailure(response));
	}
	return (await response.json()) as ModelsPage;
}

function credentialBearer(credential: Credential | undefined): string | null {
	if (!credential) return null;
	if (credential.type === "oauth") {
		if (typeof credential.endUserId === "string") sessionEndUserId = credential.endUserId;
		return credential.access;
	}
	return credential.key ?? process.env.SWITCHBOARD_API_KEY ?? null;
}

function buildModelConfigs(catalog: ModelsPage, registry: Record<string, RegistryModel>) {
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

function extensionVersion(): string {
	try {
		const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		return (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;
	} catch {
		return "unknown";
	}
}

export default async function (pi: ExtensionAPI) {
	console.error(`pi-switchboard v${extensionVersion()}`);
	const baseUrl = resolveBaseUrl();
	const registry = await loadRegistryModels();
	const environmentKey = process.env.SWITCHBOARD_API_KEY;
	const startupModels = environmentKey
		? buildModelConfigs(await discoverCatalog(baseUrl, environmentKey), registry)
		: [];
	installEnvelopeFetch();
	pi.on("tool_call", async (event, ctx) => {
		const ask = pendingAsks.get(event.toolCallId);
		if (ask === undefined) return;
		pendingAsks.delete(event.toolCallId);
		const policy = `Switchboard ${ask.layer} policy asks before ${ask.rule}`;
		if (!ctx.hasUI) {
			return { block: true, reason: `${policy}; no interactive prompt is available to approve it` };
		}
		const approved = await ctx.ui.confirm(
			APPROVAL_DIALOG_TITLE,
			`The agent wants to run ${event.toolName}.\n\n${policy}. Allow this call?`,
		);
		if (!approved) return { block: true, reason: `Declined: ${policy}` };
		return;
	});
	pi.on("session_shutdown", () => {
		pendingAsks.clear();
	});
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
