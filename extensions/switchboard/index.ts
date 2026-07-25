import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelsStoreEntry, OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildModelConfigs, credentialBearer, discoverCatalog, loadRegistryModels } from "./catalog.ts";
import { resolveBaseUrl, setSessionEndUserId, setSessionId } from "./config.ts";
import { MILLISECONDS_PER_SECOND } from "./constants.ts";
import { deviceLogin, deviceRefresh } from "./device-auth.ts";
import { clearPendingAsks, consumePendingAsk, installEnvelopeFetch } from "./envelope.ts";
import { type CompiledSteeringRule, loadSteeringRules, steeringSubject } from "./steering.ts";

const PROVIDER_ID = "switchboard";
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
	const startupModels = environmentKey
		? buildModelConfigs(await discoverCatalog(baseUrl, environmentKey), registry)
		: [];
	installEnvelopeFetch();
	let steeringRules: CompiledSteeringRule[] = [];
	pi.on("session_start", (_event, ctx) => {
		setSessionId(ctx.sessionManager.getSessionId());
		steeringRules = loadSteeringRules(process.cwd(), ctx);
		if (steeringRules.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Switchboard: ${steeringRules.length} steering rule(s) active`, "info");
		}
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || steeringRules.length === 0) return;
		const subject = steeringSubject(event);
		for (const rule of steeringRules) {
			if (rule.tool !== event.toolName) continue;
			if (!rule.pattern.test(subject)) continue;
			if (ctx.isIdle()) {
				pi.sendUserMessage(rule.steer);
			} else {
				pi.sendUserMessage(rule.steer, { deliverAs: rule.deliverAs ?? "followUp" });
			}
		}
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
				if (typeof credentials.endUserId === "string") setSessionEndUserId(credentials.endUserId);
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
