import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnedConnectionId } from "./constants.ts";

export const PARTICIPANT_FRAMING =
	"You are a participant on a live automation connection, not a solo task. Your text output is not delivered to anyone — the only way to reach the other participant is the send_message tool: set expects_response true if you are waiting on a reply, false if you have nothing pending. The connection stays open and you stay available between messages — after you reply, wait for the other participant's next message. When the work is finished, call close_connection to end it; nothing more is expected of you. The connection_id is filled in for you — you never type it.";

export function composeParticipantSystemPrompt(existing: string | undefined): string {
	if (existing === undefined || existing.trim() === "") return PARTICIPANT_FRAMING;
	return `${existing}\n\n${PARTICIPANT_FRAMING}`;
}

export function registerParticipantFraming(pi: ExtensionAPI): void {
	if (spawnedConnectionId() === null) return;
	pi.on("before_agent_start", event => ({
		systemPrompt: composeParticipantSystemPrompt(event.systemPrompt),
	}));
}
