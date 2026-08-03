export const MILLISECONDS_PER_SECOND = 1000;
export const PROVIDER_ID = "switchboard";
export const SENTINEL_SEGMENT = "/pi-switchboard/";
export const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";
export const CONNECTION_ID_ENV = "RUNNER_CONNECTION_ID";

export function spawnedConnectionId(): string | null {
	const raw = process.env[CONNECTION_ID_ENV];
	if (raw === undefined) return null;
	const trimmed = raw.trim();
	return trimmed === "" ? null : trimmed;
}
