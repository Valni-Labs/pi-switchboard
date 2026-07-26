import { execFileSync } from "node:child_process";
import { resolveAccessToken, resolveRunnerBaseUrl, resolveSessionId } from "./config.ts";
import { describeNetworkFailure, isAbortError } from "./errors.ts";

const RUNS_PATH = "/v1/runs";
const DEFAULT_FORGE = "github";
const ACCEPTED_STATUS = 202;

export interface SpawnHandle {
	id: string;
	status: string;
	resultLocation?: string;
}

export interface SpawnInput {
	task: string;
	repo?: string;
	base_ref?: string;
	result_location?: string;
}

export type SpawnOutcome = { ok: true; handle: SpawnHandle; message: string } | { ok: false; message: string };

export function parseGitHubRepo(remote: string): string | null {
	const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
	return match ? match[1] : null;
}

function gitLine(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		return null;
	}
}

export function deriveRepo(cwd: string): string | null {
	const remote = gitLine(cwd, ["remote", "get-url", "origin"]);
	return remote ? parseGitHubRepo(remote) : null;
}

export function deriveBaseRef(cwd: string): string | null {
	const branch = gitLine(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return branch && branch !== "HEAD" ? branch : null;
}

export async function submitSpawn(input: SpawnInput, cwd: string, signal?: AbortSignal): Promise<SpawnOutcome> {
	const token = resolveAccessToken();
	if (!token) {
		return { ok: false, message: "Not signed in to Switchboard — run /login before spawning a sub-agent." };
	}
	const repo = input.repo ?? deriveRepo(cwd);
	if (!repo) {
		return { ok: false, message: "Could not determine the repository. Pass repo (owner/name), or run from a git repo with a GitHub origin remote." };
	}
	const baseRef = input.base_ref ?? deriveBaseRef(cwd);
	if (!baseRef) {
		return { ok: false, message: "Could not determine the base ref. Pass base_ref, or check out a branch first." };
	}

	const sessionId = resolveSessionId();
	const body = {
		forge: DEFAULT_FORGE,
		repo,
		base_ref: baseRef,
		task: { prompt: input.task },
		...(sessionId ? { parent_session: sessionId } : {}),
	};

	const runnerBaseUrl = resolveRunnerBaseUrl();
	let response: Response;
	try {
		response = await fetch(`${runnerBaseUrl}${RUNS_PATH}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw error;
		return { ok: false, message: `Could not reach the runner at ${runnerBaseUrl}: ${describeNetworkFailure(error)}` };
	}

	if (response.status !== ACCEPTED_STATUS) {
		const detail = await response.text().catch(() => "");
		return { ok: false, message: `The runner rejected the spawn (HTTP ${response.status})${detail ? `: ${detail}` : ""}.` };
	}

	const payload = (await response.json().catch(() => ({}))) as { run_id?: string; status?: string };
	if (typeof payload.run_id !== "string" || payload.run_id.length === 0) {
		return { ok: false, message: "The runner accepted the spawn but returned no run id." };
	}

	const handle: SpawnHandle = {
		id: payload.run_id,
		status: typeof payload.status === "string" ? payload.status : "queued",
		...(input.result_location ? { resultLocation: input.result_location } : {}),
	};
	const where = handle.resultLocation ? ` for ${handle.resultLocation}` : "";
	return {
		ok: true,
		handle,
		message: `Spawned run ${handle.id} (${handle.status})${where}. It runs independently; you'll get a "check it" steer when it finishes. Keep working.`,
	};
}
