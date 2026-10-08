// Grouping by length before the model call (extension/length-buckets.js, counterpart in the server).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lengthBuckets } from "../../extension/length-buckets.js";

const covers = (groups, n) => assert.deepEqual(groups.flat().sort((a, b) => a - b), [...Array(n).keys()]);

describe("lengthBuckets", () => {
  it("separates one long text from short ones (otherwise all would be padded to it)", () => {
    const groups = lengthBuckets([654, 71, 64, 66, 72]);
    assert.deepEqual(groups, [[2, 3, 1, 4], [0]]);
  });

  it("keeps similarly long texts together and covers every index exactly once", () => {
    const lengths = [120, 130, 140, 400, 410, 90, 700];
    const groups = lengthBuckets(lengths);
    covers(groups, lengths.length);
    for (const g of groups) {
      const ls = g.map((i) => lengths[i]);
      assert.ok(Math.max(...ls) <= Math.min(...ls) * 1.25 + 16, `group ${ls}`);
    }
    assert.equal(groups.length, 4); // [90,120] [130,140] [400,410] [700]
  });

  it("keeps very short texts together despite a large ratio (slack)", () => {
    assert.deepEqual(lengthBuckets([5, 12, 20]), [[0, 1, 2]]);
  });

  it("copes with one and no text", () => {
    assert.deepEqual(lengthBuckets([300]), [[0]]);
    assert.deepEqual(lengthBuckets([]), []);
  });
});
