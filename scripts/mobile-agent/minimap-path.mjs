import { rgbAt } from './png.mjs';

export const WALK = 0;
export const BLOCK = 1;
export const UNKNOWN = 2;
export const OUTSIDE = 3;

/**
 * Terrain class of one minimap pixel: the class of the nearest `palette` colour within
 * `maxDistance`, else UNKNOWN. `icons` colour ranges (white icons, their dark grey fill, the cyan
 * player arrow) are UNKNOWN: they cover whatever lies under them. An icon range may also cap the
 * chroma (max − min channel), which picks out neutral greys. `water` colours are BLOCK too;
 * `minimapGrid` flags their cells separately.
 */
export function terrainOf(rgb, palette) {
  const kind = classOf(rgb, palette);
  return kind === WATER ? BLOCK : kind;
}

const WATER = 4;

function classOf([r, g, b], { walk = [], block = [], water = [], icons = [], maxDistance = 45 }) {
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (
    icons.some(
      ({ min = [0, 0, 0], max = [255, 255, 255], maxChroma = 255 }) =>
        chroma <= maxChroma && [r, g, b].every((v, i) => v >= min[i] && v <= max[i]),
    )
  )
    return UNKNOWN;
  let best = UNKNOWN,
    bd = maxDistance ** 2;
  for (const [kind, list] of [
    [WALK, walk],
    [BLOCK, block],
    [WATER, water],
  ])
    for (const c of list) {
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = kind;
      }
    }
  return best;
}

/**
 * The round, north-up minimap as a `cells`×`cells` grid of terrain classes. Each cell takes the
 * majority class of the pixels sampled in it; a cell with no clear WALK or BLOCK majority is
 * UNKNOWN, cells outside the circle are OUTSIDE. `bounds` is the screen rectangle around the
 * visible circle. `water` flags the BLOCK cells whose majority is a palette water colour.
 */
export function minimapGrid(image, screen, bounds, palette, cells = 45) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const cx = (bounds.left + bounds.right) / 2,
    cy = (bounds.top + bounds.bottom) / 2,
    half = (bounds.right - bounds.left) / 2;
  const size = (2 * half) / cells;
  const grid = new Uint8Array(cells * cells);
  const water = new Uint8Array(cells * cells);
  for (let gy = 0; gy < cells; gy++)
    for (let gx = 0; gx < cells; gx++) {
      const x0 = cx - half + gx * size,
        y0 = cy - half + gy * size;
      if (Math.hypot(x0 + size / 2 - cx, y0 + size / 2 - cy) > half - size / 2) {
        grid[gy * cells + gx] = OUTSIDE;
        continue;
      }
      const votes = [0, 0, 0, 0, 0];
      const step = Math.max(1, size / 3);
      for (let y = y0; y < y0 + size; y += step)
        for (let x = x0; x < x0 + size; x += step)
          votes[classOf(rgbAt(image, Math.floor(x * sx), Math.floor(y * sy)), palette)]++;
      const total = votes[WALK] + votes[BLOCK] + votes[UNKNOWN] + votes[WATER];
      const i = gy * cells + gx;
      grid[i] =
        votes[WALK] >= total / 2
          ? WALK
          : votes[BLOCK] + votes[WATER] >= total / 2
            ? BLOCK
            : UNKNOWN;
      water[i] = grid[i] === BLOCK && votes[WATER] >= votes[BLOCK] ? 1 : 0;
    }
  return { cells, grid, water };
}

/**
 * Whether the straight line from the grid centre along compass bearing `deg` stays clear of
 * BLOCK and OUTSIDE cells (grown by `inflate`) for `length` cells. The first `clearStart` cells
 * are skipped: the player's arrow hides the ground there.
 */
export function rayClear({ cells, grid }, deg, length, { inflate = 1, clearStart = 2 } = {}) {
  const c = (cells - 1) / 2;
  const rad = (deg * Math.PI) / 180;
  for (let t = clearStart + 1; t <= length; t++) {
    const x = Math.round(c + Math.cos(rad) * t),
      y = Math.round(c - Math.sin(rad) * t);
    for (let dy = -inflate; dy <= inflate; dy++)
      for (let dx = -inflate; dx <= inflate; dx++) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) return false;
        const v = grid[ny * cells + nx];
        if (v === BLOCK || v === OUTSIDE) return false;
      }
  }
  return true;
}

