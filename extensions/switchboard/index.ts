import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelsStoreEntry, OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildModelConfigs, credentialBearer, discoverCatalog, loadRegistryModels } from "./catalog.ts";
import {
	clearSessionCredentials,
	clearSessionId,
	rememberSessionCredentials,
	resolveBaseUrl,
	setSessionEndUserId,
	setSessionId,
} from "./config.ts";
import { MILLISECONDS_PER_SECOND, PROVIDER_ID } from "./constants.ts";
import { switchboardLogin } from "./connections.ts";
import { deviceRefresh } from "./device-auth.ts";
import { clearPendingAsks, consumePendingAsk, installEnvelopeFetch, onSteer } from "./envelope.ts";
import { startSessionStream, stopSessionStream } from "./sessionStream.ts";
import { registerParticipantFraming } from "./participant.ts";
import { registerTaskHistory } from "./taskHistory.ts";
import { discoverTools } from "./toolProxy.ts";
import { registerServerTools } from "./tools.ts";

const PROVIDER_NAME = "Switchboard";
const APPROVAL_DIALOG_TITLE = "Switchboard approval required";

function extensionVersion(): string {
	try {
		const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
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
	let startupModels: ReturnType<typeof buildModelConfigs> = [];
	if (environmentKey) {
		const [catalog, tools] = await Promise.allSettled([
			discoverCatalog(baseUrl, environmentKey),
			discoverTools(baseUrl, environmentKey),
		]);
		if (catalog.status === "rejected") throw catalog.reason;
		startupModels = buildModelConfigs(catalog.value, registry);
		if (tools.status === "fulfilled") {
			registerServerTools(pi, tools.value);
		} else {
			console.error("pi-switchboard: server tool discovery failed for key mode", tools.reason);
		}
	}
	installEnvelopeFetch();
	registerParticipantFraming(pi);
	registerTaskHistory(pi);
	onSteer((steer, deliverAs) => {
		pi.sendUserMessage(steer, { deliverAs });
	});
	pi.on("session_start", (_event, ctx) => {
		setSessionId(ctx.sessionManager.getSessionId());
		startSessionStream(ctx);
	});
	pi.on("tool_call", async (event, ctx) => {
		const ask = consumePendingAsk(event.toolCallId);
		if (ask === undefined) return;
		const policy = `Switchboard ${ask.layer} policy requires approval for ${ask.rule}`;
		if (!ctx.hasUI) {
			return { block: true, reason: `${policy}; denied in a non-interactive session (no human to approve)` };
		}
		const approved = await ctx.ui.confirm(
			APPROVAL_DIALOG_TITLE,
			`The agent wants to run ${event.toolName}.\n\n${policy}. Allow this call?`,
		);
		if (!approved) return { block: true, reason: `Declined: ${policy}` };
		return;
	});
	pi.on("session_shutdown", () => {
		clearPendingAsks();
		stopSessionStream();
		clearSessionId();
		clearSessionCredentials();
	});
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "$SWITCHBOARD_API_KEY",
		oauth: {
			name: "Switchboard",
			login: switchboardLogin,
			refreshToken: deviceRefresh,
			getApiKey: (credentials: OAuthCredentials) => {
				if (typeof credentials.endUserId === "string") setSessionEndUserId(credentials.endUserId);
				rememberSessionCredentials(credentials);
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
			if (context.credential?.type === "oauth") {
				try {
					registerServerTools(pi, await discoverTools(baseUrl, bearer));
				} catch (error) {
					console.error("pi-switchboard: server tool discovery failed", error);
				}
			}
			return configs;
		},
	});
}
