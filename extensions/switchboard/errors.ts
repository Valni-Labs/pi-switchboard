import { EVENT_STREAM_CONTENT_TYPE } from "./constants.ts";
import { resolveBaseUrl } from "./config.ts";
import type { SwitchboardKind } from "./types.ts";

const PORTAL_URL = "https://valni.app/platform";
const ERROR_DETAIL_LIMIT = 300;

export interface SwitchboardErrorEnvelope {
	code?: string;
	error?: string;
	fault?: string;
	requestId?: string;
}

function switchboardGuidance(envelope: SwitchboardErrorEnvelope & { code: string; error: string }): string {
	switch (envelope.code) {
		case "SWB-1001":
		case "SWB-1002":
			return `Wrong application key. Log in to Switchboard at ${PORTAL_URL} and get a key, then set your application key and restart pi.`;
		case "SWB-1013":
			return "Your Switchboard session expired. Run /login to sign in again.";
		case "SWB-1014":
			return "Your Switchboard session is invalid. Run /login to sign in again.";
		case "SWB-1007":
			return `Out of Switchboard credit. Top up at ${PORTAL_URL} and retry.`;
		case "SWB-1003":
		case "SWB-1004":
		case "SWB-1008":
			return "Over your rate limit. Wait a moment and retry, or raise the limit in the portal.";
		case "SWB-1005":
		case "SWB-1009":
		case "SWB-1011":
			return "A spend limit on this account was reached. Raise it in the portal to continue.";
		case "SWB-1010":
		case "SWB-1012":
			return "This model is not enabled for this account. Switch models, or enable it in the portal.";
		case "SWB-1301":
			return "Company policy denied this tool call. Change the policy in the portal, or ask the agent for a different approach.";
		case "SWB-2005":
		case "SWB-2006":
		case "SWB-2007":
			return "Your end user id is not registered on this account. Fix the end user id or register it in the portal, then restart pi.";
		case "SWB-2008":
			return `This end user is disabled on the account. Re-enable it at ${PORTAL_URL} to continue.`;
		case "SWB-3001":
		case "SWB-3005":
			return "This model is no longer available in the catalog. Pick a different model.";
		case "SWB-5002":
		case "SWB-5003":
		case "SWB-5101":
		case "SWB-5102":
		case "SWB-5103":
		case "SWB-5108":
		case "SWB-5202":
			return "This model is not available on Switchboard right now. Pick a different model, and report the reference if it keeps happening.";
	}
	if (envelope.fault === "provider") {
		return "The model provider is having trouble. Retry shortly, or switch to a different model.";
	}
	if (envelope.fault === "client") {
		return `Switchboard rejected the request: ${envelope.error}.`;
	}
	return "Switchboard hit an internal problem. Not your fault. Retry shortly, and report the request id if it keeps happening.";
}

function userFacingMessage(envelope: SwitchboardErrorEnvelope & { code: string; error: string }, status: number): string {
	const reference = envelope.requestId ? `${envelope.code}, request ${envelope.requestId}` : `${envelope.code}, HTTP ${status}`;
	return `${switchboardGuidance(envelope)} [${reference}]`;
}

function unexpectedResponseMessage(response: Response, text: string): string {
	console.error(`pi-switchboard: unexpected Switchboard response (HTTP ${response.status}): ${text.slice(0, ERROR_DETAIL_LIMIT)}`);
	return `Switchboard returned an unexpected response (HTTP ${response.status}). Retry shortly, and report it if it keeps happening.`;
}

export async function describeFailure(response: Response): Promise<string> {
	const text = await response.text();
	let envelope: SwitchboardErrorEnvelope;
	try {
		envelope = JSON.parse(text) as SwitchboardErrorEnvelope;
	} catch {
		return unexpectedResponseMessage(response, text);
	}
	if (!envelope.code || !envelope.error) {
		return unexpectedResponseMessage(response, text);
	}
	return userFacingMessage({ ...envelope, code: envelope.code, error: envelope.error }, response.status);
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export function singleLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

export function streamErrorResponse(kindTag: SwitchboardKind, message: string): Response {
	const clean = singleLine(message);
	const stream =
		kindTag === "anthropic"
			? `event: error\ndata: ${clean}\n\n`
			: `data: ${JSON.stringify({ error: { message: clean, type: "api_error" } })}\n\n`;
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": EVENT_STREAM_CONTENT_TYPE },
	});
}

export async function translatedErrorResponse(kindTag: SwitchboardKind, response: Response): Promise<Response> {
	return streamErrorResponse(kindTag, await describeFailure(response));
}

export function describeNetworkFailure(error: unknown): string {
	let location = "";
	try {
		const host = new URL(resolveBaseUrl()).host;
		if (host) location = ` at ${host}`;
	} catch {
	}
	if (error instanceof Error && error.name === "TimeoutError") {
		return `Can't reach Switchboard${location}: it took too long to respond. Check your connection and try again.`;
	}
	const cause = (error as { cause?: { code?: string } }).cause;
	const code = cause?.code ?? (error as { code?: string }).code;
	if (code === "ECONNREFUSED") {
		return `Can't reach Switchboard${location}: the connection was refused. It may be down. Try again in a moment.`;
	}
	return `Can't reach Switchboard${location}. Check your internet connection and try again.`;
}
