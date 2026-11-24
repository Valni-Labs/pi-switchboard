import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
