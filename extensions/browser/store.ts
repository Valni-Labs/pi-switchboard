import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DIRECTORY_MODE = 0o700;
const INDEX_MODE = 0o600;
const INDEX_FILE = "connections.json";

export interface StoredConnection {
	name: string;
	loginUrl: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export function validConnectionName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

export function ensureStoreDir(baseDir: string): void {
	mkdirSync(baseDir, { recursive: true, mode: DIRECTORY_MODE });
	chmodSync(baseDir, DIRECTORY_MODE);
}

export function profileDir(baseDir: string, name: string): string {
	if (!validConnectionName(name)) throw new Error(`Invalid connection name "${name}". Use letters, digits, dashes, and underscores.`);
	return join(baseDir, "profiles", name);
}

function indexPath(baseDir: string): string {
	return join(baseDir, INDEX_FILE);
}

export function listConnections(baseDir: string): StoredConnection[] {
	const path = indexPath(baseDir);
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	const connections = (parsed as { connections?: unknown }).connections;
	if (!Array.isArray(connections)) return [];
	return connections.filter(
		(entry): entry is StoredConnection =>
			entry !== null &&
			typeof entry === "object" &&
			typeof (entry as StoredConnection).name === "string" &&
			typeof (entry as StoredConnection).loginUrl === "string" &&
			typeof (entry as StoredConnection).createdAt === "number",
	);
}

function writeConnections(baseDir: string, connections: StoredConnection[]): void {
	ensureStoreDir(baseDir);
	writeFileSync(indexPath(baseDir), `${JSON.stringify({ connections }, null, "\t")}\n`, { mode: INDEX_MODE });
}

export function saveConnection(baseDir: string, name: string, loginUrl: string, now: number): StoredConnection {
	if (!validConnectionName(name)) throw new Error(`Invalid connection name "${name}". Use letters, digits, dashes, and underscores.`);
	const connections = listConnections(baseDir);
	const existing = connections.find((entry) => entry.name === name);
	const saved: StoredConnection = {
		name,
		loginUrl,
		createdAt: existing?.createdAt ?? now,
		lastUsedAt: existing?.lastUsedAt ?? null,
	};
	writeConnections(baseDir, [...connections.filter((entry) => entry.name !== name), saved]);
	return saved;
}

export function touchConnection(baseDir: string, name: string, now: number): void {
	const connections = listConnections(baseDir);
	const existing = connections.find((entry) => entry.name === name);
	if (!existing) return;
	writeConnections(baseDir, connections.map((entry) => (entry.name === name ? { ...entry, lastUsedAt: now } : entry)));
}

export function removeConnection(baseDir: string, name: string): boolean {
	const connections = listConnections(baseDir);
	const existed = connections.some((entry) => entry.name === name);
	writeConnections(baseDir, connections.filter((entry) => entry.name !== name));
	rmSync(profileDir(baseDir, name), { recursive: true, force: true });
	return existed;
}
