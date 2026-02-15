// Terrain generation and sampling — direct port from green_view_opengl.py

// Constants (match Python exactly)
export const TR_GRID_SIZE = 50;
export const TR_WORLD_SIZE = 12.0;
export const TR_BASE_AMP = 0.5;
export const TR_TARGET_AMP = 0.1;
export const TR_SMOOTH_PASSES = 8;
export const HEIGHT_SCALE = 0.01;

// Seeded PRNG (mulberry32) so terrain is reproducible when seed is given
function mulberry32(seed) {
    let s = seed | 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeRng(seed) {
    const fn = seed != null ? mulberry32(seed) : () => Math.random();
    return { uniform(lo, hi) { return lo + fn() * (hi - lo); } };
}

function makeNoiseGrid(size, amplitude, rng) {
    const grid = [];
    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            row.push(rng.uniform(-amplitude, amplitude));
        }
        grid.push(row);
    }
    return grid;
}

function smoothGrid(grid, passes) {
    const size = grid.length;
    let cur = grid;
    for (let p = 0; p < passes; p++) {
        const out = [];
        for (let y = 0; y < size; y++) {
            const row = new Array(size).fill(0);
            for (let x = 0; x < size; x++) {
                let total = 0, count = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const yy = y + dy, xx = x + dx;
                        if (yy >= 0 && yy < size && xx >= 0 && xx < size) {
                            total += cur[yy][xx];
                            count++;
                        }
                    }
                }
                row[x] = total / count;
            }
            out.push(row);
        }
        cur = out;
    }
    return cur;
}

function normalizeGrid(grid, targetAmp) {
    let maxAbs = 0;
    for (const row of grid) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
    if (maxAbs < 1e-9) return grid;
    const scale = targetAmp / maxAbs;
    return grid.map(row => row.map(v => v * scale));
}

export function bilinearSample(grid, x, z, worldSize) {
    const size = grid.length;
    const half = worldSize / 2.0;
    const u = Math.min(Math.max((x + half) / worldSize, 0), 1);
    const v = Math.min(Math.max((z + half) / worldSize, 0), 1);
    const fx = u * (size - 1), fy = v * (size - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, size - 1), y1 = Math.min(y0 + 1, size - 1);
    const tx = fx - x0, ty = fy - y0;
    const v00 = grid[y0][x0], v10 = grid[y0][x1];
    const v01 = grid[y1][x0], v11 = grid[y1][x1];
    return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

// ---- Public terrain state ----
let TRUE_ROLL_AX = null;
let TRUE_ROLL_AY = null;
let HEIGHT_GRID = null;
let TRUE_ROLL_STRENGTH = 1.0;
const TR_MIN_SPEED = 0.8;

export function setTrueRollStrength(s) { TRUE_ROLL_STRENGTH = s; }
export function getTrueRollStrength() { return TRUE_ROLL_STRENGTH; }

export function buildTrueRollGrids(seed) {
    const rng = makeRng(seed);
    TRUE_ROLL_AX = normalizeGrid(smoothGrid(makeNoiseGrid(TR_GRID_SIZE, TR_BASE_AMP, rng), TR_SMOOTH_PASSES), TR_TARGET_AMP);
    TRUE_ROLL_AY = normalizeGrid(smoothGrid(makeNoiseGrid(TR_GRID_SIZE, TR_BASE_AMP, rng), TR_SMOOTH_PASSES), TR_TARGET_AMP);
    HEIGHT_GRID = normalizeGrid(smoothGrid(makeNoiseGrid(TR_GRID_SIZE, TR_BASE_AMP, rng), TR_SMOOTH_PASSES + 2), TR_TARGET_AMP);
}

export function getTerrainHeight(x, z) {
    if (!HEIGHT_GRID) return 0;
    return bilinearSample(HEIGHT_GRID, x, z, TR_WORLD_SIZE) * HEIGHT_SCALE;
}

export function getTerrainNormal(x, z) {
    const eps = 0.05;
    const hpx = getTerrainHeight(x + eps, z);
    const hnx = getTerrainHeight(x - eps, z);
    const hpz = getTerrainHeight(x, z + eps);
    const hnz = getTerrainHeight(x, z - eps);
    const dx = (hpx - hnx) / (2 * eps);
    const dz = (hpz - hnz) / (2 * eps);
    let nx = -dx, ny = 1.0, nz = -dz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return { x: nx / len, y: ny / len, z: nz / len };
}

export function trueRollAccel(x, z, vx, vz) {
    if (TRUE_ROLL_STRENGTH <= 0 || !TRUE_ROLL_AX) return { ax: 0, az: 0 };
    const speed = Math.hypot(vx, vz);
    let scale;
    if (speed >= 1.0) scale = 0.1;
    else if (speed <= TR_MIN_SPEED) scale = 2.0;
    else scale = 2.0 - (speed - TR_MIN_SPEED) / (2.0 - TR_MIN_SPEED);
    scale *= TRUE_ROLL_STRENGTH;
    const ax = bilinearSample(TRUE_ROLL_AX, x, z, TR_WORLD_SIZE) * scale;
    const az = bilinearSample(TRUE_ROLL_AY, x, z, TR_WORLD_SIZE) * scale;
    return { ax, az };
}
