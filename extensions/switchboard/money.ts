declare const MICRO_CENTS_BRAND: unique symbol;
declare const PRICE_BRAND: unique symbol;

export type MicroCents = number & { readonly [MICRO_CENTS_BRAND]: "MicroCents" };
export type MicroCentsPerMillionTokens = number & { readonly [PRICE_BRAND]: "MicroCentsPerMillionTokens" };

export const MICRO_CENTS_PER_CENT = 1_000_000;
export const CENTS_PER_DOLLAR = 100;
export const MICRO_CENTS_PER_DOLLAR = MICRO_CENTS_PER_CENT * CENTS_PER_DOLLAR;

export function microCents(value: number): MicroCents {
	if (!Number.isSafeInteger(value)) {
		throw new Error(`MicroCents must be a safe integer count of micro-cents, got ${String(value)}`);
	}
	return value as MicroCents;
}

export function microCentsPerMillionTokens(value: number): MicroCentsPerMillionTokens {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`price per million tokens must be a non-negative safe integer, got ${String(value)}`);
	}
	return value as MicroCentsPerMillionTokens;
}

export function dollarsPerMillionTokens(price: MicroCentsPerMillionTokens): number {
	return price / MICRO_CENTS_PER_DOLLAR;
}
