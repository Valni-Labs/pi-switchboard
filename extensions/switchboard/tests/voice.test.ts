import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createVoiceController,
	DICTATION_MODEL,
	MAXIMUM_RECORDING_SECONDS,
	SAMPLE_RATE_HERTZ,
	hasSpokenAudio,
	parseTranscription,
	recorderArguments,
	transcriptionForm,
	transcriptionsUrl,
} from "../voice.ts";

test("transcriptions url joins the Switchboard base", () => {
	assert.equal(transcriptionsUrl("https://switchboard.valni.app"), "https://switchboard.valni.app/v1/switchboard/transcriptions");
	assert.equal(transcriptionsUrl("http://localhost:8787"), "http://localhost:8787/v1/switchboard/transcriptions");
});

test("recorder writes 16 kHz mono 16-bit wav and stops itself at the maximum length", () => {
	const args = recorderArguments("/tmp/out.wav");
	assert.deepEqual(args, [
		"-q",
		"-c",
		"1",
		"-r",
		String(SAMPLE_RATE_HERTZ),
		"-b",
		"16",
		"-e",
		"signed-integer",
		"/tmp/out.wav",
		"trim",
		"0",
		String(MAXIMUM_RECORDING_SECONDS),
	]);
});

test("transcription form carries the model, the end user, the idempotency key, and the wav file last", async () => {
	const audio = new Uint8Array([1, 2, 3]);
	const form = transcriptionForm(audio, "eu_123", "dictation-1");
	assert.equal(form.get("model"), DICTATION_MODEL);
	assert.equal(form.get("user_id"), "eu_123");
	assert.equal(form.get("idempotency_key"), "dictation-1");
	assert.deepEqual([...form.keys()], ["model", "user_id", "idempotency_key", "file"]);
	const file = form.get("file");
	assert.ok(file instanceof Blob);
	assert.equal(file.type, "audio/wav");
	assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
});

test("transcription text is trimmed and anything else is refused", () => {
	assert.equal(parseTranscription({ text: "  fix the login bug \n" }), "fix the login bug");
	assert.equal(parseTranscription({ text: "" }), "");
	assert.equal(parseTranscription({ transcript: "hi" }), null);
	assert.equal(parseTranscription({ text: 3 }), null);
	assert.equal(parseTranscription(null), null);
	assert.equal(parseTranscription(["hi"]), null);
});

test("a header-only wav counts as silence", () => {
	assert.equal(hasSpokenAudio(new Uint8Array(44)), false);
	assert.equal(hasSpokenAudio(new Uint8Array(45)), true);
});

interface Deferred<Value> {
	promise: Promise<Value>;
	resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function fakeRecorder(): ChildProcess {
	const recorder = new EventEmitter() as unknown as ChildProcess;
	recorder.kill = () => {
		queueMicrotask(() => recorder.emit("exit", 0));
		return true;
	};
	return recorder;
}

interface FakeSession {
	context: ExtensionContext;
	pasted: string[];
	notices: string[];
}

function fakeSession(): FakeSession {
	const pasted: string[] = [];
	const notices: string[] = [];
	const context = {
		mode: "tui",
		ui: {
			setStatus: () => {},
			notify: (message: string) => notices.push(message),
			pasteToEditor: (text: string) => pasted.push(text),
		},
	} as unknown as ExtensionContext;
	return { context, pasted, notices };
}

const SPOKEN_WAV = new Uint8Array(new ArrayBuffer(128));

async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a second press while the recorder is starting stops it instead of starting another", async () => {
	const directory = deferred<string>();
	let spawned = 0;
	const session = fakeSession();
	const controller = createVoiceController({
		makeDirectory: () => directory.promise,
		removeDirectory: async () => {},
		spawnRecorder: () => {
			spawned += 1;
			return fakeRecorder();
		},
		readRecording: async () => SPOKEN_WAV,
		transcribe: async () => "hello",
	});
	const first = controller.toggle(session.context);
	const second = controller.toggle(session.context);
	directory.resolve("/tmp/voice-test");
	await Promise.all([first, second]);
	await settle();
	assert.equal(spawned, 1);
	assert.deepEqual(session.pasted, ["hello"]);
});

test("shutdown while the recorder is starting never opens the microphone and removes the directory", async () => {
	const directory = deferred<string>();
	const removed: string[] = [];
	let spawned = 0;
	const session = fakeSession();
	const controller = createVoiceController({
		makeDirectory: () => directory.promise,
		removeDirectory: async (path) => {
			removed.push(path);
		},
		spawnRecorder: () => {
			spawned += 1;
			return fakeRecorder();
		},
		readRecording: async () => SPOKEN_WAV,
		transcribe: async () => "hello",
	});
	const starting = controller.toggle(session.context);
	controller.shutdown();
	directory.resolve("/tmp/voice-test");
	await starting;
	await settle();
	assert.equal(spawned, 0);
	assert.deepEqual(removed, ["/tmp/voice-test"]);
});

test("shutdown during transcription cancels it and keeps its text out of the next session", async () => {
	const transcription = deferred<string>();
	let signal: AbortSignal | undefined;
	let spawned = 0;
	const oldSession = fakeSession();
	const newSession = fakeSession();
	const controller = createVoiceController({
		makeDirectory: async () => "/tmp/voice-test",
		removeDirectory: async () => {},
		spawnRecorder: () => {
			spawned += 1;
			return fakeRecorder();
		},
		readRecording: async () => SPOKEN_WAV,
		transcribe: async (_context, _audio, abortSignal) => {
			signal = abortSignal;
			return transcription.promise;
		},
	});
	await controller.toggle(oldSession.context);
	const stopping = controller.toggle(oldSession.context);
	await settle();
	controller.shutdown();
	assert.equal(signal?.aborted, true);
	await controller.toggle(newSession.context);
	transcription.resolve("old words");
	await stopping;
	assert.deepEqual(oldSession.pasted, []);
	assert.deepEqual(newSession.pasted, []);
	assert.deepEqual(oldSession.notices, []);
	assert.equal(spawned, 2);
	await controller.toggle(newSession.context);
	await settle();
	assert.equal(spawned, 2);
});
