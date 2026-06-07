/**
 * Phase 3: Frank-Wolfe (conditional gradient) for Bregman minimization over convex hull of valid corners.
 * Used for 2–4 outcome markets: minimize cost subject to being in the simplex / constraint set.
 */

import { getCorners } from "./constraintSolver.js";

const MAX_ITER = 100;
const TOL = 1e-6;

/**
 * Bregman divergence (log-sum-exp style) gradient at x.
 * We minimize f(x) = sum_i (x_i * log(x_i)) over simplex (sum x = 1, x >= 0).
 * Gradient: grad_i = 1 + log(x_i) for x_i > 0.
 * @param {number[]} x - probability vector
 * @returns {number[]} gradient
 */
function entropyGradient(x) {
  return x.map((xi) => (xi > 1e-10 ? 1 + Math.log(xi) : -1e10));
}

/**
 * Linear minimization over corners: argmin_{z in corners} grad . z
 * @param {number[]} grad
 * @param {number[][]} corners
 * @returns {{ corner: number[], value: number }}
 */
function linearMinOverCorners(grad, corners) {
  let best = null;
  let bestVal = Infinity;
  for (const z of corners) {
    const val = grad.reduce((s, g, i) => s + g * (z[i] ?? 0), 0);
    if (val < bestVal) {
      bestVal = val;
      best = z;
    }
  }
  return { corner: best ?? corners[0], value: bestVal };
}

/**
 * Frank-Wolfe step: minimize Bregman (entropy) over convex hull of valid set Z.
 * @param {number[][]} Z - valid outcome vectors (from constraintSolver.computeValidSetZ)
 * @param {number[]} [initial] - initial point (default: uniform over Z)
 * @returns {{ x: number[], iterations: number }}
 */
export function frankWolfeSimplex(Z, initial = null) {
  const corners = getCorners(Z);
  if (corners.length === 0) return { x: [], iterations: 0 };

  const n = corners[0].length;
  let x = initial ?? corners[0].map(() => 1 / n);
  if (x.length !== n) x = corners[0].map(() => 1 / n);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const grad = entropyGradient(x);
    const { corner: z } = linearMinOverCorners(grad, corners);
    const dir = z.map((zi, i) => zi - x[i]);
    const norm = Math.sqrt(dir.reduce((s, d) => s + d * d, 0));
    if (norm < TOL) break;

    // Line search: minimize entropy along x + t*(z-x), t in [0,1]
    let t = 1;
    const f = (tVal) => {
      const y = x.map((xi, i) => xi + tVal * (z[i] - xi));
      const sum = y.reduce((a, b) => a + b, 0);
      if (sum < 0.99 || sum > 1.01) return 1e10;
      return y.reduce((s, yi) => s + (yi > 1e-10 ? yi * Math.log(yi) : 0), 0);
    };
    let bestT = 0;
    let bestF = f(0);
    for (let k = 1; k <= 10; k++) {
      const tTry = k / 10;
      const val = f(tTry);
      if (val < bestF) {
        bestF = val;
        bestT = tTry;
      }
    }
    t = bestT;
    x = x.map((xi, i) => xi + t * (z[i] - xi));
    const sum = x.reduce((a, b) => a + b, 0);
    for (let i = 0; i < x.length; i++) x[i] /= sum;
  }

  return { x, iterations: MAX_ITER };
}

/**
 * Wrapper: given market prices (asks) and valid set Z, return Frank-Wolfe projected probabilities.
 * @param {number[]} prices - e.g. [askUp, askDown]
 * @param {number[][]} [Z] - valid set; if not provided use full simplex (all one-hots)
 * @returns {{ projected: number[], x: number[] }}
 */
export function projectWithFrankWolfe(prices, Z = null) {
  const n = prices.length;
  const corners = Z ?? Array.from({ length: n }, (_, i) => {
    const v = new Array(n).fill(0);
    v[i] = 1;
    return v;
  });
  const { x } = frankWolfeSimplex(corners);
  return { projected: x, x };
}
