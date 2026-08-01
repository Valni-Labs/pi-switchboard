import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureLocalLogin } from "./local.ts";
import type { BrowserConnectionInfo } from "./session.ts";
import { removeConnection, validConnectionName } from "./store.ts";
import { browserConnector, LOCAL_FLAG, localStateDir } from "./tools.ts";

const LOCAL_USAGE = "Usage: /connect to list connections, /connect add <name> <login-url> to sign in, /connect remove <name> to delete.";
const REMOTE_MANAGED_MESSAGE =
	"Browser connections are managed server-side from your Switchboard account. To use the local dev harness instead, start pi with --browser-local.";

function formatDate(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function formatConnection(connection: BrowserConnectionInfo): string {
	const lastUsed = connection.lastUsedAt === null ? "never" : formatDate(connection.lastUsedAt);
	return `${connection.name} — ${connection.loginUrl} (${connection.status}, created ${formatDate(connection.createdAt)}, last used ${lastUsed})`;
}

function validLoginUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

async function listConnectionsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const connector = browserConnector(pi, ctx);
	let connections: BrowserConnectionInfo[];
	try {
		connections = await connector.list();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	if (connections.length === 0) {
		ctx.ui.notify(connector.transport === "local" ? `No browser connections yet. ${LOCAL_USAGE}` : "No browser connections.", "info");
		return;
	}
	ctx.ui.notify(connections.map(formatConnection).join("\n"), "info");
}

async function addConnectionCommand(ctx: ExtensionCommandContext, name: string, loginUrl: string): Promise<void> {
	if (!validConnectionName(name)) {
		ctx.ui.notify(`Invalid connection name "${name}". Use letters, digits, dashes, and underscores.`, "error");
		return;
	}
	if (!validLoginUrl(loginUrl)) {
		ctx.ui.notify(`"${loginUrl}" is not an http(s) URL.`, "error");
		return;
	}
	ctx.ui.notify("Sign in in the browser window, then return here.", "info");
	try {
		const confirmed = await captureLocalLogin(localStateDir(), name, loginUrl, () =>
			ctx.ui.confirm("Browser sign-in", `Finish signing in to ${loginUrl} in the Chromium window, then confirm to save the "${name}" connection.`),
		);
		if (confirmed) {
			ctx.ui.notify(`Browser connection "${name}" saved. The signed-in browser profile is the credential; no password is stored.`, "info");
		} else {
			ctx.ui.notify("Sign-in was not confirmed; nothing was saved.", "warning");
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function removeConnectionCommand(ctx: ExtensionCommandContext, name: string): Promise<void> {
	const approved = await ctx.ui.confirm("Remove browser connection", `Delete the local browser profile for "${name}"? This signs the agent out of that site.`);
	if (!approved) return;
	try {
		const existed = removeConnection(localStateDir(), name);
		ctx.ui.notify(existed ? `Removed browser connection "${name}".` : `No browser connection named "${name}".`, existed ? "info" : "warning");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerConnectCommand(pi: ExtensionAPI): void {
	pi.registerCommand("connect", {
		description: "List browser connections; with --browser-local, add or remove local dev connections",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
			if (tokens.length === 0) return listConnectionsCommand(pi, ctx);
			const isLocal = pi.getFlag(LOCAL_FLAG) === true;
			if (!isLocal) {
				ctx.ui.notify(REMOTE_MANAGED_MESSAGE, "info");
				return;
			}
			if (tokens[0] === "add" && tokens.length === 3) return addConnectionCommand(ctx, tokens[1], tokens[2]);
			if (tokens[0] === "remove" && tokens.length === 2) return removeConnectionCommand(ctx, tokens[1]);
			ctx.ui.notify(LOCAL_USAGE, "warning");
		},
	});
}
