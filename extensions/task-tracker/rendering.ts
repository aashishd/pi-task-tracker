export type WidgetLineWrapper = (text: string, width: number) => string[];

export function wrapWidgetLines(lines: string[], width: number, wrapLine: WidgetLineWrapper): string[] {
	const safeWidth = Math.max(1, width);
	return lines.flatMap((line) => wrapLine(` ${line}`, safeWidth));
}
