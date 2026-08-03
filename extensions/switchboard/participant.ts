import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SPAWNED_RUN_ENV = "RUNNER_THREAD_ID";

export const PARTICIPANT_FRAMING =
	"You are a participant in an automation conversation, not a solo task. Your text output is not delivered to anyone — the only way to reach the other participant is to call the send_message tool with a status: expectsResponseBack if you need them to reply, noResponseNeeded if you are done. You do not need to identify the conversation; your reply is routed to it automatically. The conversation so far is your prompt; do what it asks — it may be a question or a request to act — and reply with send_message. Nothing more is expected of you.";

export function composeParticipantSystemPrompt(existing: string | undefined): string {
	if (existing === undefined || existing.trim() === "") return PARTICIPANT_FRAMING;
	return `${existing}\n\n${PARTICIPANT_FRAMING}`;
}

export function registerParticipantFraming(pi: ExtensionAPI): void {
	if (!process.env[SPAWNED_RUN_ENV]) return;
	pi.on("before_agent_start", event => ({
		systemPrompt: composeParticipantSystemPrompt(event.systemPrompt),
	}));
}
