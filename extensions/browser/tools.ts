import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { remoteBrowserConnector, resolveBaseUrl, resolveBearer } from "./remote.ts";
import {
	closeBrowserSession,
	openConnection,
	openEphemeralSession,
	runBrowserAction,
	takeScreenshot,
	takeSnapshot,
	type BrowserConnectionInfo,
	type BrowserConnector,
	type DriverResult,
} from "./session.ts";

function connector(ctx: ExtensionContext): BrowserConnector {
	return remoteBrowserConnector(resolveBaseUrl(), () => resolveBearer(ctx));
}

function toToolResult(result: DriverResult): AgentToolResult<unknown> {
	if (result.image === undefined) {
		return { content: [{ type: "text", text: result.text }], details: result.state };
	}
	return {
		content: [
			{ type: "image", data: result.image.data, mimeType: result.image.mimeType },
			{ type: "text", text: result.text },
		],
		details: result.state,
	};
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

export function registerBrowserTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "open_browser_automation",
		label: "open_browser_automation",
		description:
			"Open a browser session to browse the web. No named connection and no site sign-in required; start here and navigate anywhere. Optionally pass a starting url. Follow with browser_snapshot to see the page, then browser_navigate, browser_click, browser_type, and the other browser_* tools. Use browser_connect instead only when you need a saved, signed-in connection for a specific site.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Optional URL to open first. Defaults to a blank page." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toToolResult(await openEphemeralSession(connector(ctx), params.url));
		},
	});
	pi.registerTool({
		name: "browser_connect",
		label: "browser_connect",
		description:
			"Open a named browser connection: a persistent, signed-in browser session for a website without an API. Opens the session for this agent session; follow with browser_navigate and browser_snapshot.",
		parameters: Type.Object({
			name: Type.String({ description: "Name of the browser connection to open." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toToolResult(await openConnection(connector(ctx), params.name));
		},
	});
	pi.registerTool({
		name: "close_browser_automation",
		label: "close_browser_automation",
		description:
			"Close the open browser session and free its worker. Do this when you are done browsing: for a signed-in browser_connect connection, closing is what saves the session so it persists next time, so close deliberately rather than letting the session idle out. Closing is final for this session but recoverable: reopen with open_browser_automation or browser_connect if you need the browser again. Safe to call when nothing is open.",
		parameters: Type.Object({}),
		async execute() {
			return toToolResult(await closeBrowserSession());
		},
	});
	pi.registerTool({
		name: "browser_navigate",
		label: "browser_navigate",
		description: "Navigate the open browser connection to a URL.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to open." }),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(await runBrowserAction(`Navigated to ${params.url}.`, params.url, (session) => session.navigate(params.url)));
		},
	});
	pi.registerTool({
		name: "browser_back",
		label: "browser_back",
		description: "Go back one page in the open browser connection's history.",
		parameters: Type.Object({}),
		async execute() {
			return toToolResult(await runBrowserAction("Went back one page.", null, (session) => session.back()));
		},
	});
	pi.registerTool({
		name: "browser_snapshot",
		label: "browser_snapshot",
		description:
			"Capture the current page as an accessibility tree with element refs like [ref=e12]. This is how you see the page; use the refs with browser_click, browser_type, browser_fill_form, and browser_select. Refs go stale when the page changes.",
		parameters: Type.Object({}),
		async execute() {
			return toToolResult(await takeSnapshot());
		},
	});
	pi.registerTool({
		name: "browser_click",
		label: "browser_click",
		description: "Click the element with the given ref from the latest browser_snapshot.",
		parameters: Type.Object({
			ref: Type.String({ description: "Element ref from browser_snapshot, e.g. e12." }),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(await runBrowserAction(`Clicked ${params.ref}.`, null, (session) => session.click(params.ref)));
		},
	});
	pi.registerTool({
		name: "browser_type",
		label: "browser_type",
		description: "Replace the text in the input or textarea with the given ref.",
		parameters: Type.Object({
			ref: Type.String({ description: "Element ref from browser_snapshot." }),
			text: Type.String({ description: "Text to set as the field's value." }),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(await runBrowserAction(`Typed into ${params.ref}.`, null, (session) => session.type(params.ref, params.text)));
		},
	});
	pi.registerTool({
		name: "browser_fill_form",
		label: "browser_fill_form",
		description: "Fill several form fields in one call.",
		parameters: Type.Object({
			fields: Type.Array(
				Type.Object({
					ref: Type.String({ description: "Element ref from browser_snapshot." }),
					value: Type.String({ description: "Text to set as the field's value." }),
				}),
				{ description: "Fields to fill, in order." },
			),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(await runBrowserAction(`Filled ${params.fields.length} fields.`, null, (session) => session.fillForm(params.fields)));
		},
	});
	pi.registerTool({
		name: "browser_select",
		label: "browser_select",
		description: "Choose an option in the select element with the given ref.",
		parameters: Type.Object({
			ref: Type.String({ description: "Element ref from browser_snapshot." }),
			value: Type.String({ description: "Option value or label to select." }),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(await runBrowserAction(`Selected "${params.value}" in ${params.ref}.`, null, (session) => session.select(params.ref, params.value)));
		},
	});
	pi.registerTool({
		name: "browser_press_key",
		label: "browser_press_key",
		description: "Press a keyboard key on the current page, e.g. Enter, Tab, Escape, ArrowDown.",
		parameters: Type.Object({
			key: Type.String({ description: "Key name, e.g. Enter." }),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(await runBrowserAction(`Pressed ${params.key}.`, null, (session) => session.pressKey(params.key)));
		},
	});
	pi.registerTool({
		name: "browser_wait_for",
		label: "browser_wait_for",
		description: "Wait until text or a CSS selector appears on the page.",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "Visible text to wait for." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to wait for." })),
			timeout_ms: Type.Optional(Type.Number({ description: "How long to wait, in milliseconds. Defaults to 10000." })),
		}),
		async execute(_toolCallId, params) {
			return toToolResult(
				await runBrowserAction("The wait condition was met.", null, (session) =>
					session.waitFor({ text: params.text, selector: params.selector, timeoutMs: params.timeout_ms }),
				),
			);
		},
	});
	pi.registerTool({
		name: "browser_screenshot",
		label: "browser_screenshot",
		description: "Capture a screenshot of the current page. Prefer browser_snapshot for interaction; use this when layout or imagery matters.",
		parameters: Type.Object({}),
		async execute() {
			return toToolResult(await takeScreenshot());
		},
	});
}
