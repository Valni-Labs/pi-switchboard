import { rmSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "playwright";
import {
	boundSnapshot,
	type BrowserConnectionInfo,
	type BrowserConnector,
	type BrowserFormField,
	type BrowserPageState,
	type BrowserSession,
	type BrowserWaitTarget,
} from "./session.ts";
import { ensureStoreDir, listConnections, profileDir, saveConnection, touchConnection, type StoredConnection } from "./store.ts";

const INSTALL_HINT = "Playwright Chromium is not installed. Run: npx playwright install chromium";
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const SCREENSHOT_QUALITY = 60;
const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';

export interface LocalBrowserOptions {
	headed?: boolean;
}

async function loadChromium(): Promise<typeof import("playwright").chromium> {
	let playwright: typeof import("playwright");
	try {
		playwright = await import("playwright");
	} catch {
		throw new Error(`The playwright package is missing from this pi-switchboard install. Reinstall the package, then run: npx playwright install chromium`);
	}
	return playwright.chromium;
}

async function launchProfile(dir: string, headed: boolean): Promise<BrowserContext> {
	const chromium = await loadChromium();
	let context: BrowserContext;
	try {
		context = await chromium.launchPersistentContext(dir, { headless: !headed });
	} catch (error) {
		if (error instanceof Error && error.message.includes("Executable doesn't exist")) throw new Error(INSTALL_HINT);
		throw error;
	}
	context.setDefaultTimeout(ACTION_TIMEOUT_MS);
	context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
	return context;
}

async function activePage(context: BrowserContext): Promise<Page> {
	const pages = context.pages();
	return pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
}

async function pageState(page: Page): Promise<BrowserPageState> {
	return {
		url: page.url(),
		title: await page.title(),
		hasPasswordField: (await page.locator(PASSWORD_INPUT_SELECTOR).count()) > 0,
	};
}

function refFailure(ref: string, error: unknown): Error {
	const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
	return new Error(`${message} — ref "${ref}" may be stale; take a fresh browser_snapshot and retry with a current ref.`);
}

async function withRef(page: Page, ref: string, action: (locator: Locator) => Promise<void>): Promise<void> {
	try {
		await action(page.locator(`aria-ref=${ref}`));
	} catch (error) {
		throw refFailure(ref, error);
	}
}

function localSession(context: BrowserContext): BrowserSession {
	const settled = async (): Promise<BrowserPageState> => {
		const page = await activePage(context);
		await page.waitForLoadState("domcontentloaded");
		return pageState(page);
	};
	return {
		navigate: async (url: string) => {
			const page = await activePage(context);
			await page.goto(url, { waitUntil: "domcontentloaded" });
			return pageState(page);
		},
		back: async () => {
			const page = await activePage(context);
			await page.goBack({ waitUntil: "domcontentloaded" });
			return pageState(page);
		},
		snapshot: async () => {
			const page = await activePage(context);
			const bounded = boundSnapshot(await page.ariaSnapshot({ mode: "ai" }));
			return { page: await pageState(page), ...bounded };
		},
		screenshot: async () => {
			const page = await activePage(context);
			const buffer = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY });
			return { page: await pageState(page), data: buffer.toString("base64"), mimeType: "image/jpeg" };
		},
		click: async (ref: string) => {
			await withRef(await activePage(context), ref, (locator) => locator.click());
			return settled();
		},
		type: async (ref: string, text: string) => {
			await withRef(await activePage(context), ref, (locator) => locator.fill(text));
			return settled();
		},
		fillForm: async (fields: BrowserFormField[]) => {
			const page = await activePage(context);
			for (const field of fields) {
				await withRef(page, field.ref, (locator) => locator.fill(field.value));
			}
			return settled();
		},
		select: async (ref: string, value: string) => {
			await withRef(await activePage(context), ref, async (locator) => {
				await locator.selectOption(value);
			});
			return settled();
		},
		pressKey: async (key: string) => {
			const page = await activePage(context);
			await page.keyboard.press(key);
			return settled();
		},
		waitFor: async (target: BrowserWaitTarget) => {
			const page = await activePage(context);
			const timeout = target.timeoutMs ?? ACTION_TIMEOUT_MS;
			if (target.text !== undefined) await page.getByText(target.text).first().waitFor({ timeout });
			else if (target.selector !== undefined) await page.locator(target.selector).first().waitFor({ timeout });
			else throw new Error("browser_wait_for needs text or a selector.");
			return pageState(page);
		},
		close: async () => {
			await context.close();
		},
	};
}

function toInfo(connection: StoredConnection): BrowserConnectionInfo {
	return {
		name: connection.name,
		loginUrl: connection.loginUrl,
		status: "ready",
		createdAt: connection.createdAt,
		lastUsedAt: connection.lastUsedAt,
	};
}

export function localBrowserConnector(baseDir: string, options: LocalBrowserOptions = {}): BrowserConnector {
	return {
		transport: "local",
		list: async () => listConnections(baseDir).map(toInfo),
		open: async (name: string) => {
			const known = listConnections(baseDir);
			const connection = known.find((entry) => entry.name === name);
			if (!connection) {
				const available = known.map((entry) => entry.name).join(", ") || "none";
				throw new Error(`Unknown browser connection "${name}". Available connections: ${available}.`);
			}
			touchConnection(baseDir, name, Date.now());
			const context = await launchProfile(profileDir(baseDir, name), options.headed === true);
			return { session: localSession(context), page: null };
		},
	};
}

export async function captureLocalLogin(
	baseDir: string,
	name: string,
	loginUrl: string,
	waitForUser: () => Promise<boolean>,
): Promise<boolean> {
	ensureStoreDir(baseDir);
	const existedBefore = listConnections(baseDir).some((entry) => entry.name === name);
	const profile = profileDir(baseDir, name);
	const context = await launchProfile(profile, true);
	let confirmed = false;
	try {
		const page = await activePage(context);
		await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
		confirmed = await waitForUser();
	} finally {
		try {
			await context.close();
		} catch {
			void 0;
		}
	}
	if (confirmed) {
		saveConnection(baseDir, name, loginUrl, Date.now());
	} else if (!existedBefore) {
		rmSync(profile, { recursive: true, force: true });
	}
	return confirmed;
}
