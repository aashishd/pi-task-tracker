import assert from "node:assert/strict";
import test from "node:test";
import { wrapWidgetLines } from "../extensions/task-tracker/rendering.ts";

test("keeps every wrapped widget continuation line", () => {
	const calls: Array<{ text: string; width: number }> = [];
	const wrapped = wrapWidgetLines(["\u001b[36m◐ #2 A long task label\u001b[39m"], 12, (text, width) => {
		calls.push({ text, width });
		return [" first line", " second line"];
	});

	assert.deepEqual(calls, [{ text: " \u001b[36m◐ #2 A long task label\u001b[39m", width: 12 }]);
	assert.deepEqual(wrapped, [" first line", " second line"]);
	assert.equal(wrapped.some((line) => line.endsWith("...")), false);
});

test("uses a positive width for narrow widget renders", () => {
	let receivedWidth = 0;
	wrapWidgetLines(["task"], 0, (_text, width) => {
		receivedWidth = width;
		return ["task"];
	});

	assert.equal(receivedWidth, 1);
});
