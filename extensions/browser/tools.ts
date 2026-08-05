import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { remoteBrowserConnector, resolveBaseUrl, resolveBearer } from "./remote.ts";
import type { BrowserConnectionInfo, BrowserConnector } from "./session.ts";

function connector(ctx: ExtensionContext): BrowserConnector {
	return remoteBrowserConnector(resolveBaseUrl(), () => resolveBearer(ctx));
}

function formatDate(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function formatConnection(connection: BrowserConnectionInfo): string {
	const lastUsed = connection.lastUsedAt === null ? "never" : formatDate(connection.lastUsedAt);
	return `${connection.name}: ${connection.loginUrl} (${connection.status}, created ${formatDate(connection.createdAt)}, last used ${lastUsed})`;
}

export function registerConnectCommand(pi: ExtensionAPI): void {
	pi.registerCommand("connect", {
		description: "List the browser connections on your Switchboard account",
		handler: async (_args, ctx) => {
			let connections: BrowserConnectionInfo[];
			try {
				connections = await connector(ctx).list();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (connections.length === 0) {
				ctx.ui.notify("No browser connections on this account.", "info");
				return;
			}
			ctx.ui.notify(connections.map(formatConnection).join("\n"), "info");
		},
	});
}
