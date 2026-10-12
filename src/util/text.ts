export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/** Keeps the start and the end of long text. */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.max(1, Math.floor((max - 20) / 2));
	return `${text.slice(0, half)} … [${text.length - 2 * half} chars omitted] … ${text.slice(-half)}`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function fmt(value: number, digits = 3): string {
	return value.toFixed(digits);
}
