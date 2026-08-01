import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { MILLISECONDS_PER_SECOND } from "./constants.ts";
import { recallSessionCredentials, resolveBaseUrl } from "./config.ts";
import { deviceLogin, openInBrowser, sleep } from "./device-auth.ts";
import { describeFailure } from "./errors.ts";

const MENU_SIGN_IN = "switchboard-sign-in";
const MENU_SUBSCRIPTIONS = "subscriptions";
const MENU_ADD_OAUTH = "add-oauth";
const NEW_APP = "register-new-app";
const SUBSCRIPTION_PREFIX = "sub:";
const CALLBACK_PATH = "/callback";
const LOOPBACK_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_CONNECT_WINDOW_SECONDS = 600;

interface SubscriptionProvider {
	id: string;
	label: string;
}

interface OauthApp {
	id: string;
	name: string;
	providerSlug: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	clientId: string;
	scope: string;
}

async function apiFetch(access: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
	return fetch(`${resolveBaseUrl()}${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${access}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

async function listSubscriptionProviders(access: string): Promise<SubscriptionProvider[]> {
	const response = await apiFetch(access, "/v1/connections/subscription-providers");
	if (!response.ok) throw new Error(await describeFailure(response));
	const body = (await response.json()) as { providers?: SubscriptionProvider[] };
	return Array.isArray(body.providers) ? body.providers : [];
}

async function listOauthApps(access: string): Promise<OauthApp[]> {
	const response = await apiFetch(access, "/v1/connections/oauth-apps");
	if (!response.ok) throw new Error(await describeFailure(response));
	const body = (await response.json()) as { oauthApps?: OauthApp[] };
	return Array.isArray(body.oauthApps) ? body.oauthApps : [];
}

function requirePrompt(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required.`);
	return trimmed;
}

function defaultSlug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

async function registerOauthApp(
	access: string,
	callbacks: OAuthLoginCallbacks,
): Promise<{ app: OauthApp; clientSecret: string }> {
	const name = requirePrompt(await callbacks.onPrompt({ message: "Connection name (e.g. Acme Inference)" }), "name");
	const slugInput = await callbacks.onPrompt({
		message: `Provider slug (lowercase, unique for your company; empty = "${defaultSlug(name)}")`,
		allowEmpty: true,
	});
	const authorizationEndpoint = requirePrompt(
		await callbacks.onPrompt({ message: "Authorization endpoint (https URL)" }),
		"authorization endpoint",
	);
	const tokenEndpoint = requirePrompt(
		await callbacks.onPrompt({ message: "Token endpoint (https URL)" }),
		"token endpoint",
	);
	const clientId = requirePrompt(await callbacks.onPrompt({ message: "Client id" }), "client id");
	const clientSecret = await callbacks.onPrompt({
		message: "Client secret (stored encrypted by Switchboard; empty for a public client)",
		allowEmpty: true,
	});
	const scope = await callbacks.onPrompt({ message: "Scope (empty for none)", allowEmpty: true });

	const response = await apiFetch(access, "/v1/connections/oauth-apps", {
		method: "POST",
		body: {
			name,
			provider_slug: slugInput.trim() || defaultSlug(name),
			authorization_endpoint: authorizationEndpoint,
			token_endpoint: tokenEndpoint,
			client_id: clientId,
			client_secret: clientSecret,
			scope: scope.trim(),
		},
	});
	if (!response.ok) throw new Error(await describeFailure(response));
	const app = (await response.json()) as OauthApp;
	return { app, clientSecret };
}

async function chooseOauthApp(
	access: string,
	callbacks: OAuthLoginCallbacks,
): Promise<{ app: OauthApp; clientSecret: string }> {
	const apps = await listOauthApps(access);
	if (apps.length === 0) return registerOauthApp(access, callbacks);

	const choice = await callbacks.onSelect({
		message: "Which OAuth connection?",
		options: [
			...apps.map((app) => ({ id: app.id, label: `${app.name} (${app.providerSlug})` })),
			{ id: NEW_APP, label: "+ Register a new OAuth app" },
		],
	});
	if (choice === undefined) throw new Error("Connection cancelled");
	if (choice === NEW_APP) return registerOauthApp(access, callbacks);

	const app = apps.find((candidate) => candidate.id === choice);
	if (!app) throw new Error("Connection cancelled");
	const clientSecret = await callbacks.onPrompt({
		message: "Client secret for the token exchange (empty for a public client; Switchboard never returns stored secrets)",
		allowEmpty: true,
	});
	return { app, clientSecret };
}

