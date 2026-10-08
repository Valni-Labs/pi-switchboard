import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverSkills, materializeSkills } from "../skills.ts";

const SWITCHBOARD_SKILL = {
	name: "switchboard",
	description: "What Switchboard is.",
	files: [
		{ path: "SKILL.md", content: "---\nname: switchboard\ndescription: What Switchboard is.\n---\n" },
		{ path: "references/codes.md", content: "codes" },
	],
};

function withFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL, init: RequestInit) => handler(String(url), init)) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

test("discoverSkills reads /v1/skills with the bearer", async () => {
	const captured: { url: string; authorization: unknown }[] = [];
	const restore = withFetch((url, init) => {
		captured.push({ url, authorization: (init.headers as Record<string, string>).Authorization });
		return new Response(JSON.stringify({ skills: [SWITCHBOARD_SKILL] }), { status: 200 });
	});
	try {
		const skills = await discoverSkills("https://sb", "vst_x");
		assert.deepEqual(captured, [{ url: "https://sb/v1/skills", authorization: "Bearer vst_x" }]);
		assert.deepEqual(skills, [SWITCHBOARD_SKILL]);
	} finally {
		restore();
	}
});

test("discoverSkills returns nothing when Switchboard rejects the call", async () => {
	const restore = withFetch(() => new Response("{}", { status: 401 }));
	try {
		assert.deepEqual(await discoverSkills("https://sb", "vst_x"), []);
	} finally {
		restore();
	}
});

test("discoverSkills drops entries with an unsafe name or malformed files", async () => {
	const restore = withFetch(
		() =>
			new Response(
				JSON.stringify({
					skills: [SWITCHBOARD_SKILL, { name: "../escape", files: [] }, { name: "ok", files: [{ path: 1 }] }],
				}),
				{ status: 200 },
			),
	);
	try {
		assert.deepEqual((await discoverSkills("https://sb", "vst_x")).map((skill) => skill.name), ["switchboard"]);
	} finally {
		restore();
	}
});

test("materializeSkills writes each skill as a folder with its files", () => {
	const root = join(mkdtempSync(join(tmpdir(), "swb-skills-test-")), "skills");
	try {
		const paths = materializeSkills([SWITCHBOARD_SKILL], root);
		assert.deepEqual(paths, [join(root, "switchboard")]);
		assert.match(readFileSync(join(root, "switchboard", "SKILL.md"), "utf8"), /name: switchboard/u);
		assert.equal(readFileSync(join(root, "switchboard", "references", "codes.md"), "utf8"), "codes");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("materializeSkills replaces skills from an earlier session", () => {
	const root = join(mkdtempSync(join(tmpdir(), "swb-skills-test-")), "skills");
	try {
		materializeSkills([SWITCHBOARD_SKILL], root);
		assert.deepEqual(materializeSkills([], root), []);
		assert.equal(existsSync(join(root, "switchboard")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("materializeSkills never writes outside the skill folder", () => {
	const parent = mkdtempSync(join(tmpdir(), "swb-skills-test-"));
	const root = join(parent, "skills");
	try {
		materializeSkills(
			[{ name: "evil", description: "", files: [{ path: "../../outside.md", content: "x" }, { path: "SKILL.md", content: "y" }] }],
			root,
		);
		assert.equal(existsSync(join(parent, "outside.md")), false);
		assert.equal(readFileSync(join(root, "evil", "SKILL.md"), "utf8"), "y");
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