/**
 * Plan a route on a minimap grid from its centre (the player) toward a goal point given as a
 * compass bearing (`deg`: 0 = right/east, 90 = up/north) and distance `r` in minimap
 * half-widths (beyond 1 = off the minimap). BLOCK cells, grown by `inflate` cells for the
 * character's width, are impassable; UNKNOWN cells cost `unknownCost`. Of the cells the player
 * can reach, the route ends at the one nearest the goal, preferring cheaper routes by
 * `costWeight` per step. With `shore` {margin, cost}, each step onto a cell within `margin`
 * cells of water costs `cost` more: shoreline routes slide the character into the sea. Returns the cell path, its end, and the bearing toward a point
 * `lookahead` cells along it (null when nothing nearer the goal is reachable).
 */
export function planRoute(
  { cells, grid, water },
  { deg, r },
  { inflate = 1, unknownCost = 3, costWeight = 0.3, lookahead = 8, clearStart = 2, shore } = {},
) {
  const c = (cells - 1) / 2;
  const goal = {
    x: c + Math.cos((deg * Math.PI) / 180) * r * (cells / 2),
    y: c - Math.sin((deg * Math.PI) / 180) * r * (cells / 2),
  };
  const at = (x, y) => grid[y * cells + x];
  // Grow obstacles; the player's own cells stay passable (the arrow hides the ground there).
  const blocked = new Uint8Array(cells * cells);
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++) {
      const v = at(x, y);
      if (v === OUTSIDE) blocked[y * cells + x] = 1;
      if (v !== BLOCK) continue;
      for (let dy = -inflate; dy <= inflate; dy++)
        for (let dx = -inflate; dx <= inflate; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < cells && ny < cells) blocked[ny * cells + nx] = 1;
        }
    }
  const start = Math.round(c) * cells + Math.round(c);
  for (let dy = -clearStart; dy <= clearStart; dy++)
    for (let dx = -clearStart; dx <= clearStart; dx++)
      blocked[start + dy * cells + dx] =
        at(Math.round(c) + dx, Math.round(c) + dy) === BLOCK ? 1 : 0;
  blocked[start] = 0;
  const shoreCost = new Float64Array(cells * cells);
  if (shore && water) {
    const m = shore.margin ?? 2;
    for (let y = 0; y < cells; y++)
      for (let x = 0; x < cells; x++) {
        if (!water[y * cells + x]) continue;
        for (let dy = -m; dy <= m; dy++)
          for (let dx = -m; dx <= m; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < cells && ny < cells)
              shoreCost[ny * cells + nx] = shore.cost ?? 3;
          }
      }
  }

  // Dijkstra over 8-connected cells (few thousand cells: a sorted frontier is fast enough).
  const cost = new Float64Array(cells * cells).fill(Infinity);
  const prev = new Int32Array(cells * cells).fill(-1);
  cost[start] = 0;
  const open = [start];
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (cost[open[i]] < cost[open[bi]]) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    const x = cur % cells,
      y = (cur - x) / cells;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) continue;
        const n = ny * cells + nx;
        if (blocked[n]) continue;
        // No corner cutting between two blocked cells.
        if (dx && dy && blocked[y * cells + nx] && blocked[ny * cells + x]) continue;
        const step =
          (dx && dy ? Math.SQRT2 : 1) * (at(nx, ny) === UNKNOWN ? unknownCost : 1) + shoreCost[n];
        if (cost[cur] + step < cost[n]) {
          if (cost[n] === Infinity) open.push(n);
          cost[n] = cost[cur] + step;
          prev[n] = cur;
        }
      }
  }

  const distGoal = (i) => Math.hypot((i % cells) - goal.x, Math.floor(i / cells) - goal.y);
  let end = start,
    best = distGoal(start);
  for (let i = 0; i < cost.length; i++) {
    if (cost[i] === Infinity) continue;
    const score = distGoal(i) + costWeight * cost[i];
    if (score < best) {
      best = score;
      end = i;
    }
  }
  const path = [];
  for (let i = end; i !== -1; i = prev[i]) path.unshift({ x: i % cells, y: Math.floor(i / cells) });
  if (end === start) return { path, goal, end: path[0], bearing: null };
  // Steer toward a point a little way along the route rather than the next cell.
  const ahead = path[Math.min(lookahead, path.length - 1)];
  const bearing = (Math.atan2(c - ahead.y, ahead.x - c) * 180) / Math.PI;
  return {
    path,
    goal,
    end: path.at(-1),
    bearing: Math.round(((bearing % 360) + 360) % 360),
    direct: Math.abs(((bearing - deg + 540) % 360) - 180) < 20,
  };
}