interface LoopbackResult {
	code: string;
	redirectUri: string;
	verifier: string;
}

function loopbackAuthorize(app: OauthApp, callbacks: OAuthLoginCallbacks): Promise<LoopbackResult> {
	return new Promise<LoopbackResult>((resolve, reject) => {
		const state = randomBytes(16).toString("base64url");
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const server = createServer();
		let settled = false;

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.close();
			reject(error);
		};
		const succeed = (code: string, redirectUri: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.close();
			resolve({ code, redirectUri, verifier });
		};

		const timer = setTimeout(() => {
			fail(new Error("Timed out waiting for the browser authorization. Run /login to try again."));
		}, LOOPBACK_TIMEOUT_MS);
		timer.unref?.();

		callbacks.signal?.addEventListener("abort", () => {
			fail(new Error("Connection cancelled"));
		}, { once: true });

		server.on("error", (error: Error & { code?: string }) => {
			const detail = error.code === "EADDRINUSE" ? "the local callback port is in use" : String(error);
			fail(new Error(`Could not open a local callback listener: ${detail}`));
		});

		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

			server.on("request", (request, response) => {
				const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
				if (url.pathname !== CALLBACK_PATH) {
					response.writeHead(404).end();
					return;
				}
				const deniedError = url.searchParams.get("error");
				if (deniedError !== null) {
					response.writeHead(200, { "Content-Type": "text/plain" }).end("Authorization was declined. You can close this tab.");
					fail(new Error(deniedError === "access_denied" ? "Authorization was declined in the browser." : `Authorization failed: ${deniedError}`));
					return;
				}
				if (url.searchParams.get("state") !== state) {
					response.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch. This response was rejected.");
					fail(new Error("Authorization response state did not match; rejected."));
					return;
				}
				const code = url.searchParams.get("code");
				if (code === null || code === "") {
					response.writeHead(400, { "Content-Type": "text/plain" }).end("Missing authorization code.");
					fail(new Error("The authorization response carried no code."));
					return;
				}
				response.writeHead(200, { "Content-Type": "text/plain" }).end("Connected. You can close this tab and return to pi.");
				succeed(code, redirectUri);
			});

			const authorizeUrl = new URL(app.authorizationEndpoint);
			authorizeUrl.searchParams.set("response_type", "code");
			authorizeUrl.searchParams.set("client_id", app.clientId);
			authorizeUrl.searchParams.set("redirect_uri", redirectUri);
			if (app.scope) authorizeUrl.searchParams.set("scope", app.scope);
			authorizeUrl.searchParams.set("state", state);
			authorizeUrl.searchParams.set("code_challenge", challenge);
			authorizeUrl.searchParams.set("code_challenge_method", "S256");

			callbacks.onAuth({ url: authorizeUrl.toString(), instructions: `Authorize ${app.name} in your browser` });
			openInBrowser(authorizeUrl.toString());
		});
	});
}

async function connectCustomOauth(access: string, callbacks: OAuthLoginCallbacks): Promise<void> {
	const { app, clientSecret } = await chooseOauthApp(access, callbacks);
	const authorization = await loopbackAuthorize(app, callbacks);

	const exchangeResponse = await fetch(app.tokenEndpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: authorization.code,
			redirect_uri: authorization.redirectUri,
			client_id: app.clientId,
			code_verifier: authorization.verifier,
			...(clientSecret ? { client_secret: clientSecret } : {}),
		}),
	});
	if (!exchangeResponse.ok) {
		throw new Error(`${app.name} rejected the code exchange (HTTP ${exchangeResponse.status}). Check the token endpoint, client id, and client secret.`);
	}
	const tokens = (await exchangeResponse.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	};
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
		throw new Error(`${app.name} returned no access token from the code exchange.`);
	}

	const storeResponse = await apiFetch(access, "/v1/connections/credentials", {
		method: "POST",
		body: {
			oauth_app_id: app.id,
			access_token: tokens.access_token,
			...(typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
				? { refresh_token: tokens.refresh_token }
				: {}),
			...(typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? { expires_in: tokens.expires_in } : {}),
		},
	});
	if (!storeResponse.ok) throw new Error(await describeFailure(storeResponse));
	callbacks.onProgress?.(`Connected ${app.name}`);
}

