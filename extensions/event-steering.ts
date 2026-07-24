import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type Delivery = "steer" | "followUp";

interface ToolSteeringRuleConfig {
	tool: string;
	match: string;
	steer: string;
	deliverAs?: Delivery;
}

interface SteeringRulesFile {
	toolRules?: ToolSteeringRuleConfig[];
}

interface CompiledRule {
	tool: string;
	pattern: RegExp;
	steer: string;
	deliverAs?: Delivery;
}

const RULES_FILENAME = join(".pi", "steering-rules.json");

function subjectFor(event: ToolResultEvent): string {
	const input = event.input;
	const command = input.command;
	if (typeof command === "string") return command;
	const path = input.path ?? input.file_path;
	if (typeof path === "string") return path;
	const url = input.url;
	if (typeof url === "string") return url;
	return JSON.stringify(input);
}

function loadRules(cwd: string, context: ExtensionContext): CompiledRule[] {
	const rulesPath = join(cwd, RULES_FILENAME);
	if (!existsSync(rulesPath)) return [];

	let parsed: SteeringRulesFile;
	try {
		parsed = JSON.parse(readFileSync(rulesPath, "utf-8")) as SteeringRulesFile;
	} catch (error) {
		if (context.hasUI) {
			context.ui.notify(`event-steering: unreadable ${RULES_FILENAME}: ${String(error)}`, "error");
		}
		return [];
	}

	const compiled: CompiledRule[] = [];
	for (const rule of parsed.toolRules ?? []) {
		if (!rule.tool || !rule.match || !rule.steer) {
			if (context.hasUI) {
				context.ui.notify("event-steering: skipping rule missing tool/match/steer", "warning");
			}
			continue;
		}
		try {
			compiled.push({ tool: rule.tool, pattern: new RegExp(rule.match), steer: rule.steer, deliverAs: rule.deliverAs });
		} catch (error) {
			if (context.hasUI) {
				context.ui.notify(`event-steering: invalid pattern "${rule.match}": ${String(error)}`, "warning");
			}
		}
	}
	return compiled;
}

export default function (pi: ExtensionAPI) {
	let rules: CompiledRule[] = [];

	pi.on("session_start", (_event, context) => {
		rules = loadRules(process.cwd(), context);
		if (rules.length > 0 && context.hasUI) {
			context.ui.notify(`event-steering: ${rules.length} rule(s) active`, "info");
		}
	});

	pi.on("tool_result", (event, context) => {
		if (event.isError || rules.length === 0) return;

		const subject = subjectFor(event);
		for (const rule of rules) {
			if (rule.tool !== event.toolName) continue;
			if (!rule.pattern.test(subject)) continue;

			if (context.isIdle()) {
				pi.sendUserMessage(rule.steer);
			} else {
				pi.sendUserMessage(rule.steer, { deliverAs: rule.deliverAs ?? "followUp" });
			}
		}
	});
}
