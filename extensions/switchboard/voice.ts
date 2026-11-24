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

export interface VoiceDependencies {
	makeDirectory: () => Promise<string>;
	removeDirectory: (directory: string) => Promise<void>;
	spawnRecorder: (outputPath: string) => ChildProcess;
	readRecording: (outputPath: string) => Promise<Uint8Array<ArrayBuffer>>;
	transcribe: (context: ExtensionContext, audio: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string>;
}

type VoiceState =
	| { kind: "idle" }
	| { kind: "starting"; stopRequested: boolean }
	| { kind: "recording"; recorder: ChildProcess; directory: string; outputPath: string; exited: Promise<number | null> }
	| { kind: "transcribing"; abort: AbortController };

export interface VoiceController {
	toggle: (context: ExtensionContext) => Promise<void>;
	shutdown: () => void;
}

function setStatus(context: ExtensionContext, text: string | undefined): void {
	context.ui.setStatus(STATUS_KEY, text);
}

async function resolveDictationToken(context: ExtensionContext): Promise<string | null> {
	return (await resolveStreamToken(context)) ?? process.env.SWITCHBOARD_API_KEY ?? null;
}

async function transcribeWithSwitchboard(
	context: ExtensionContext,
	audio: Uint8Array<ArrayBuffer>,
	signal: AbortSignal,
): Promise<string> {
	const token = await resolveDictationToken(context);
	if (token === null) throw new Error("Voice needs a Switchboard login. Run /login and choose Switchboard.");
	let response: Response;
	try {
		response = await fetch(transcriptionsUrl(resolveBaseUrl()), {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			body: transcriptionForm(audio, resolveEndUserId(), randomUUID()),
			signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)]),
		});
	} catch (error) {
		throw new Error(describeNetworkFailure(error));
	}
	if (!response.ok) throw new Error(await describeFailure(response));
	const text = parseTranscription(await response.json());
	if (text === null) throw new Error("Switchboard returned a transcription without text.");
	return text;
}

export const defaultVoiceDependencies: VoiceDependencies = {
	makeDirectory: () => mkdtemp(join(tmpdir(), "valni-voice-")),
	removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
	spawnRecorder: (outputPath) => spawn(RECORDER_COMMAND, recorderArguments(outputPath), { stdio: "ignore" }),
	readRecording: async (outputPath) => new Uint8Array(await readFile(outputPath)),
	transcribe: transcribeWithSwitchboard,
};

export function createVoiceController(dependencies: VoiceDependencies = defaultVoiceDependencies): VoiceController {
	let state: VoiceState = { kind: "idle" };
	let generation = 0;

	async function startRecording(context: ExtensionContext): Promise<void> {
		const owner = generation;
		const starting: VoiceState = { kind: "starting", stopRequested: false };
		state = starting;
		let directory: string;
		try {
			directory = await dependencies.makeDirectory();
		} catch (error) {
			if (state !== starting) return;
			state = { kind: "idle" };
			context.ui.notify(`Voice could not start the microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (generation !== owner || state !== starting) {
			void dependencies.removeDirectory(directory);
			return;
		}
		const outputPath = join(directory, RECORDING_FILE_NAME);
		const recorder = dependencies.spawnRecorder(outputPath);
		const exited = new Promise<number | null>((resolve) => {
			recorder.once("exit", (code) => resolve(code));
			recorder.once("error", () => resolve(null));
		});
		recorder.once("error", (error: NodeJS.ErrnoException) => {
			if (state.kind !== "recording" || state.recorder !== recorder) return;
			state = { kind: "idle" };
			setStatus(context, undefined);
			void dependencies.removeDirectory(directory);
			const message = error.code === "ENOENT" ? SOX_MISSING_MESSAGE : `Voice could not start the microphone: ${error.message}`;
			context.ui.notify(message, "error");
		});
		recorder.once("exit", () => {
			if (state.kind === "recording" && state.recorder === recorder) void stopRecording(context);
		});
		state = { kind: "recording", recorder, directory, outputPath, exited };
		setStatus(context, `● recording, ${VOICE_SHORTCUT} to stop`);
		if (starting.stopRequested) await stopRecording(context);
	}

	async function stopRecording(context: ExtensionContext): Promise<void> {
		if (state.kind !== "recording") return;
		const owner = generation;
		const { recorder, directory, outputPath, exited } = state;
		const transcribing: VoiceState = { kind: "transcribing", abort: new AbortController() };
		state = transcribing;
		setStatus(context, "transcribing…");
		try {
			recorder.kill("SIGINT");
			await exited;
			const audio = await dependencies.readRecording(outputPath);
			if (generation !== owner) return;
			if (!hasSpokenAudio(audio)) {
				context.ui.notify("Voice heard nothing. Check your microphone and try again.", "warning");
				return;
			}
			const text = await dependencies.transcribe(context, audio, transcribing.abort.signal);
			if (generation !== owner) return;
			if (text.length === 0) {
				context.ui.notify("Voice heard no words.", "warning");
				return;
			}
			context.ui.pasteToEditor(text);
		} catch (error) {
			if (generation !== owner) return;
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			if (state === transcribing) {
				state = { kind: "idle" };
				setStatus(context, undefined);
			}
			await dependencies.removeDirectory(directory);
		}
	}

	async function toggle(context: ExtensionContext): Promise<void> {
		if (!VOICE_MODES.has(context.mode)) return;
		if (state.kind === "idle") return startRecording(context);
		if (state.kind === "starting") {
			state.stopRequested = true;
			return;
		}
		if (state.kind === "recording") return stopRecording(context);
	}

	function shutdown(): void {
		generation += 1;
		const current = state;
		state = { kind: "idle" };
		if (current.kind === "recording") {
			current.recorder.kill("SIGINT");
			void dependencies.removeDirectory(current.directory);
		}
		if (current.kind === "transcribing") current.abort.abort();
	}

	return { toggle, shutdown };
}

export function registerVoice(pi: ExtensionAPI, controller: VoiceController = createVoiceController()): void {
	pi.registerShortcut(VOICE_SHORTCUT, {
		description: "Start or stop voice dictation into the prompt",
		handler: (context) => controller.toggle(context),
	});
	pi.registerCommand(VOICE_COMMAND, {
		description: `Start or stop voice dictation into the prompt (same as ${VOICE_SHORTCUT})`,
		handler: async (_args, context) => controller.toggle(context),
	});
	pi.on("session_shutdown", () => controller.shutdown());
}