async function connectSubscription(access: string, providerId: string, label: string, callbacks: OAuthLoginCallbacks): Promise<void> {
	const startResponse = await apiFetch(access, `/v1/connections/subscription/${encodeURIComponent(providerId)}/start`, { method: "POST" });
	if (!startResponse.ok) throw new Error(await describeFailure(startResponse));
	const start = (await startResponse.json()) as {
		connectId: string;
		userCode: string;
		verificationUri: string;
		expiresIn: number;
		interval: number;
	};

	callbacks.onDeviceCode({
		userCode: start.userCode,
		verificationUri: start.verificationUri,
		intervalSeconds: start.interval,
		expiresInSeconds: start.expiresIn,
	});
	openInBrowser(start.verificationUri);

	const intervalSeconds = start.interval > 0 ? start.interval : DEFAULT_POLL_INTERVAL_SECONDS;
	const windowSeconds = start.expiresIn > 0 ? start.expiresIn : DEFAULT_CONNECT_WINDOW_SECONDS;
	const deadline = Date.now() + windowSeconds * MILLISECONDS_PER_SECOND;
	while (Date.now() < deadline) {
		await sleep(intervalSeconds * MILLISECONDS_PER_SECOND, callbacks.signal);
		const pollResponse = await apiFetch(
			access,
			`/v1/connections/subscription/${encodeURIComponent(providerId)}/connect/${encodeURIComponent(start.connectId)}`,
			{ method: "POST" },
		);
		if (!pollResponse.ok) throw new Error(await describeFailure(pollResponse));
		const poll = (await pollResponse.json()) as { status?: string };
		if (poll.status === "active") {
			callbacks.onProgress?.(`Connected ${label}`);
			return;
		}
		if (poll.status === "denied") throw new Error("Authorization was declined in the browser.");
		if (poll.status === "expired") throw new Error("The connect code expired. Run /login to try again.");
		if (poll.status === "failed") throw new Error("The provider rejected the connection. Run /login to try again.");
	}
	throw new Error("The connect code expired. Run /login to try again.");
}

async function ensureSession(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const remembered = recallSessionCredentials();
	if (remembered !== null) return remembered;
	callbacks.onProgress?.("Sign in to Switchboard first");
	return deviceLogin(callbacks);
}

export async function switchboardLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const remembered = recallSessionCredentials();
	let subscriptionProviders: SubscriptionProvider[] = [];
	if (remembered !== null) {
		try {
			subscriptionProviders = await listSubscriptionProviders(remembered.access);
		} catch {
			subscriptionProviders = [];
		}
	}

	const options = [
		{ id: MENU_SIGN_IN, label: remembered === null ? "Sign in to Switchboard" : "Sign in again (switch account)" },
		...(subscriptionProviders.length > 0
			? subscriptionProviders.map((provider) => ({ id: `${SUBSCRIPTION_PREFIX}${provider.id}`, label: `Connect ${provider.label}` }))
			: [{ id: MENU_SUBSCRIPTIONS, label: "Connect a provider subscription (SuperGrok, ...)" }]),
		{ id: MENU_ADD_OAUTH, label: "+ Add OAuth connection" },
	];

	const choice = await callbacks.onSelect({ message: "Switchboard", options });
	if (choice === undefined) throw new Error("Sign-in cancelled");
	if (choice === MENU_SIGN_IN) return deviceLogin(callbacks);

	const credentials = await ensureSession(callbacks);

	if (choice === MENU_ADD_OAUTH) {
		await connectCustomOauth(credentials.access, callbacks);
		return credentials;
	}

	let providerId: string;
	let providerLabel: string;
	if (choice.startsWith(SUBSCRIPTION_PREFIX)) {
		providerId = choice.slice(SUBSCRIPTION_PREFIX.length);
		providerLabel = subscriptionProviders.find((provider) => provider.id === providerId)?.label ?? providerId;
	} else {
		const providers = await listSubscriptionProviders(credentials.access);
		if (providers.length === 0) throw new Error("No subscription providers are available to connect.");
		const picked = providers.length === 1
			? providers[0].id
			: await callbacks.onSelect({
				message: "Which subscription?",
				options: providers.map((provider) => ({ id: provider.id, label: provider.label })),
			});
		if (picked === undefined) throw new Error("Connection cancelled");
		providerId = picked;
		providerLabel = providers.find((provider) => provider.id === providerId)?.label ?? providerId;
	}

	await connectSubscription(credentials.access, providerId, providerLabel, callbacks);
	return credentials;
}
