import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl, resolveEndUserId } from "./config.ts";
import { describeFailure, describeNetworkFailure } from "./errors.ts";
import { resolveStreamToken } from "./sessionStream.ts";

export const TRANSCRIPTIONS_PATH = "/v1/switchboard/transcriptions";
export const DICTATION_MODEL = "grok-voice-transcribe-2.0";
export const VOICE_SHORTCUT = "ctrl+q";
export const VOICE_COMMAND = "voice";
export const SAMPLE_RATE_HERTZ = 16_000;
export const MAXIMUM_RECORDING_SECONDS = 600;
export const SOX_MISSING_MESSAGE = "Voice needs sox to use your microphone. Run `brew install sox`, then try again.";

const STATUS_KEY = "switchboard-voice";
const RECORDER_COMMAND = "rec";
const RECORDING_FILE_NAME = "dictation.wav";
const WAV_HEADER_BYTES = 44;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const VOICE_MODES = new Set(["tui"]);

export function recorderArguments(outputPath: string): string[] {
	return [
		"-q",
		"-c",
		"1",
		"-r",
		String(SAMPLE_RATE_HERTZ),
		"-b",
		"16",
		"-e",
		"signed-integer",
		outputPath,
		"trim",
		"0",
		String(MAXIMUM_RECORDING_SECONDS),
	];
}

export function transcriptionsUrl(baseUrl: string): string {
	return new URL(TRANSCRIPTIONS_PATH, baseUrl).toString();
}

export function transcriptionForm(audio: Uint8Array<ArrayBuffer>, userId: string, idempotencyKey: string): FormData {
	const form = new FormData();
	form.append("model", DICTATION_MODEL);
	form.append("user_id", userId);
	form.append("idempotency_key", idempotencyKey);
	form.append("file", new Blob([audio], { type: "audio/wav" }), RECORDING_FILE_NAME);
	return form;
}

export function parseTranscription(body: unknown): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const text = (body as Record<string, unknown>).text;
	return typeof text === "string" ? text.trim() : null;
}

export function hasSpokenAudio(audio: Uint8Array): boolean {
	return audio.byteLength > WAV_HEADER_BYTES;
}

type VoiceState =
	| { kind: "idle" }
	| { kind: "recording"; recorder: ChildProcess; directory: string; outputPath: string; exited: Promise<number | null> }
	| { kind: "transcribing" };

let state: VoiceState = { kind: "idle" };

function setStatus(context: ExtensionContext, text: string | undefined): void {
	context.ui.setStatus(STATUS_KEY, text);
}

async function resolveDictationToken(context: ExtensionContext): Promise<string | null> {
	return (await resolveStreamToken(context)) ?? process.env.SWITCHBOARD_API_KEY ?? null;
}

async function startRecording(context: ExtensionContext): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "valni-voice-"));
	const outputPath = join(directory, RECORDING_FILE_NAME);
	const recorder = spawn(RECORDER_COMMAND, recorderArguments(outputPath), { stdio: "ignore" });
	const exited = new Promise<number | null>((resolve) => {
		recorder.once("exit", (code) => resolve(code));
		recorder.once("error", () => resolve(null));
	});
	recorder.once("error", (error: NodeJS.ErrnoException) => {
		if (state.kind !== "recording" || state.recorder !== recorder) return;
		state = { kind: "idle" };
		setStatus(context, undefined);
		void rm(directory, { recursive: true, force: true });
		const message = error.code === "ENOENT" ? SOX_MISSING_MESSAGE : `Voice could not start the microphone: ${error.message}`;
		context.ui.notify(message, "error");
	});
	recorder.once("exit", () => {
		if (state.kind === "recording" && state.recorder === recorder) void stopRecording(context);
	});
	state = { kind: "recording", recorder, directory, outputPath, exited };
	setStatus(context, `● recording, ${VOICE_SHORTCUT} to stop`);
}

async function transcribe(context: ExtensionContext, audio: Uint8Array<ArrayBuffer>): Promise<string> {
	const token = await resolveDictationToken(context);
	if (token === null) throw new Error("Voice needs a Switchboard login. Run /login and choose Switchboard.");
	let response: Response;
	try {
		response = await fetch(transcriptionsUrl(resolveBaseUrl()), {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			body: transcriptionForm(audio, resolveEndUserId(), randomUUID()),
			signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(describeNetworkFailure(error));
	}
	if (!response.ok) throw new Error(await describeFailure(response));
	const text = parseTranscription(await response.json());
	if (text === null) throw new Error("Switchboard returned a transcription without text.");
	return text;
}

async function stopRecording(context: ExtensionContext): Promise<void> {
	if (state.kind !== "recording") return;
	const { recorder, directory, outputPath, exited } = state;
	state = { kind: "transcribing" };
	setStatus(context, "transcribing…");
	try {
		recorder.kill("SIGINT");
		await exited;
		const audio = new Uint8Array(await readFile(outputPath));
		if (!hasSpokenAudio(audio)) {
			context.ui.notify("Voice heard nothing. Check your microphone and try again.", "warning");
			return;
		}
		const text = await transcribe(context, audio);
		if (text.length === 0) {
			context.ui.notify("Voice heard no words.", "warning");
			return;
		}
		context.ui.pasteToEditor(text);
	} catch (error) {
		context.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		state = { kind: "idle" };
		setStatus(context, undefined);
		await rm(directory, { recursive: true, force: true });
	}
}

async function toggleDictation(context: ExtensionContext): Promise<void> {
	if (!VOICE_MODES.has(context.mode)) return;
	if (state.kind === "idle") return startRecording(context);
	if (state.kind === "recording") return stopRecording(context);
}

function abandonRecording(): void {
	if (state.kind !== "recording") return;
	const { recorder, directory } = state;
	state = { kind: "idle" };
	recorder.kill("SIGINT");
	void rm(directory, { recursive: true, force: true });
}

export function registerVoice(pi: ExtensionAPI): void {
	pi.registerShortcut(VOICE_SHORTCUT, {
		description: "Start or stop voice dictation into the prompt",
		handler: (context) => toggleDictation(context),
	});
	pi.registerCommand(VOICE_COMMAND, {
		description: `Start or stop voice dictation into the prompt (same as ${VOICE_SHORTCUT})`,
		handler: async (_args, context) => toggleDictation(context),
	});
	pi.on("session_shutdown", () => abandonRecording());
}
