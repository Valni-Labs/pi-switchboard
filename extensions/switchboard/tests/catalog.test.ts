import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sandbox = mkdtempSync(join(tmpdir(), "pi-switchboard-catalog-"));
const hostDir = join(sandbox, "host", "dist");
mkdirSync(hostDir, { recursive: true });
const fakeCli = join(hostDir, "cli.js");
writeFileSync(fakeCli, "");

const originalArgv1 = process.argv[1];
process.argv[1] = fakeCli;

const { loadRegistryModels } = await import("../catalog.ts");

test.after(() => {
	process.argv[1] = originalArgv1;
	rmSync(sandbox, { recursive: true, force: true });
});

function placeAiPackage(scope: string, name: string): void {
	mkdirSync(join(sandbox, "host", "node_modules", scope, name, "dist"), { recursive: true });
}

function clearAiPackages(): void {
	rmSync(join(sandbox, "host", "node_modules"), { recursive: true, force: true });
}

test("the host's ai package is found under pi's name", async () => {
	clearAiPackages();
	placeAiPackage("@earendil-works", "pi-ai");
	assert.deepEqual(await loadRegistryModels(), {});
});

test("the host's ai package is found under valni's name", async () => {
	clearAiPackages();
	placeAiPackage("@valni", "ai");
	assert.deepEqual(await loadRegistryModels(), {});
});

test("an empty registry is reported rather than passed off as success", async () => {
	clearAiPackages();
	placeAiPackage("@valni", "ai");
	const seen: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
	try {
		assert.deepEqual(await loadRegistryModels(), {});
	} finally {
		console.error = original;
	}
	assert.equal(seen.length, 1);
	assert.match(seen[0], /no model registry/u);
	assert.match(seen[0], /anthropic\.models\.js, openai\.models\.js/u);
});

test("with neither present the error names both", async () => {
	clearAiPackages();
	await assert.rejects(loadRegistryModels(), (error: Error) => {
		assert.match(error.message, /@earendil-works\/pi-ai/u);
		assert.match(error.message, /@valni\/ai/u);
		return true;
	});
});
