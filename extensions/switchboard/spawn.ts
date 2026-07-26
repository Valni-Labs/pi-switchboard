import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { submitSpawn, type SpawnHandle } from "./spawnSubmit.ts";

const SpawnParams = Type.Object({
	task: Type.String({
		description:
			"Instructions for the sub-agent. This is the ONLY context it receives, so be specific about what to do and where — e.g. \"Review pull request #42 in this repo: check for correctness bugs and post review comments on the PR.\"",
	}),
	repo: Type.Optional(Type.String({ description: "owner/name of the repository. Defaults to this repository's origin remote." })),
	base_ref: Type.Optional(Type.String({ description: "Git ref the sub-agent starts from. Defaults to the current branch." })),
	result_location: Type.Optional(Type.String({ description: "Where the sub-agent's work will land (e.g. a PR number or URL). Recorded on the returned handle." })),
});

const outstandingHandles = new Map<string, SpawnHandle>();

export function outstandingSpawnHandles(): SpawnHandle[] {
	return [...outstandingHandles.values()];
}

export function clearSpawnHandles(): void {
	outstandingHandles.clear();
}

export function registerSpawnTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "spawn",
		label: "spawn",
		description:
			"Launch an independent sub-agent to work on a task in a repository — for example, spawn a reviewer after opening a pull request. Returns immediately with a run handle; the sub-agent runs on its own in the runner sandbox and posts its work to the forge (the PR). You keep working, and a follow-up steer tells you when it finishes so you can check its result.",
		parameters: SpawnParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outcome = await submitSpawn(params, ctx.cwd, signal);
			if (outcome.ok) outstandingHandles.set(outcome.handle.id, outcome.handle);
			return {
				content: [{ type: "text" as const, text: outcome.message }],
				details: outcome.ok ? outcome.handle : undefined,
			};
		},
	});
}
