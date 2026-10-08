import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveBaseUrl } from "./config.ts";
import { resolveInvokeToken } from "./toolProxy.ts";

const SKILLS_PATH = "/v1/skills";
const DISCOVER_TIMEOUT_MS = 10_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;

export const SKILLS_DIRECTORY = join(tmpdir(), `switchboard-skills-${process.pid}`);

export interface ServedSkillFile {
	path: string;
	content: string;
}

export interface ServedSkill {
	name: string;
	description: string;
	files: ServedSkillFile[];
}

function isServedSkill(value: unknown): value is ServedSkill {
	if (value === null || typeof value !== "object") return false;
	const skill = value as Record<string, unknown>;
	return (
		typeof skill.name === "string" &&
		SKILL_NAME.test(skill.name) &&
		Array.isArray(skill.files) &&
		skill.files.every(
			(file) =>
				file !== null &&
				typeof file === "object" &&
				typeof (file as Record<string, unknown>).path === "string" &&
				typeof (file as Record<string, unknown>).content === "string",
		)
	);
}

export async function discoverSkills(baseUrl: string, bearer: string, signal?: AbortSignal): Promise<ServedSkill[]> {
	const timeout = AbortSignal.timeout(DISCOVER_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${baseUrl}${SKILLS_PATH}`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (error) {
		console.error("pi-switchboard: skill discovery failed", error);
		return [];
	}
	if (!response.ok) {
		console.error(`pi-switchboard: skill discovery failed (HTTP ${response.status})`);
		return [];
	}
	const body = (await response.json().catch(() => null)) as { skills?: unknown } | null;
	if (!Array.isArray(body?.skills)) return [];
	return body.skills.filter(isServedSkill);
}

export function materializeSkills(skills: ServedSkill[], root: string): string[] {
	rmSync(root, { recursive: true, force: true });
	const skillDirectories: string[] = [];
	for (const skill of skills) {
		const skillDirectory = join(root, skill.name);
		for (const file of skill.files) {
			const target = resolve(skillDirectory, file.path);
			if (!target.startsWith(`${skillDirectory}${sep}`)) continue;
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, file.content);
		}
		skillDirectories.push(skillDirectory);
	}
	return skillDirectories;
}

export function registerServedSkills(pi: ExtensionAPI): void {
	pi.on("resources_discover", async (_event, ctx) => {
		const token = await resolveInvokeToken(ctx);
		if (!token) {
			rmSync(SKILLS_DIRECTORY, { recursive: true, force: true });
			return {};
		}
		const skills = await discoverSkills(resolveBaseUrl(), token);
		return { skillPaths: materializeSkills(skills, SKILLS_DIRECTORY) };
	});
	pi.on("session_shutdown", () => {
		rmSync(SKILLS_DIRECTORY, { recursive: true, force: true });
	});
}
