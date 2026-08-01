import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	ensureStoreDir,
	listConnections,
	profileDir,
	removeConnection,
	saveConnection,
	touchConnection,
	validConnectionName,
} from "../store.ts";

let baseDir = "";

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "pi-browser-store-"));
	rmSync(baseDir, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

test("validConnectionName accepts safe names and rejects path tricks", () => {
	assert.equal(validConnectionName("dental-portal"), true);
	assert.equal(validConnectionName("Clinic_2"), true);
	assert.equal(validConnectionName("../evil"), false);
	assert.equal(validConnectionName("a/b"), false);
	assert.equal(validConnectionName(""), false);
	assert.equal(validConnectionName("-leading"), false);
});

test("profileDir rejects invalid names", () => {
	assert.throws(() => profileDir(baseDir, "../evil"), /Invalid connection name/);
});

test("ensureStoreDir creates the base directory with 0700", () => {
	ensureStoreDir(baseDir);
	assert.equal(statSync(baseDir).mode & 0o777, 0o700);
});

test("save, list, touch, and remove round-trip", () => {
	saveConnection(baseDir, "clinic", "https://portal.example.com/login", 1_000);
	assert.equal(statSync(join(baseDir, "connections.json")).mode & 0o777, 0o600);
	let connections = listConnections(baseDir);
	assert.equal(connections.length, 1);
	assert.deepEqual(connections[0], { name: "clinic", loginUrl: "https://portal.example.com/login", createdAt: 1_000, lastUsedAt: null });

	touchConnection(baseDir, "clinic", 2_000);
	connections = listConnections(baseDir);
	assert.equal(connections[0].lastUsedAt, 2_000);

	saveConnection(baseDir, "clinic", "https://portal.example.com/signin", 3_000);
	connections = listConnections(baseDir);
	assert.equal(connections.length, 1);
	assert.equal(connections[0].createdAt, 1_000);
	assert.equal(connections[0].loginUrl, "https://portal.example.com/signin");

	const profile = profileDir(baseDir, "clinic");
	mkdirSync(profile, { recursive: true });
	assert.equal(removeConnection(baseDir, "clinic"), true);
	assert.equal(listConnections(baseDir).length, 0);
	assert.equal(existsSync(profile), false);
	assert.equal(removeConnection(baseDir, "clinic"), false);
});

test("touchConnection ignores unknown names", () => {
	saveConnection(baseDir, "clinic", "https://portal.example.com/login", 1_000);
	touchConnection(baseDir, "other", 2_000);
	assert.equal(listConnections(baseDir)[0].lastUsedAt, null);
});

test("listConnections tolerates a corrupt index", () => {
	ensureStoreDir(baseDir);
	writeFileSync(join(baseDir, "connections.json"), "not json");
	assert.deepEqual(listConnections(baseDir), []);
	writeFileSync(join(baseDir, "connections.json"), JSON.stringify({ connections: [{ name: 42 }] }));
	assert.deepEqual(listConnections(baseDir), []);
});
