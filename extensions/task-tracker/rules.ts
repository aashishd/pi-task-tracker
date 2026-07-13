export const MIN_TASK_WORDS = 3;
export const MAX_TASK_WORDS = 15;
export const MAX_FOLLOW_UP_LISTS = 2;

export function countTaskWords(text: string): number {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function hasValidTaskWordCount(text: string): boolean {
	const count = countTaskWords(text);
	return count >= MIN_TASK_WORDS && count <= MAX_TASK_WORDS;
}

export function validateTaskWordCounts(tasks: string[]): void {
	const invalid = tasks
		.map((text, index) => ({ index: index + 1, words: countTaskWords(text) }))
		.filter(({ words }) => words < MIN_TASK_WORDS || words > MAX_TASK_WORDS);

	if (invalid.length === 0) return;

	const details = invalid.map(({ index, words }) => `#${index} has ${words}`).join(", ");
	throw new Error(`Each task must contain ${MIN_TASK_WORDS} to ${MAX_TASK_WORDS} words; ${details}.`);
}

export function shouldClearForFollowUpLimit(followUpListsCreated: number | undefined): boolean {
	return (followUpListsCreated ?? 0) >= MAX_FOLLOW_UP_LISTS;
}

export function shouldClearForCompaction(reason: "manual" | "threshold" | "overflow"): boolean {
	return reason === "manual";
}
