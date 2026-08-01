import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://switchboard.valni.app";
const PROVIDER_ID = "switchboard";

export function resolveBaseUrl(): string {
	return process.env.SWITCHBOARD_BASE_URL ?? DEFAULT_BASE_URL;
}

export async function resolveBearer(ctx: ExtensionContext): Promise<string | null> {
	let resolution: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
	try {
		resolution = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	} catch {
		return null;
	}
	return resolution?.auth.apiKey ?? null;
}
