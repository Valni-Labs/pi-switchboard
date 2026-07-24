import type { Model } from "@earendil-works/pi-ai";

export const KIND_TO_API = {
	anthropic: "anthropic-messages",
	openai_generic: "openai-completions",
	openai_pro: "openai-responses",
} as const;

export type SwitchboardKind = keyof typeof KIND_TO_API;

export interface KindProfile {
	model: string;
	maxTokensCeiling?: number;
	vision?: boolean;
	thinking?: { modes: string[] } | false;
	reasoningEffort?: string[] | false;
}

export interface ModelRecord {
	id: string;
	kind: Record<string, KindProfile>;
}

export interface ModelRecordPrice {
	input_micro_cents_per_mtok: number;
	output_micro_cents_per_mtok: number;
	cached_input_micro_cents_per_mtok: number | null;
	effective_at: number;
}

export interface ModelsPage {
	models: ModelRecord[];
	prices: Record<string, ModelRecordPrice>;
}

export type RegistryModel = Model<(typeof KIND_TO_API)[SwitchboardKind]>;
