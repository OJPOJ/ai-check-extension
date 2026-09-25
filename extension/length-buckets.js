// Batches nach Länge aufteilen, bevor sie ins Modell gehen. Ein Batch wird auf den längsten Text
// aufgefüllt: ein langer Absatz mit vier kurzen kostete desklib 15,3 s statt 4,9 s getrennt - bei
// identischen Scores, weil die Füll-Tokens ohnehin ausmaskiert werden (training/EVAL_RESULTS.md,
// "Auffüllen"). Gleiche Regel im Server: server/shim_server.py, length_buckets().

/**
 * @param {number[]} lengths  Tokens pro Text
 * @returns {number[][]} Gruppen von Indizes; innerhalb einer Gruppe ist der längste Text höchstens
 *   `ratio`-mal so lang wie der kürzeste (plus `slack` Tokens, damit sehr kurze Texte zusammenbleiben)
 */
export function lengthBuckets(lengths, { ratio = 1.25, slack = 16 } = {}) {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  const groups = [];
  for (const i of order) {
    const group = groups.at(-1);
    if (group && lengths[i] <= lengths[group[0]] * ratio + slack) group.push(i);
    else groups.push([i]);
  }
  return groups;
}
