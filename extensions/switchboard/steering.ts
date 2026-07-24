import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type Delivery = "steer" | "followUp";

const DELIVERIES: Delivery[] = ["steer", "followUp"];

const STEERING_RULES_FILE = join(".pi", "steering-rules.json");

interface ToolSteeringRuleConfig {
	tool: string;
	match: string;
	steer: string;
	deliverAs?: Delivery;
}

interface SteeringRulesFile {
	toolRules?: ToolSteeringRuleConfig[];
}

export interface CompiledSteeringRule {
	tool: string;
	pattern: RegExp;
	steer: string;
	deliverAs?: Delivery;
}

function normalizeDelivery(value: unknown, context: ExtensionContext): Delivery | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (DELIVERIES as string[]).includes(value)) {
		return value as Delivery;
	}
	if (context.hasUI) {
		context.ui.notify(`Switchboard: ignoring invalid steering deliverAs "${String(value)}"`, "warning");
	}
	return undefined;
}

export function steeringSubject(event: ToolResultEvent): string {
	const input = event.input;
	const command = input.command;
	if (typeof command === "string") return command;
	const path = input.path ?? input.file_path;
	if (typeof path === "string") return path;
	const url = input.url;
	if (typeof url === "string") return url;
	return JSON.stringify(input);
}

export function loadSteeringRules(cwd: string, context: ExtensionContext): CompiledSteeringRule[] {
	const rulesPath = join(cwd, STEERING_RULES_FILE);
	if (!existsSync(rulesPath)) return [];

	let parsed: SteeringRulesFile;
	try {
		parsed = JSON.parse(readFileSync(rulesPath, "utf-8")) as SteeringRulesFile;
	} catch (error) {
		if (context.hasUI) {
			context.ui.notify(`Switchboard: unreadable ${STEERING_RULES_FILE}: ${String(error)}`, "error");
		}
		return [];
	}

	if (parsed.toolRules !== undefined && !Array.isArray(parsed.toolRules)) {
		if (context.hasUI) {
			context.ui.notify(`Switchboard: "toolRules" in ${STEERING_RULES_FILE} must be an array`, "error");
		}
		return [];
	}

	const compiled: CompiledSteeringRule[] = [];
	for (const rule of parsed.toolRules ?? []) {
		if (!rule.tool || !rule.match || !rule.steer) {
			if (context.hasUI) {
				context.ui.notify("Switchboard: skipping steering rule missing tool/match/steer", "warning");
			}
			continue;
		}
		try {
			compiled.push({ tool: rule.tool, pattern: new RegExp(rule.match), steer: rule.steer, deliverAs: normalizeDelivery(rule.deliverAs, context) });
		} catch (error) {
			if (context.hasUI) {
				context.ui.notify(`Switchboard: invalid steering pattern "${rule.match}": ${String(error)}`, "warning");
			}
		}
	}
	return compiled;
}
