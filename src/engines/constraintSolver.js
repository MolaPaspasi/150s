/**
 * Phase 3: Constraint solver — valid outcome set Z for 2–4 conditions.
 * Enumerates feasible 0/1 vectors satisfying logical constraints (e.g. A→B).
 * Used to narrow the search space for Frank-Wolfe.
 */

/**
 * All 0/1 combinations for n binary outcomes (2^n vectors).
 * @param {number} n - number of outcomes (2–4)
 * @returns {number[][]} e.g. for n=2: [[0,0],[0,1],[1,0],[1,1]]
 */
export function allBinaryVectors(n) {
  if (n <= 0 || n > 8) return [];
  const out = [];
  for (let i = 0; i < (1 << n); i++) {
    const vec = [];
    for (let j = 0; j < n; j++) vec.push((i >> j) & 1);
    out.push(vec);
  }
  return out;
}

/**
 * Constraint: A implies B. So (A=1 => B=1). Valid: (0,0), (0,1), (1,1). Invalid: (1,0).
 * @param {number[]} vec - [a, b, ...] indices 0 and 1
 * @returns {boolean}
 */
export function satisfiesImplication(vec, aIndex = 0, bIndex = 1) {
  if (vec[aIndex] === 1 && vec[bIndex] === 0) return false;
  return true;
}

/**
 * Build valid set Z from constraints.
 * @param {number} numOutcomes - 2, 3, or 4
 * @param {Array<{ type: string, indices?: number[] }>} constraints - e.g. [{ type: "A_IMPLIES_B", indices: [0,1] }]
 * @returns {number[][]} list of valid 0/1 vectors
 */
export function computeValidSetZ(numOutcomes, constraints = []) {
  const all = allBinaryVectors(numOutcomes);
  return all.filter((vec) => {
    for (const c of constraints) {
      if (c.type === "A_IMPLIES_B" && c.indices?.length >= 2) {
        if (!satisfiesImplication(vec, c.indices[0], c.indices[1])) return false;
      }
      if (c.type === "MUTUAL_EXCLUSIVE" && c.indices?.length >= 2) {
        const sum = c.indices.reduce((s, i) => s + vec[i], 0);
        if (sum > 1) return false;
      }
    }
    return true;
  });
}

/**
 * Get corners (extreme points) of the convex hull of Z.
 * For 0/1 vectors, Z itself is the set of corners.
 * @param {number[][]} Z - valid outcome vectors
 * @returns {number[][]} same as Z for 0/1; for general polytope we'd compute vertices
 */
export function getCorners(Z) {
  return [...Z];
}
