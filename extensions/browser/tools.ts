import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl, resolveBearer } from "./config.ts";
import { localBrowserConnector } from "./local.ts";
import { remoteBrowserConnector } from "./remote.ts";
import { needsReauth, type BrowserConnector, type BrowserPageState, type BrowserSession } from "./session.ts";

export const LOCAL_FLAG = "browser-local";
export const HEADED_FLAG = "browser-headed";
export const LOCAL_STATE_DIR = "switchboard-browser";

const NO_SESSION_MESSAGE = "No browser connection is open. Call browser_connect with a connection name first.";

interface ActiveBrowser {
	name: string;
	session: BrowserSession;
	lastState: BrowserPageState | null;
}

let active: ActiveBrowser | null = null;

export function localStateDir(): string {
	return join(getAgentDir(), LOCAL_STATE_DIR);
}

export function browserConnector(pi: ExtensionAPI, ctx: ExtensionContext): BrowserConnector {
	if (pi.getFlag(LOCAL_FLAG) === true) {
		return localBrowserConnector(localStateDir(), { headed: pi.getFlag(HEADED_FLAG) === true });
	}
	return remoteBrowserConnector(resolveBaseUrl(), () => resolveBearer(ctx));
}

export async function closeActiveBrowser(): Promise<void> {
	const current = active;
	active = null;
	if (current === null) return;
	try {
		await current.session.close();
	} catch {
		void 0;
	}
}

function pageFooter(state: BrowserPageState): string {
	return `url: ${state.url}\ntitle: ${state.title}`;
}

function message(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: null };
}

function reauthMessage(name: string, state: BrowserPageState): string {
	return `The "${name}" connection looks signed out: this page is showing a login form. Re-authenticate the connection, then retry.\n${pageFooter(state)}`;
}

async function runAction(
	label: string,
	requestedUrl: string | null,
	action: (session: BrowserSession) => Promise<BrowserPageState>,
): Promise<AgentToolResult<unknown>> {
	if (active === null) return message(NO_SESSION_MESSAGE);
	const current = active;
	try {
		const state = await action(current.session);
		const reauth = needsReauth(requestedUrl, current.lastState, state);
		current.lastState = state;
		if (reauth) return message(reauthMessage(current.name, state));
		return { content: [{ type: "text", text: `${label}\n${pageFooter(state)}` }], details: state };
	} catch (error) {
		return message(error instanceof Error ? error.message : String(error));
	}
}

export function registerBrowserTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "browser_connect",
		label: "browser_connect",
		description:
			"Open a named browser connection: a persistent, signed-in browser session for a website without an API. Opens the session for this agent session; follow with browser_navigate and browser_snapshot.",
		parameters: Type.Object({
			name: Type.String({ description: "Name of the browser connection to open." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await closeActiveBrowser();
			const connector = browserConnector(pi, ctx);
			try {
				const opened = await connector.open(params.name);
				active = { name: params.name, session: opened.session, lastState: opened.page };
				const location = opened.page === null ? "" : `\n${pageFooter(opened.page)}`;
				return message(`Opened browser connection "${params.name}" (${connector.transport}). Use browser_navigate to load a page, then browser_snapshot to see it.${location}`);
			} catch (error) {
				return message(error instanceof Error ? error.message : String(error));
			}
		},
	});
	pi.registerTool({
		name: "browser_navigate",
		label: "browser_navigate",
		description: "Navigate the open browser connection to a URL.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to open." }),
		}),
		execute: (_toolCallId, params) => runAction(`Navigated to ${params.url}.`, params.url, (session) => session.navigate(params.url)),
	});
	pi.registerTool({
		name: "browser_back",
		label: "browser_back",
		description: "Go back one page in the open browser connection's history.",
		parameters: Type.Object({}),
		execute: () => runAction("Went back one page.", null, (session) => session.back()),
	});
	pi.registerTool({
		name: "browser_snapshot",
		label: "browser_snapshot",
		description:
			"Capture the current page as an accessibility tree with element refs like [ref=e12]. This is how you see the page; use the refs with browser_click, browser_type, browser_fill_form, and browser_select. Refs go stale when the page changes.",
		parameters: Type.Object({}),
		async execute() {
			if (active === null) return message(NO_SESSION_MESSAGE);
			const current = active;
			try {
				const result = await current.session.snapshot();
				const reauth = needsReauth(null, current.lastState, result.page);
				current.lastState = result.page;
				const note = result.truncated ? "\n[snapshot truncated — the page is large; interact with what is visible or navigate closer to what you need]" : "";
				const text = `${result.snapshot}${note}\n${pageFooter(result.page)}`;
				if (reauth) return message(`${reauthMessage(current.name, result.page)}\n${text}`);
				return { content: [{ type: "text", text }], details: result.page };
			} catch (error) {
				return message(error instanceof Error ? error.message : String(error));
			}
		},
	});
	pi.registerTool({
		name: "browser_click",
		label: "browser_click",
		description: "Click the element with the given ref from the latest browser_snapshot.",
		parameters: Type.Object({
			ref: Type.String({ description: "Element ref from browser_snapshot, e.g. e12." }),
		}),
		execute: (_toolCallId, params) => runAction(`Clicked ${params.ref}.`, null, (session) => session.click(params.ref)),
	});
	pi.registerTool({
		name: "browser_type",
		label: "browser_type",
		description: "Replace the text in the input or textarea with the given ref.",
		parameters: Type.Object({
			ref: Type.String({ description: "Element ref from browser_snapshot." }),
			text: Type.String({ description: "Text to set as the field's value." }),
		}),
		execute: (_toolCallId, params) => runAction(`Typed into ${params.ref}.`, null, (session) => session.type(params.ref, params.text)),
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
		execute: (_toolCallId, params) => runAction(`Filled ${params.fields.length} fields.`, null, (session) => session.fillForm(params.fields)),
	});
	pi.registerTool({
		name: "browser_select",
		label: "browser_select",
		description: "Choose an option in the select element with the given ref.",
		parameters: Type.Object({
			ref: Type.String({ description: "Element ref from browser_snapshot." }),
			value: Type.String({ description: "Option value or label to select." }),
		}),
		execute: (_toolCallId, params) => runAction(`Selected "${params.value}" in ${params.ref}.`, null, (session) => session.select(params.ref, params.value)),
	});
	pi.registerTool({
		name: "browser_press_key",
		label: "browser_press_key",
		description: "Press a keyboard key on the current page, e.g. Enter, Tab, Escape, ArrowDown.",
		parameters: Type.Object({
			key: Type.String({ description: "Key name, e.g. Enter." }),
		}),
		execute: (_toolCallId, params) => runAction(`Pressed ${params.key}.`, null, (session) => session.pressKey(params.key)),
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
		execute: (_toolCallId, params) =>
			runAction("The wait condition was met.", null, (session) =>
				session.waitFor({ text: params.text, selector: params.selector, timeoutMs: params.timeout_ms }),
			),
	});
	pi.registerTool({
		name: "browser_screenshot",
		label: "browser_screenshot",
		description: "Capture a screenshot of the current page. Prefer browser_snapshot for interaction; use this when layout or imagery matters.",
		parameters: Type.Object({}),
		async execute() {
			if (active === null) return message(NO_SESSION_MESSAGE);
			const current = active;
			try {
				const result = await current.session.screenshot();
				current.lastState = result.page;
				return {
					content: [
						{ type: "image", data: result.data, mimeType: result.mimeType },
						{ type: "text", text: pageFooter(result.page) },
					],
					details: result.page,
				};
			} catch (error) {
				return message(error instanceof Error ? error.message : String(error));
			}
		},
	});
}
