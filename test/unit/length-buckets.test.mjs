// Gruppierung nach Länge vor dem Modellaufruf (extension/length-buckets.js, Gegenstück im Server).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lengthBuckets } from "../../extension/length-buckets.js";

const covers = (groups, n) => assert.deepEqual(groups.flat().sort((a, b) => a - b), [...Array(n).keys()]);

describe("lengthBuckets", () => {
  it("trennt einen langen Text von kurzen (sonst würden alle auf ihn aufgefüllt)", () => {
    const groups = lengthBuckets([654, 71, 64, 66, 72]);
    assert.deepEqual(groups, [[2, 3, 1, 4], [0]]);
  });

  it("hält ähnlich lange Texte zusammen und deckt jeden Index genau einmal ab", () => {
    const lengths = [120, 130, 140, 400, 410, 90, 700];
    const groups = lengthBuckets(lengths);
    covers(groups, lengths.length);
    for (const g of groups) {
      const ls = g.map((i) => lengths[i]);
      assert.ok(Math.max(...ls) <= Math.min(...ls) * 1.25 + 16, `Gruppe ${ls}`);
    }
    assert.equal(groups.length, 4); // [90,120] [130,140] [400,410] [700]
  });

  it("lässt sehr kurze Texte trotz großem Verhältnis zusammen (Spielraum)", () => {
    assert.deepEqual(lengthBuckets([5, 12, 20]), [[0, 1, 2]]);
  });

  it("kommt mit einem und keinem Text zurecht", () => {
    assert.deepEqual(lengthBuckets([300]), [[0]]);
    assert.deepEqual(lengthBuckets([]), []);
  });
});
