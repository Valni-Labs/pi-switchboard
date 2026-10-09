import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recallSessionCredentials } from "./config.ts";
import { resolveInvokeToken } from "./toolProxy.ts";

export const PORTAL_URL = "https://valni.ai/platform/switchboard";
const WIDGET_KEY = "switchboard-startup";

export function startupLines(email: string | null): string[] {
	const lines: string[] = [];
	if (email) lines.push(`Signed in to Switchboard as ${email}.`);
	lines.push(`Configure skills, tools, permissions, and more in the Switchboard portal: ${PORTAL_URL}`);
	return lines;
}

function signedInEmail(): string | null {
	const email = recallSessionCredentials()?.email;
	return typeof email === "string" && email.length > 0 ? email : null;
}

export function registerStartupNotice(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const token = await resolveInvokeToken(ctx);
		ctx.ui.setWidget(WIDGET_KEY, startupLines(token ? signedInEmail() : null));
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
