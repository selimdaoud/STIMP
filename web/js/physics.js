import { getTerrainHeight, getTerrainNormal, trueRollAccel } from './terrain.js';
import { greenSignedDistance } from './greenShape.js';

// Physics constants — mirror of main.js; kept local so this module is self-contained.
const BALL_RADIUS_M       = 0.0215;
const HOLE_RADIUS_M       = 2.0 * BALL_RADIUS_M;
const STIMP_V0            = 1.83;
const GRAVITY             = 9.81;
const ROLLING_FACTOR      = 5.0 / 7.0;
const BOUNCE_DAMPING      = 0.3;
const BOUNCE_FRICTION     = 0.8;
const MIN_BOUNCE_VEL      = 0.05;
const LANDING_THRESHOLD   = 0.001;
const SPIN_EFFECT_STRENGTH = 0.15;
const SPIN_DECAY_RATE     = 2.0;

function stimpToMu(s) {
    return STIMP_V0 * STIMP_V0 / (2.0 * GRAVITY * s);
}

/**
 * Simulate ball rolling to rest, ignoring the hole (used for ghost-ball).
 * @param {number[]} startPos   [x, y, z]
 * @param {number[]} startVel   [vx, vy, vz]
 * @param {number}   startSpin  initial spin value
 * @param {object}   ctx        { angleDeg, stimpM }
 * @returns {{ x: number, z: number }}  rest position
 */
export function simulateGhostRest(startPos, startVel, startSpin, { angleDeg, stimpM }) {
    const simDt = 1 / 120;
    let px = startPos[0], py = startPos[1], pz = startPos[2];
    let vx = startVel[0], vy = startVel[1], vz = startVel[2];
    let spin = startSpin;
    let airborne = false;
    const angleRad = angleDeg * Math.PI / 180;
    const muRoll = stimpToMu(stimpM);

    for (let step = 0; step < 20000; step++) {
        const speed = Math.hypot(vx, vz);
        if (speed < 0.02 && !airborne) break;

        // Ground check (no hole)
        const terrainH = getTerrainHeight(px, pz);
        const heightAbove = py - BALL_RADIUS_M - terrainH;
        airborne = heightAbove > LANDING_THRESHOLD;

        let ax = 0, ay = -GRAVITY, az = 0;

        if (!airborne) {
            az += GRAVITY * Math.sin(angleRad) * ROLLING_FACTOR;
            if (speed > 1e-4) {
                const normal = getTerrainNormal(px, pz);
                let friction = muRoll * GRAVITY * Math.abs(normal.y);
                let spinMod = 1.0 + spin * SPIN_EFFECT_STRENGTH;
                spinMod = Math.max(0.5, Math.min(1.5, spinMod));
                ax -= friction * spinMod * (vx / speed);
                az -= friction * spinMod * (vz / speed);
                ax += normal.x * GRAVITY * ROLLING_FACTOR;
                az += normal.z * GRAVITY * ROLLING_FACTOR;
            }
            spin *= Math.exp(-SPIN_DECAY_RATE * simDt);
            if (Math.abs(spin) < 0.01) spin = 0;
            const tr = trueRollAccel(px, pz, vx, vz);
            ax += tr.ax;
            az += tr.az;
            ay = 0;
            vy = 0;
        } else {
            az += GRAVITY * Math.sin(angleRad);
        }

        vx += ax * simDt;
        vy += ay * simDt;
        vz += az * simDt;
        let nx = px + vx * simDt;
        let ny = py + vy * simDt;
        let nz = pz + vz * simDt;

        // Floor
        const minY = getTerrainHeight(nx, nz) + BALL_RADIUS_M;
        if (ny < minY) {
            if (airborne && Math.abs(vy) > MIN_BOUNCE_VEL) {
                vy = -vy * BOUNCE_DAMPING;
                vx *= BOUNCE_FRICTION;
                vz *= BOUNCE_FRICTION;
                ny = minY;
            } else {
                ny = minY;
                vy = 0;
                airborne = false;
            }
        }

        px = nx; py = ny; pz = nz;

        // Safety: stop if off green (organic SDF boundary)
        if (greenSignedDistance(px, pz) > 0) break;
    }

    return { x: px, z: pz };
}

/**
 * Simulate a putt and record the path. Includes lip gravity (unlike simulateGhostRest).
 * @param {number[]} startPos  [x, y, z]
 * @param {number[]} vel       [vx_horizontal, vz_horizontal]
 * @param {object}   ctx       { angleDeg, stimpM, holeX, holeZ }
 * @returns {{ path, hitHole, holeSpeed, minDistToHole }}
 */
