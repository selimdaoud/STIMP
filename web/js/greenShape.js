// Green organic shape — SDF (Signed Distance Field) ported from golf_green.html
// Scaled down from 60m world to 12m world (factor ~0.4)

// ---- Shape seeds (randomized per terrain) ----
let shapeSeedA = new Float32Array(4);
let shapeSeedB = new Float32Array(4);

export function generateShapeSeeds() {
    for (let i = 0; i < 4; i++) {
        shapeSeedA[i] = Math.random();
        shapeSeedB[i] = Math.random();
    }
}

export function getShapeSeeds() {
    return { seedA: shapeSeedA, seedB: shapeSeedB };
}

// Initialize with random seeds
generateShapeSeeds();

// ---- Noise (matches GLSL version exactly) ----
function random(x, y) {
    return ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123) % 1 + 1) % 1;
}

function noise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);

    const a = random(ix, iy);
    const b = random(ix + 1, iy);
    const c = random(ix, iy + 1);
    const d = random(ix + 1, iy + 1);

    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// ---- SDF primitives ----
function sdEllipse(px, pz, rx, rz) {
    const qx = px / rx, qz = pz / rz;
    return Math.sqrt(qx * qx + qz * qz) - 1.0;
}

function mix(a, b, t) { return a + (b - a) * t; }

// Scale factor: golf_green.html uses a 60m world, we use 12m
const S = 0.4;

/**
 * Signed distance to the organic green boundary.
 * Negative = inside, positive = outside.
 */
export function greenSignedDistance(x, z) {
    const sA = shapeSeedA, sB = shapeSeedB;

    // Rotation angles (no scaling needed)
    const a0 = mix(-0.18, 0.22, sA[0]);
    const a1 = mix(-0.45, -0.05, sA[1]);
    const a2 = mix(0.08, 0.55, sA[2]);

    // Lobe offsets (scaled)
    const o1x = mix(2.8, 6.2, sA[3]) * S;
    const o1z = mix(-3.2, -0.6, sB[0]) * S;
    const o2x = mix(-6.0, -2.6, sB[1]) * S;
    const o2z = mix(0.8, 3.8, sB[2]) * S;

    // Rotate points
    const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
    const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
    const cos2 = Math.cos(a2), sin2 = Math.sin(a2);

    const p0x = cos0 * x - sin0 * z;
    const p0z = sin0 * x + cos0 * z;

    const dx1 = x - o1x, dz1 = z - o1z;
    const p1x = cos1 * dx1 - sin1 * dz1;
    const p1z = sin1 * dx1 + cos1 * dz1;

    const dx2 = x - o2x, dz2 = z - o2z;
    const p2x = cos2 * dx2 - sin2 * dz2;
    const p2z = sin2 * dx2 + cos2 * dz2;

    // Ellipse radii (scaled)
    const rMainX = mix(10.5, 15.5, sB[3]) * S;
    const rMainZ = mix(8.2, 11.8, sA[0]) * S;
    const rL1X = mix(4.2, 7.0, sA[1]) * S;
    const rL1Z = mix(3.4, 5.6, sA[2]) * S;
    const rL2X = mix(4.0, 6.8, sB[0]) * S;
    const rL2Z = mix(3.0, 5.0, sB[1]) * S;

    const dMain = sdEllipse(p0x, p0z, rMainX, rMainZ);
    const dLobe1 = sdEllipse(p1x, p1z, rL1X, rL1Z);
    const dLobe2 = sdEllipse(p2x, p2z, rL2X, rL2Z);

    let d = Math.min(dMain, Math.min(dLobe1, dLobe2));

    // Irregular edge noise (frequencies scaled up, amplitude scaled down)
    const edgeF1 = mix(0.16, 0.32, sA[3]) / S;
    const edgeF2 = mix(0.36, 0.62, sB[2]) / S;
    const edgeAmp = mix(0.22, 0.62, sB[3]) * S;
    const edgeNoise = noise(x * edgeF1 + sA[0] * 3.0, z * edgeF1 + sA[1] * 3.0) * 0.6
        + noise(x * edgeF2 + sB[0] * 5.0, z * edgeF2 + sB[1] * 5.0) * 0.35;
    d += (edgeNoise - 0.45) * edgeAmp;

    return d;
}

/**
 * Returns the approximate bounding radius of the current green shape.
 */
export function greenBoundingRadius() {
    const rMainX = mix(10.5, 15.5, shapeSeedB[3]) * S;
    const rMainZ = mix(8.2, 11.8, shapeSeedA[0]) * S;
    return Math.max(rMainX, rMainZ) + 1;
}
