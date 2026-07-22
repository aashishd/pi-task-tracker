import assert from "node:assert/strict";
import test from "node:test";
import {
	countTaskWords,
	hasValidTaskWordCount,
	MAX_FOLLOW_UP_LISTS,
	shouldClearForCompaction,
	shouldClearForFollowUpLimit,
	validateTaskWordCounts,
} from "../extensions/task-tracker/rules.ts";

test("counts whitespace-separated task words", () => {
	assert.equal(countTaskWords("  Run focused tests\nfor this behavior  "), 6);
});

test("accepts task labels containing 3 through 15 words", () => {
	assert.equal(hasValidTaskWordCount("one two three"), true);
	assert.equal(hasValidTaskWordCount(Array.from({ length: 15 }, (_, index) => `word${index}`).join(" ")), true);
});

test("rejects task labels outside the 3 through 15 word range", () => {
	assert.equal(hasValidTaskWordCount("one two"), false);
	assert.equal(hasValidTaskWordCount(Array.from({ length: 16 }, (_, index) => `word${index}`).join(" ")), false);
	assert.throws(
		() => validateTaskWordCounts(["one two", "one two three"]),
		/Each task must contain 3 to 15 words; #1 has 2\./,
	);
});

test("clears when a third follow-up list would be created", () => {
	assert.equal(MAX_FOLLOW_UP_LISTS, 2);
	assert.equal(shouldClearForFollowUpLimit(undefined), false);
	assert.equal(shouldClearForFollowUpLimit(0), false);
	assert.equal(shouldClearForFollowUpLimit(1), false);
	assert.equal(shouldClearForFollowUpLimit(2), true);
	assert.equal(shouldClearForFollowUpLimit(3), true);
});

test("clears completed lists for every compaction trigger", () => {
	assert.equal(shouldClearForCompaction(true), true);
	assert.equal(shouldClearForCompaction(false), false);
});