export function simulateTrajectory(startPos, vel, { angleDeg, stimpM, holeX, holeZ }) {
    const simDt = 1 / 120;
    let px = startPos[0], py = startPos[1], pz = startPos[2];
    let vx = vel[0], vy = 0, vz = vel[1];
    let spin = 0;
    let airborne = false;
    const angleRad = angleDeg * Math.PI / 180;
    const muRoll = stimpToMu(stimpM);
    const path = [[px, py, pz]];
    let hitHole = false;
    let holeSpeed = Infinity;
    let minDistToHole = Infinity;
    const recordEvery = 4;

    for (let step = 0; step < 20000; step++) {
        const speed = Math.hypot(vx, vz);
        if (speed < 0.02 && !airborne) break;

        const terrainH = getTerrainHeight(px, pz);
        const heightAbove = py - BALL_RADIUS_M - terrainH;
        airborne = heightAbove > LANDING_THRESHOLD;

        let ax = 0, ay = -GRAVITY, az = 0;

        if (!airborne) {
            az += GRAVITY * Math.sin(angleRad) * ROLLING_FACTOR;
            if (speed > 1e-4) {
                const normal = getTerrainNormal(px, pz);
                let friction = muRoll * GRAVITY * Math.abs(normal.y);
                let spinMod = 1.0 + spin * SPIN_EFFECT_STRENGTH;
                spinMod = Math.max(0.5, Math.min(1.5, spinMod));
                ax -= friction * spinMod * (vx / speed);
                az -= friction * spinMod * (vz / speed);
                ax += normal.x * GRAVITY * ROLLING_FACTOR;
                az += normal.z * GRAVITY * ROLLING_FACTOR;
            }
            spin *= Math.exp(-SPIN_DECAY_RATE * simDt);
            if (Math.abs(spin) < 0.01) spin = 0;
            const tr = trueRollAccel(px, pz, vx, vz);
            ax += tr.ax;
            az += tr.az;

            // Lip gravity
            const lipOuter = HOLE_RADIUS_M * 2.3;
            const dh = Math.hypot(px - holeX, pz - holeZ);
            if (dh > 0.001 && dh < lipOuter) {
                const t = 1.0 - dh / lipOuter;
                const lipForce = GRAVITY * 2.5 * t * t;
                ax += -(px - holeX) / dh * lipForce;
                az += -(pz - holeZ) / dh * lipForce;
            }

            ay = 0;
            vy = 0;
        } else {
            az += GRAVITY * Math.sin(angleRad);
        }

        vx += ax * simDt;
        vy += ay * simDt;
        vz += az * simDt;
        let nx = px + vx * simDt;
        let ny = py + vy * simDt;
        let nz = pz + vz * simDt;

        const minY = getTerrainHeight(nx, nz) + BALL_RADIUS_M;
        if (ny < minY) {
            ny = minY; vy = 0; airborne = false;
        }
        px = nx; py = ny; pz = nz;

        if (step % recordEvery === 0) path.push([px, py, pz]);

        // Check hole
        const distH = Math.hypot(px - holeX, pz - holeZ);
        if (distH < minDistToHole) minDistToHole = distH;
        if (distH <= HOLE_RADIUS_M + BALL_RADIUS_M * 0.5) {
            hitHole = true;
            holeSpeed = speed;
            path.push([px, py, pz]);
            break;
        }

        if (greenSignedDistance(px, pz) > 0) break;
    }

    return { path, hitHole, holeSpeed, minDistToHole };
}

/**
 * Search over angles and speeds to find the trajectory that enters the hole
 * with the lowest speed (most likely to drop in).
 * @param {object} ctx  { ballPos, angleDeg, stimpM, holeX, holeZ }
 * @returns {number[][]|null}  best path array, or null if no solution found
 */
export function solveHintTrajectory({ ballPos, angleDeg, stimpM, holeX, holeZ }) {
    const [bx, by, bz] = ballPos;
    let bestPath = null;
    let bestSpeed = Infinity;
    const simCtx = { angleDeg, stimpM, holeX, holeZ };

    for (let deg = 0; deg < 360; deg += 1) {
        const rad = deg * Math.PI / 180;
        const dx = Math.cos(rad), dz = Math.sin(rad);

        // Binary search on aim distance (0.3m to 6m)
        let lo = 0.3, hi = 6.0;
        let found = false;
        let foundPath = null;
        let foundSpeed = Infinity;

        for (let iter = 0; iter < 18; iter++) {
            const mid = (lo + hi) / 2;
            const speedH = STIMP_V0 * Math.sqrt(mid / stimpM);
            const result = simulateTrajectory(
                [bx, by, bz],
                [speedH * dx, speedH * dz],
                simCtx
            );
            if (result.hitHole) {
                hi = mid;
                found = true;
                foundPath = result.path;
                foundSpeed = result.holeSpeed;
            } else {
                if (result.minDistToHole < HOLE_RADIUS_M * 4) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
        }

        if (found && foundSpeed < bestSpeed) {
            bestSpeed = foundSpeed;
            bestPath = foundPath;
        }
    }

    return bestPath;
}
