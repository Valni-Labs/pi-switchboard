import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// A host package name in a value import has to resolve when the extension
// loads. The hosts disagree about those names, and one of them removed its
// alias in a rename, which broke every installed copy at startup. Type
// imports are erased before that can happen, so only value imports matter.
test("no value import names a host package", () => {
	const offenders: string[] = [];
	for (const file of sourceFiles(root)) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"(@earendil-works\/[^"]+|@valni\/(?!switchboard)[^"]+)"/gu)) {
			if (match[1]) continue;
			const named = match[2]
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0 && !part.startsWith("type "));
			if (named.length > 0) {
				offenders.push(`${file.slice(root.length + 1)}: ${named.join(", ")} from ${match[3]}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `import these as types, or from a neutral package:\n${offenders.join("\n")}`);
});
