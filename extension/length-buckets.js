// Split batches by length before they go into the model. A batch is padded to the longest text:
// one long paragraph with four short ones cost desklib 15.3 s instead of 4.9 s separately - with
// identical scores, because the padding tokens are masked out anyway (training/EVAL_RESULTS.md,
// "Padding"). Same rule in the server: server/shim_server.py, length_buckets().

/**
 * @param {number[]} lengths  tokens per text
 * @returns {number[][]} groups of indices; within a group the longest text is at most
 *   `ratio` times as long as the shortest (plus `slack` tokens, so that very short texts stay together)
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
