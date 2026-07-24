import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { MILLISECONDS_PER_SECOND } from "./constants.ts";
import { resolveAuthBaseUrl, setSessionEndUserId } from "./config.ts";
import { describeFailure } from "./errors.ts";

const DEVICE_AUTHORIZE_PATH = "/v1/device/authorize";
const DEVICE_TOKEN_PATH = "/v1/device/token";
const DEVICE_CLIENT_ID = "pi-switchboard";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SLOW_DOWN_EXTRA_SECONDS = 5;

interface DeviceTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	end_user_id?: string;
	error?: string;
}

function openInBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const commandArguments = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(command, commandArguments, { detached: true, stdio: "ignore" }).unref();
	} catch {
	}
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Sign-in cancelled"));
		}, { once: true });
	});
}

function toCredentials(token: DeviceTokenResponse): OAuthCredentials {
	if (!token.access_token || !token.refresh_token || !token.expires_in || !token.end_user_id) {
		throw new Error(`Switchboard sign-in returned an incomplete token response`);
	}
	setSessionEndUserId(token.end_user_id);
	return {
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * MILLISECONDS_PER_SECOND,
		endUserId: token.end_user_id,
	};
}

export async function deviceLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const authBase = resolveAuthBaseUrl();
	const authorizeResponse = await fetch(`${authBase}${DEVICE_AUTHORIZE_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: DEVICE_CLIENT_ID, device_label: hostname() }),
	});
	if (!authorizeResponse.ok) {
		throw new Error(await describeFailure(authorizeResponse));
	}
	const authorization = (await authorizeResponse.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete: string;
		expires_in: number;
		interval: number;
	};

	callbacks.onDeviceCode({
		userCode: authorization.user_code,
		verificationUri: authorization.verification_uri_complete,
		intervalSeconds: authorization.interval,
		expiresInSeconds: authorization.expires_in,
	});
	openInBrowser(authorization.verification_uri_complete);

	let intervalSeconds = authorization.interval;
	while (true) {
		await sleep(intervalSeconds * MILLISECONDS_PER_SECOND, callbacks.signal);
		const pollResponse = await fetch(`${authBase}${DEVICE_TOKEN_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: DEVICE_CODE_GRANT,
				device_code: authorization.device_code,
				client_id: DEVICE_CLIENT_ID,
			}),
		});
		const token = (await pollResponse.json()) as DeviceTokenResponse;
		if (token.access_token) {
			callbacks.onProgress?.("Signed in to Switchboard");
			return toCredentials(token);
		}
		if (token.error === "authorization_pending") continue;
		if (token.error === "slow_down") {
			intervalSeconds += SLOW_DOWN_EXTRA_SECONDS;
			continue;
		}
		if (token.error === "access_denied") throw new Error("Sign-in was denied in the browser.");
		if (token.error === "expired_token") throw new Error("The sign-in code expired. Run /login again.");
		throw new Error(`Switchboard sign-in failed: ${token.error ?? pollResponse.status}`);
	}
}

export async function deviceRefresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${resolveAuthBaseUrl()}${DEVICE_TOKEN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: DEVICE_CLIENT_ID,
		}),
	});
	const token = (await response.json()) as DeviceTokenResponse;
	if (!token.access_token) {
		throw new Error("Switchboard session expired. Run /login again.");
	}
	return toCredentials(token);
}
