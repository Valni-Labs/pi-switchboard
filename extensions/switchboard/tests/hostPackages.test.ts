import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A package belonging to a host this extension runs inside. */
const HOST_PACKAGE = /^(@earendil-works\/|@valni\/(?!switchboard))/u;

function isHostPackage(specifier: string): boolean {
	return HOST_PACKAGE.test(specifier);
}

/**
 * Every import form that still resolves the module at runtime. A type-only
 * import is erased before that happens, so it is the one form that is safe.
 *
 * The hosts disagree about their package names, so a name that resolves in one
 * throws in the other at load time, before the extension can do anything.
 */
export function hostPackageRuntimeImports(source: string): string[] {
	const found: string[] = [];
	const record = (form: string, specifier: string) => {
		if (isHostPackage(specifier)) found.push(`${form} ${specifier}`);
	};

	// import ... from "x"  and  export ... from "x"
	for (const match of source.matchAll(/\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/gu)) {
		const [, keyword, clause, specifier] = match;
		const trimmed = clause.trim();
		if (trimmed.startsWith("type ")) continue; // import type { A } from "x"
		const named = trimmed.match(/^\{([\s\S]*)\}$/u);
		if (named && named[1].split(",").every((part) => part.trim() === "" || part.trim().startsWith("type "))) {
			continue; // import { type A, type B } from "x"
		}
		record(`${keyword} ... from`, specifier);
	}

	// import "x"
	for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/gu)) {
		record("import", match[1]);
	}

	// import("x")  and  require("x")
	for (const match of source.matchAll(/\b(import|require)\s*\(\s*["']([^"']+)["']/gu)) {
		record(`${match[1]}()`, match[2]);
	}

	return found;
}

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			// Tests run against this repository's own dependencies and are never
			// loaded by a host, so only shipped files are checked.
			if (name === "tests") continue;
			found.push(...sourceFiles(path));
		} else if (name.endsWith(".ts")) {
			found.push(path);
		}
	}
	return found;
}

test("every runtime import form is caught, not only the named one", () => {
	const caught = (source: string) => hostPackageRuntimeImports(source).length > 0;

	assert.ok(caught('import { Type } from "@earendil-works/pi-ai";'), "named");
	assert.ok(caught('import Type from "@earendil-works/pi-ai";'), "default");
	assert.ok(caught('import * as ai from "@earendil-works/pi-ai";'), "namespace");
	assert.ok(caught('import "@earendil-works/pi-ai";'), "side effect");
	assert.ok(caught('const ai = await import("@earendil-works/pi-ai");'), "dynamic");
	assert.ok(caught('const ai = require("@earendil-works/pi-ai");'), "require");
	assert.ok(caught('export { Type } from "@earendil-works/pi-ai";'), "re-export");
	assert.ok(caught('import Type, { Static } from "@earendil-works/pi-ai";'), "default with named");
	assert.ok(caught('import { type A, b } from "@earendil-works/pi-ai";'), "one value among types");

	assert.ok(!caught('import type { Model } from "@earendil-works/pi-ai";'), "type-only clause");
	assert.ok(!caught('import { type A, type B } from "@earendil-works/pi-ai";'), "every specifier a type");
	assert.ok(!caught('import { Type } from "typebox";'), "a neutral package");
	assert.ok(!caught('import { native } from "@valni/switchboard";'), "the SDK this ships against");
	assert.ok(!caught('import { helper } from "./helper.ts";'), "a relative import");
});

test("no shipped file imports a host package at runtime", () => {
	const offenders: string[] = [];
	for (const file of sourceFiles(root)) {
		for (const entry of hostPackageRuntimeImports(readFileSync(file, "utf8"))) {
			offenders.push(`${file.slice(root.length + 1)}: ${entry}`);
		}
	}
	assert.deepEqual(offenders, [], `import these as types, or from a neutral package:\n${offenders.join("\n")}`);
});
