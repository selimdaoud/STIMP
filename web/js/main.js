import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    buildTrueRollGrids, getTerrainHeight, getTerrainNormal, trueRollAccel,
    setTrueRollStrength, getTrueRollStrength,
    TR_GRID_SIZE, TR_WORLD_SIZE, HEIGHT_SCALE, TR_TARGET_AMP
} from './terrain.js';
import { greenSignedDistance, generateShapeSeeds, getShapeSeeds, greenBoundingRadius } from './greenShape.js';
import { createGreenMaterial } from './greenShader.js';

// ---- Constants (match Python) ----
const GREEN_COLOR = new THREE.Color(0.08, 0.55, 0.24);
const BG_COLOR = new THREE.Color(0.08, 0.09, 0.11);
const BALL_RADIUS_M = 0.0215;
const HOLE_RADIUS_M = 2.0 * BALL_RADIUS_M;
const CAMERA_HEIGHT = 5.0;
const BALL_CIRCLE_RADIUS_DEFAULT = 3.0;
const BALL_CIRCLE_MIN = 1.0;
const BALL_CIRCLE_MAX = 5.5;
const BALL_CIRCLE_STEP = 0.5;
const STIMP_V0 = 1.83;  // standard stimp meter launch speed (m/s)
const GRAVITY = 9.81;
const ROLLING_FACTOR = 5.0 / 7.0;
const BOUNCE_DAMPING = 0.3;
const BOUNCE_FRICTION = 0.8;
const MIN_BOUNCE_VEL = 0.05;
const LANDING_THRESHOLD = 0.001;
const STIMP_DEFAULT = 3.0;
const MAX_GHOST_DIST = 0.40;  // max ghost rest distance from hole for valid hole-in (meters)
const ANGLE_STEP_DEG = 0.1;
const ANGLE_MAX_DEG = 5.0;
const LAUNCH_ANGLE_DEFAULT = 5;
const LAUNCH_ANGLE_MIN = -4;
const LAUNCH_ANGLE_MAX = 15;
const LAUNCH_ANGLE_STEP = 1;
const SPIN_EFFECT_STRENGTH = 0.15;
const SPIN_DECAY_RATE = 2.0;
const ZOOM_DEFAULT = 45.0;
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 90.0;
const ZOOM_STEP = 5.0;

function stimpToMu(s) {
    const v0 = 1.83;
    return v0 * v0 / (2.0 * GRAVITY * s);
}

function getGradientAt(x, z, curAngleDeg) {
    const globalSlopeZ = GRAVITY * Math.sin(curAngleDeg * Math.PI / 180) * ROLLING_FACTOR;
    const normal = getTerrainNormal(x, z);
    let gx = -normal.x * GRAVITY * ROLLING_FACTOR;
    let gz = -normal.z * GRAVITY * ROLLING_FACTOR + globalSlopeZ;
    const tr = trueRollAccel(x, z, 0.3, 0.0);
    gx += tr.ax;
    gz += tr.az;
    return { gx, gz };
}

// ---- Scene setup ----
const scene = new THREE.Scene();
scene.background = BG_COLOR;

const camera = new THREE.PerspectiveCamera(
    ZOOM_DEFAULT, window.innerWidth / window.innerHeight, 0.01, 100
);
camera.position.set(0, CAMERA_HEIGHT, 0.01);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.prepend(renderer.domElement);

// ---- Lighting ----
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 10, 5);
scene.add(dirLight);

// ---- World group (rotates for slope visualization) ----
const worldGroup = new THREE.Group();
scene.add(worldGroup);

// ---- Orbit controls ----
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 1;
controls.maxDistance = 20;
controls.update();

// ---- Build terrain ----
buildTrueRollGrids(null);

// ---- Create green mesh (organic SDF shape + procedural grass shader) ----
let greenMaterial = null;

function buildGreenMesh() {
    const gridSize = TR_GRID_SIZE;
    const halfWorld = TR_WORLD_SIZE / 2;
    const step = TR_WORLD_SIZE / (gridSize - 1);
    const holeMargin = HOLE_RADIUS_M + 0.02;
    const sdfMargin = 0.5; // include quads near the edge; shader does pixel-precise discard

    // Build shared vertex grid with per-vertex normals for smooth shading
    const vertMap = new Int32Array(gridSize * gridSize).fill(-1);
    const positions = [];
    const normals = [];
    const indices = [];
    let vertCount = 0;

    function getOrCreateVertex(ix, iz) {
        const key = iz * gridSize + ix;
        if (vertMap[key] >= 0) return vertMap[key];
        const x = -halfWorld + ix * step;
        const z = -halfWorld + iz * step;
        const h = getTerrainHeight(x, z);
        const n = getTerrainNormal(x, z);
        positions.push(x, h, z);
        normals.push(n.x, n.y, n.z);
        vertMap[key] = vertCount;
        return vertCount++;
    }

    for (let iy = 0; iy < gridSize - 1; iy++) {
        for (let ix = 0; ix < gridSize - 1; ix++) {
            const x0 = -halfWorld + ix * step;
            const z0 = -halfWorld + iy * step;
            const x1 = x0 + step;
            const z1 = z0 + step;

            const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
            if (greenSignedDistance(cx, cz) > sdfMargin) continue;
            if (Math.hypot(cx, cz) < holeMargin) continue;

            const v00 = getOrCreateVertex(ix, iy);
            const v10 = getOrCreateVertex(ix + 1, iy);
            const v01 = getOrCreateVertex(ix, iy + 1);
            const v11 = getOrCreateVertex(ix + 1, iy + 1);

            indices.push(v00, v11, v10);
            indices.push(v00, v01, v11);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);

    const { seedA, seedB } = getShapeSeeds();
    greenMaterial = createGreenMaterial(seedA, seedB);
    return new THREE.Mesh(geometry, greenMaterial);
}

let greenMesh = buildGreenMesh();
worldGroup.add(greenMesh);

// ---- Create hole ----
function buildHole() {
    const group = new THREE.Group();
    const segments = 32;
    const holeDepth = 0.20;
    const rimWidth = 0.012;
    const rimHeight = 0.003;
    const outerRim = HOLE_RADIUS_M + rimWidth;
    const holeMargin = HOLE_RADIUS_M + 0.02;
    const collarOuter = holeMargin + 0.3;

    // Green collar
    {
        const geo = new THREE.RingGeometry(outerRim, collarOuter, segments);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, 0.001, 0);
        const mat = new THREE.MeshBasicMaterial({ color: GREEN_COLOR, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(geo, mat));
    }
    // Cylinder walls
    {
        const geo = new THREE.CylinderGeometry(HOLE_RADIUS_M, HOLE_RADIUS_M, holeDepth, segments, 1, true);
        geo.translate(0, -holeDepth / 2, 0);
        const mat = new THREE.MeshBasicMaterial({ color: 0x1e1e1e, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(geo, mat));
    }
    // Bottom
    {
        const geo = new THREE.CircleGeometry(HOLE_RADIUS_M, segments);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, -holeDepth, 0);
        const mat = new THREE.MeshBasicMaterial({ color: 0x030303 });
        group.add(new THREE.Mesh(geo, mat));
    }
    // White cup rim
    {
        const geo = new THREE.RingGeometry(HOLE_RADIUS_M, outerRim, segments);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, rimHeight, 0);
        const mat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(geo, mat));
    }
    // Inner vertical rim
    {
        const geo = new THREE.CylinderGeometry(HOLE_RADIUS_M, HOLE_RADIUS_M, rimHeight + 0.02, segments, 1, true);
        geo.translate(0, (rimHeight - 0.02) / 2, 0);
        const mat = new THREE.MeshBasicMaterial({ color: 0xe6e6e6, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(geo, mat));
    }

    return group;
}

const holeGroup = buildHole();
worldGroup.add(holeGroup);

// ---- Create ball (white with glow) ----
function buildBall() {
    const geometry = new THREE.SphereGeometry(BALL_RADIUS_M, 24, 16);
    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.3,
        roughness: 0.3,
        metalness: 0.0
    });
    const mesh = new THREE.Mesh(geometry, material);

    // Red stripes on two perpendicular hemispheres
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xcc2020 });

    const stripe1Geo = new THREE.TorusGeometry(BALL_RADIUS_M * 1.001, BALL_RADIUS_M * 0.06, 8, 32);
    const stripe1 = new THREE.Mesh(stripe1Geo, stripeMat);
    stripe1.rotation.x = Math.PI / 2;
    mesh.add(stripe1);

    const stripe2Geo = new THREE.TorusGeometry(BALL_RADIUS_M * 1.001, BALL_RADIUS_M * 0.06, 8, 32);
    const stripe2 = new THREE.Mesh(stripe2Geo, stripeMat);
    // Perpendicular to the first stripe
    stripe2.rotation.z = Math.PI / 2;
    mesh.add(stripe2);

    // Subtle glow halo around the ball
    const glowGeo = new THREE.SphereGeometry(BALL_RADIUS_M * 2.5, 16, 12);
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: THREE.BackSide
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    mesh.add(glow);

    return mesh;
}

const ballMesh = buildBall();
worldGroup.add(ballMesh);

// ---- Ball shadow ----
const shadowGeo = new THREE.CircleGeometry(BALL_RADIUS_M * 1.2, 16);
shadowGeo.rotateX(-Math.PI / 2);
const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.35,
    depthWrite: false, side: THREE.DoubleSide
});
const ballShadow = new THREE.Mesh(shadowGeo, shadowMat);
worldGroup.add(ballShadow);

// ===================================================================
// GAME STATE
// ===================================================================
let angleDeg = 0.0;
let stimpM = STIMP_DEFAULT;
let ballAngle = 0.0;
let lastCircleAngle = 0.0;
let ballCircleRadius = BALL_CIRCLE_RADIUS_DEFAULT;

let ballPos = [ballCircleRadius, getTerrainHeight(ballCircleRadius, 0) + BALL_RADIUS_M, 0];
let ballVel = [0, 0, 0];
let ballMoving = false;
let ballOnCircle = true;
let ballAirborne = false;
let inHole = false;
let travelDist = 0.0;
let launchAngleDeg = LAUNCH_ANGLE_DEFAULT;
let bounceCount = 0;
let maxHeight = 0.0;
let ballSpin = 0.0;
let breakPoints = [];
let breakLocked = false;
let prevVz = null;
let prevPosForVz = null;
let showHelp = true;
let flowMode = 0; // 0=off, 1=streamlines, 2=grid, 3=break arrows

// Aim
let aimWorld = new THREE.Vector3(ballPos[0], 0, ballPos[2]);
const mouseNDC = new THREE.Vector2(0, 0);
let aimLocked = false; // true once the player clicks to set an aimpoint

// Shot aim point storage
let shotAimPoints = [];
let validAimPts = []; // blue aim points for GoodAimZone
let lastShotStartPos = null; // ball position when last shot was fired

// Game mode state
let gameState = null; // null = free play, 'putting', 'moving', 'reveal', 'gameover'
let gameHoleIndex = 0;
let gameScore = 0;
let gameCrossedHole = false;
let gameStartPos = null; // ball position at start of hole for reveal
let gameHoleScores = []; // per-hole scores
const GAME_OOB_DIST = 6.0; // ball too far from hole = lost

const GAME_HOLES = [
    { slope: 1.0, stimp: 3.0, trueRoll: 0.0, distance: 2.0, seed: 1001 },
    { slope: 1.5, stimp: 3.0, trueRoll: 0.5, distance: 2.5, seed: 1002 },
    { slope: 2.0, stimp: 3.5, trueRoll: 0.5, distance: 3.0, seed: 1003 },
    { slope: 2.5, stimp: 3.5, trueRoll: 1.0, distance: 3.0, seed: 1004 },
    { slope: 3.0, stimp: 3.5, trueRoll: 1.0, distance: 3.5, seed: 1005 },
    { slope: 3.0, stimp: 3.5, trueRoll: 1.5, distance: 3.5, seed: 1006 },
    { slope: 3.5, stimp: 3.5, trueRoll: 1.5, distance: 4.0, seed: 1007 },
    { slope: 4.0, stimp: 3.5, trueRoll: 2.0, distance: 4.5, seed: 1008 },
    { slope: 5.0, stimp: 3.5, trueRoll: 2.0, distance: 5.0, seed: 1009 },
];

// ===================================================================
// TRAIL SYSTEM (efficient pre-allocated buffers)
// ===================================================================
const MAX_TRAIL_PTS = 5000;
const trailGroup = new THREE.Group();
worldGroup.add(trailGroup);
const trailMat = new THREE.LineBasicMaterial({ color: 0xf5f5f5, depthTest: false });

// Each segment: { line, count, data }
let trailLines = [];
let currentTrailLine = null;

function newTrailSegment() {
    const data = new Float32Array(MAX_TRAIL_PTS * 3);
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(data, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, trailMat);
    line.frustumCulled = false;
    line.renderOrder = 999;
    trailGroup.add(line);
    const seg = { line, count: 0, data };
    trailLines.push(seg);
    currentTrailLine = seg;
    return seg;
}

function addTrailPoint(x, y, z) {
    if (!currentTrailLine) newTrailSegment();
    const seg = currentTrailLine;
    if (seg.count >= MAX_TRAIL_PTS) return;
    if (seg.count > 0) {
        const i = (seg.count - 1) * 3;
        const dx = x - seg.data[i], dz = z - seg.data[i + 2];
        if (dx * dx + dz * dz < 0.0004) return; // 0.02^2
    }
    const i = seg.count * 3;
    seg.data[i] = x; seg.data[i + 1] = y; seg.data[i + 2] = z;
    seg.count++;
    seg.line.geometry.attributes.position.needsUpdate = true;
    seg.line.geometry.setDrawRange(0, seg.count);
}

function clearAllTrails() {
    for (const seg of trailLines) {
        trailGroup.remove(seg.line);
        seg.line.geometry.dispose();
    }
    trailLines = [];
    currentTrailLine = null;
}

function startNewTrailSegment() {
    currentTrailLine = null;
}

// ===================================================================
// AIM LINE & DOT
// ===================================================================
const aimLineMat = new THREE.LineBasicMaterial({ color: 0xf0d259 });
const aimLineGeo = new THREE.BufferGeometry();
const aimLinePos = new Float32Array(6);
aimLineGeo.setAttribute('position', new THREE.Float32BufferAttribute(aimLinePos, 3));
const aimLine = new THREE.Line(aimLineGeo, aimLineMat);
worldGroup.add(aimLine);

const aimDot = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS_M * 1.2, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xe61a1a, depthTest: false })
);
aimDot.renderOrder = 999;
worldGroup.add(aimDot);

// Aim distance popup (temporary label near aimDot)
const aimPopup = document.createElement('div');
aimPopup.style.cssText = `
    position: absolute; pointer-events: none; display: none;
    background: rgba(0,0,0,0.75); border: 1px solid rgba(255,255,255,0.4);
    color: #fff; padding: 4px 8px; border-radius: 4px;
    font-family: 'Courier New', monospace; font-size: 12px;
    white-space: nowrap; z-index: 30; transform: translate(-50%, -120%);
`;
document.getElementById('hud').appendChild(aimPopup);
let aimPopupTimer = null;

function showAimPopup(screenX, screenY) {
    // Perpendicular distance from hole (0,0) to aim line (ball → aimDot)
    const bx = ballPos[0], bz = ballPos[2];
    const ax = aimWorld.x, az = aimWorld.z;
    const dx = ax - bx, dz = az - bz;
    const lineLen = Math.hypot(dx, dz);
    if (lineLen < 0.001) return;

    // Signed perpendicular distance: |cross(ball→aim, ball→hole)| / |ball→aim|
    const crossVal = (ax - bx) * (0 - bz) - (az - bz) * (0 - bx);
    const perpDist = Math.abs(crossVal) / lineLen;
    const ballDiam = 2 * BALL_RADIUS_M;
    const nBalls = perpDist / ballDiam;
    const cm = perpDist * 100;

    aimPopup.textContent = `${nBalls.toFixed(1)} balls (${cm.toFixed(1)} cm)`;
    aimPopup.style.left = screenX + 'px';
    aimPopup.style.top = screenY + 'px';
    aimPopup.style.display = 'block';

    if (aimPopupTimer) clearTimeout(aimPopupTimer);
    aimPopupTimer = setTimeout(() => { aimPopup.style.display = 'none'; }, 2000);
}

// ===================================================================
// SHOT AIM POINT MARKERS
// ===================================================================
const aimPtGroup = new THREE.Group();
worldGroup.add(aimPtGroup);
const aimPtGeo = new THREE.SphereGeometry(BALL_RADIUS_M * 1.0, 8, 8);
const aimPtMatYellow = new THREE.MeshBasicMaterial({ color: 0xf0d259 });
const aimPtMatBlue = new THREE.MeshBasicMaterial({ color: 0x1a7ae6 });

function addAimPointMarker(pt) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xf0d259, depthTest: false }); // yellow — shot marker
    const mesh = new THREE.Mesh(aimPtGeo, mat);
    mesh.renderOrder = 998;
    mesh.position.set(pt.x, pt.y + 0.02, pt.z);
    aimPtGroup.add(mesh);
}

function colorLastAimPoint(madeIt) {
    if (aimPtGroup.children.length === 0) return;
    const last = aimPtGroup.children[aimPtGroup.children.length - 1];
    // Yellow stays for miss, blue for made it
    if (madeIt) {
        last.material.color.copy(aimPtMatBlue.color);
    }
    if (madeIt) {
        validAimPts.push({ x: last.position.x, z: last.position.z });
        rebuildGoodAimZone();
    }
}

function clearAimPointMarkers() {
    while (aimPtGroup.children.length) {
        aimPtGroup.remove(aimPtGroup.children[0]);
    }
    validAimPts = [];
    clearGoodAimZone();
}

// ===================================================================
// GHOST BALL REST POSITION (yellow cross where ball would stop without hole)
// ===================================================================
const ghostGroup = new THREE.Group();
worldGroup.add(ghostGroup);

function clearGhostMarker() {
    while (ghostGroup.children.length) {
        const c = ghostGroup.children[0];
        ghostGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
}

function placeGhostCross(x, z) {
    clearGhostMarker();
    const y = getTerrainHeight(x, z) + 0.005;
    const arm = BALL_RADIUS_M * 2.5;
    const w = BALL_RADIUS_M * 0.3;          // strip half-width
    const mat = new THREE.MeshBasicMaterial({ color: 0xf0e020, depthTest: false, side: THREE.DoubleSide });

    // Each arm is a thin quad (two triangles) lying flat on the green
    for (let r = 0; r < 2; r++) {
        // r=0 : diagonal from (-arm,-arm) to (+arm,+arm)
        // r=1 : diagonal from (-arm,+arm) to (+arm,-arm)
        const dx = arm, dz = (r === 0) ? arm : -arm;
        // perpendicular unit vector
        const len = Math.hypot(dx, dz);
        const px = (-dz / len) * w, pz = (dx / len) * w;

        const verts = new Float32Array([
            x - dx + px, y, z - dz + pz,
            x - dx - px, y, z - dz - pz,
            x + dx + px, y, z + dz + pz,
            x + dx + px, y, z + dz + pz,
            x - dx - px, y, z - dz - pz,
            x + dx - px, y, z + dz - pz,
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 998;
        ghostGroup.add(mesh);
    }
}

function simulateGhostRest(startPos, startVel, startSpin) {
    // Continue ball physics ignoring the hole until ball stops
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
                ax += -normal.x * GRAVITY * ROLLING_FACTOR;
                az += -normal.z * GRAVITY * ROLLING_FACTOR;
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

// ===================================================================
// HINT SYSTEM — solve & display ideal trajectory in Game mode
// ===================================================================
const hintGroup = new THREE.Group();
worldGroup.add(hintGroup);
let hintUsedThisHole = false;
const hintBtn = document.getElementById('hint-btn');

/**
 * Simulate a putt and record the path.
 * Includes lip gravity (unlike simulateGhostRest).
 * Returns { path: [[x,y,z],...], hitHole, holeSpeed }.
 */
function simulateTrajectory(startPos, vel) {
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
    const recordEvery = 4; // record every N steps

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
                ax += -normal.x * GRAVITY * ROLLING_FACTOR;
                az += -normal.z * GRAVITY * ROLLING_FACTOR;
            }
            spin *= Math.exp(-SPIN_DECAY_RATE * simDt);
            if (Math.abs(spin) < 0.01) spin = 0;
            const tr = trueRollAccel(px, pz, vx, vz);
            ax += tr.ax;
            az += tr.az;

            // Lip gravity
            const lipOuter = HOLE_RADIUS_M * 2.3;
            const dh = Math.hypot(px, pz);
            if (dh > 0.001 && dh < lipOuter) {
                const t = 1.0 - dh / lipOuter;
                const lipForce = GRAVITY * 2.5 * t * t;
                ax += -px / dh * lipForce;
                az += -pz / dh * lipForce;
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

        // Record path
        if (step % recordEvery === 0) path.push([px, py, pz]);

        // Check hole
        const distH = Math.hypot(px, pz);
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
 */
function solveHintTrajectory() {
    const bx = ballPos[0], bz = ballPos[2], by = ballPos[1];
    let bestPath = null;
    let bestSpeed = Infinity;

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
                [speedH * dx, speedH * dz]
            );
            if (result.hitHole) {
                hi = mid; // try slower
                found = true;
                foundPath = result.path;
                foundSpeed = result.holeSpeed;
            } else {
                // Ball missed — use closest approach to decide
                // If ball got close but passed, it was too fast; otherwise too slow
                if (result.minDistToHole < HOLE_RADIUS_M * 4) {
                    hi = mid; // overshot — reduce speed
                } else {
                    lo = mid; // undershot — increase speed
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

function clearHint() {
    while (hintGroup.children.length) {
        const c = hintGroup.children[0];
        hintGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
    }
}

function showHint() {
    if (hintUsedThisHole) return;
    clearHint();

    const path = solveHintTrajectory();
    if (!path || path.length < 2) return;

    // Build a CatmullRomCurve3 through the path points
    const points = path.map(p => new THREE.Vector3(p[0], p[1] + 0.002, p[2]));
    const curve = new THREE.CatmullRomCurve3(points, false);
    const tubeGeo = new THREE.TubeGeometry(curve, Math.min(points.length * 2, 200), BALL_RADIUS_M, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({
        color: 0x999999, transparent: true, opacity: 0.45,
        depthTest: false, side: THREE.DoubleSide
    });
    const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
    tubeMesh.renderOrder = 995;
    hintGroup.add(tubeMesh);

    hintUsedThisHole = true;
    hintBtn.classList.add('used');
}

// ===================================================================
// GOOD AIM ZONE (convex hull of valid aim points + bounding ellipse)
// ===================================================================
const goodAimGroup = new THREE.Group();
worldGroup.add(goodAimGroup);

// Aim info label (yellow bordered overlay)
const aimInfoLabel = document.createElement('div');
aimInfoLabel.style.cssText = `
    position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.75); border: 2px solid #f0e020; color: #f0e020;
    padding: 8px 16px; font-family: 'Courier New', monospace; font-size: 16px;
    white-space: nowrap; pointer-events: none; display: none; line-height: 1.6;
`;
document.getElementById('hud').appendChild(aimInfoLabel);

function clearGoodAimZone() {
    while (goodAimGroup.children.length) {
        const c = goodAimGroup.children[0];
        goodAimGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    aimInfoLabel.style.display = 'none';
}

function convexHull(points) {
    const pts = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
    if (pts.length <= 2) return pts.slice();
    const cross = (O, A, B) => (A.x - O.x) * (B.z - O.z) - (A.z - O.z) * (B.x - O.x);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
        upper.push(pts[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

function boundingEllipse(hull) {
    // Fast approximate bounding ellipse via PCA of hull points
    const n = hull.length;
    // Centroid
    let cx = 0, cz = 0;
    for (const p of hull) { cx += p.x; cz += p.z; }
    cx /= n; cz /= n;
    // Covariance matrix [cxx cxz; cxz czz]
    let cxx = 0, cxz = 0, czz = 0;
    for (const p of hull) {
        const dx = p.x - cx, dz = p.z - cz;
        cxx += dx * dx; cxz += dx * dz; czz += dz * dz;
    }
    cxx /= n; cxz /= n; czz /= n;
    // Eigenvalues & eigenvectors of 2x2 symmetric matrix
    const avg = (cxx + czz) / 2;
    const diff = (cxx - czz) / 2;
    const disc = Math.sqrt(diff * diff + cxz * cxz);
    const lam1 = avg + disc;
    // Principal axis (eigenvector for lam1)
    let ex, ez;
    if (Math.abs(cxz) > 1e-12) {
        ex = lam1 - czz; ez = cxz;
    } else {
        ex = cxx >= czz ? 1 : 0;
        ez = cxx >= czz ? 0 : 1;
    }
    const elen = Math.hypot(ex, ez);
    ex /= elen; ez /= elen;
    // Secondary axis (perpendicular)
    const fx = -ez, fz = ex;
    // Project hull points onto principal axes, find max extent
    let maxA = 0, maxB = 0;
    for (const p of hull) {
        const dx = p.x - cx, dz = p.z - cz;
        const a = Math.abs(dx * ex + dz * ez);
        const b = Math.abs(dx * fx + dz * fz);
        if (a > maxA) maxA = a;
        if (b > maxB) maxB = b;
    }
    // Add small padding so points sit inside the ellipse
    maxA *= 1.05;
    maxB *= 1.05;
    return { cx, cz, a: maxA, b: maxB, ex, ez, fx, fz };
}

function rebuildGoodAimZone() {
    clearGoodAimZone();
    if (validAimPts.length < 4) return;
    const hull = convexHull(validAimPts);
    if (hull.length < 3) return;

    const yOff = 0.006;

    // Filled polygon (fan triangulation)
    const fillVerts = [];
    for (let i = 1; i < hull.length - 1; i++) {
        for (const p of [hull[0], hull[i], hull[i + 1]]) {
            fillVerts.push(p.x, getTerrainHeight(p.x, p.z) + yOff, p.z);
        }
    }
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillVerts, 3));
    const fillMat = new THREE.MeshBasicMaterial({
        color: 0x4488ff, transparent: true, opacity: 0.12,
        depthTest: false, side: THREE.DoubleSide
    });
    const fillMesh = new THREE.Mesh(fillGeo, fillMat);
    fillMesh.renderOrder = 996;
    goodAimGroup.add(fillMesh);

    // Polygon outline
    const outVerts = [];
    for (let i = 0; i <= hull.length; i++) {
        const p = hull[i % hull.length];
        outVerts.push(p.x, getTerrainHeight(p.x, p.z) + yOff, p.z);
    }
    const outGeo = new THREE.BufferGeometry();
    outGeo.setAttribute('position', new THREE.Float32BufferAttribute(outVerts, 3));
    const outMat = new THREE.LineBasicMaterial({
        color: 0x4488ff, transparent: true, opacity: 0.4, depthTest: false
    });
    const outline = new THREE.Line(outGeo, outMat);
    outline.renderOrder = 996;
    goodAimGroup.add(outline);

    // Bounding ellipse (GoodAimZone)
    const ell = boundingEllipse(hull);
    if (ell.a > 0.005 && ell.b > 0.005) {
        const segments = 64;
        const eVerts = [];
        for (let i = 0; i <= segments; i++) {
            const ang = (i / segments) * Math.PI * 2;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const px = ell.cx + ca * ell.a * ell.ex + sa * ell.b * ell.fx;
            const pz = ell.cz + ca * ell.a * ell.ez + sa * ell.b * ell.fz;
            eVerts.push(px, getTerrainHeight(px, pz) + yOff + 0.001, pz);
        }
        const eGeo = new THREE.BufferGeometry();
        eGeo.setAttribute('position', new THREE.Float32BufferAttribute(eVerts, 3));
        const eMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
        const ellipseLine = new THREE.Line(eGeo, eMat);
        ellipseLine.renderOrder = 1000;
        goodAimGroup.add(ellipseLine);
    }

    // Aim info: perpendicular distance from hole to "perfect aim line"
    if (lastShotStartPos && ell.a > 0.005 && ell.b > 0.005) {
        const sx = lastShotStartPos.x, sz = lastShotStartPos.z;
        const dx = ell.cx - sx, dz = ell.cz - sz;
        const lineLen = Math.hypot(dx, dz);
        if (lineLen > 0.001) {
            // Signed perpendicular distance from hole (0,0) to the aim line
            const crossVal = sx * ell.cz - sz * ell.cx;
            const distAimHole = Math.abs(crossVal) / lineLen;
            const ballDiameter = 2 * BALL_RADIUS_M;
            const numberOfBalls = distAimHole / ballDiameter;

            // Foot of perpendicular from hole (0,0) onto the aim line
            const ux = dx / lineLen, uz = dz / lineLen;       // unit direction ball→ellipse
            const dotProj = (0 - sx) * ux + (0 - sz) * uz;    // project hole onto line
            const footX = sx + dotProj * ux;
            const footZ = sz + dotProj * uz;

            // Distance from ellipse center to perpendicular foot
            const distEllToFoot = Math.hypot(ell.cx - footX, ell.cz - footZ);

            // --- Draw aim line (ball → ellipse center, extended a bit) ---
            const extend = 0.3;
            const ax1 = sx - ux * extend, az1 = sz - uz * extend;
            const ax2 = ell.cx + ux * extend, az2 = ell.cz + uz * extend;
            const aimLineVerts = [
                ax1, getTerrainHeight(ax1, az1) + yOff + 0.002, az1,
                ax2, getTerrainHeight(ax2, az2) + yOff + 0.002, az2
            ];
            const aimLineGeo = new THREE.BufferGeometry();
            aimLineGeo.setAttribute('position', new THREE.Float32BufferAttribute(aimLineVerts, 3));
            const aimLineMat = new THREE.LineBasicMaterial({
                color: 0xf0e020, depthTest: false, transparent: true, opacity: 0.7
            });
            const aimLineMesh = new THREE.Line(aimLineGeo, aimLineMat);
            aimLineMesh.renderOrder = 998;
            goodAimGroup.add(aimLineMesh);

            // --- Draw perpendicular from hole to aim line ---
            const perpVerts = [
                0, getTerrainHeight(0, 0) + yOff + 0.002, 0,
                footX, getTerrainHeight(footX, footZ) + yOff + 0.002, footZ
            ];
            const perpGeo = new THREE.BufferGeometry();
            perpGeo.setAttribute('position', new THREE.Float32BufferAttribute(perpVerts, 3));
            const perpMat = new THREE.LineBasicMaterial({
                color: 0xff4444, depthTest: false, transparent: true, opacity: 0.7
            });
            const perpLine = new THREE.Line(perpGeo, perpMat);
            perpLine.renderOrder = 998;
            goodAimGroup.add(perpLine);

            // Left/Right: break direction based on aim point offset from hole
            // Aim left of hole → ball breaks left to right; aim right → right to left
            const lr = Math.abs(ell.cx) < 0.001 ? 'Straight' : (ell.cx < 0 ? 'Left to Right' : 'Right to Left');
            // Up/Down: compare effective elevation at ball vs hole
            const angleRad = angleDeg * Math.PI / 180;
            const heightBall = getTerrainHeight(sx, sz) - sz * Math.sin(angleRad);
            const heightHole = getTerrainHeight(0, 0);
            const heightDiff = heightHole - heightBall;
            const ud = Math.abs(heightDiff) < 0.0001 ? '' : (heightDiff > 0 ? 'Uphill' : 'Downhill');
            const puttType = ud ? `${lr}, ${ud}` : lr;

            aimInfoLabel.innerHTML =
                `${puttType} putt<br>` +
                `${numberOfBalls.toFixed(1)} balls  (${(distAimHole * 100).toFixed(1)} cm)<br>` +
                `aim offset: ${(distEllToFoot * 100).toFixed(1)} cm`;
            aimInfoLabel.style.display = 'block';
        }
    }
}

// ===================================================================
// BREAK POINT MARKERS
// ===================================================================
const breakGroup = new THREE.Group();
worldGroup.add(breakGroup);

function rebuildBreakMarkers() {
    while (breakGroup.children.length) breakGroup.remove(breakGroup.children[0]);
    const geo = new THREE.SphereGeometry(BALL_RADIUS_M * 1.5, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600 });
    for (const [pos] of breakPoints) {
        const mesh = new THREE.Mesh(geo, mat);
        const y = getTerrainHeight(pos[0], pos[1]) + 0.01;
        mesh.position.set(pos[0], y, pos[1]);
        breakGroup.add(mesh);
    }
}

// ===================================================================
// GRADIENT ARROWS (G key toggle)
// ===================================================================
const gradientGroup = new THREE.Group();
gradientGroup.visible = false;
worldGroup.add(gradientGroup);

function buildGradientArrows() {
    while (gradientGroup.children.length) {
        const c = gradientGroup.children[0];
        gradientGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }

    const halfWorld = TR_WORLD_SIZE / 2;
    const spacing = 0.4;
    const arrowScale = 0.25;
    const headRatio = 0.3;
    const yOff = 0.008;
    const positions = [];
    const colors = [];

    for (let x = -halfWorld + spacing; x < halfWorld; x += spacing) {
        for (let z = -halfWorld + spacing; z < halfWorld; z += spacing) {
            if (greenSignedDistance(x, z) > -0.3) continue; // only inside green
            if (Math.hypot(x, z) < HOLE_RADIUS_M * 3) continue;

            const { gx, gz } = getGradientAt(x, z, angleDeg);
            const mag = Math.hypot(gx, gz);
            if (mag < 0.01) continue;

            const length = Math.min(spacing * 0.4, mag * arrowScale);
            const dx = gx / mag * length;
            const dz = gz / mag * length;

            const h = getTerrainHeight(x, z);
            const hTip = getTerrainHeight(x + dx, z + dz);

            const t = Math.min(1.0, mag / 3.0);
            const r = t * 1.0 + (1 - t) * 0.2;
            const g = t * 0.85 + (1 - t) * 0.8;
            const b = t * 0.1 + (1 - t) * 0.9;

            // Shaft
            positions.push(x, h + yOff, z, x + dx, hTip + yOff, z + dz);
            colors.push(r, g, b, r, g, b);

            // Arrowhead wings
            const headLen = length * headRatio;
            const perpX = -dz / length * headLen * 0.5;
            const perpZ = dx / length * headLen * 0.5;
            const hbx = x + dx - (dx / length) * headLen;
            const hbz = z + dz - (dz / length) * headLen;
            const hHb = getTerrainHeight(hbx, hbz);

            positions.push(x + dx, hTip + yOff, z + dz, hbx + perpX, hHb + yOff, hbz + perpZ);
            colors.push(r, g, b, r, g, b);
            positions.push(x + dx, hTip + yOff, z + dz, hbx - perpX, hHb + yOff, hbz - perpZ);
            colors.push(r, g, b, r, g, b);
        }
    }

    if (positions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthTest: false });
    gradientGroup.add(new THREE.LineSegments(geo, mat));
}

let gradientLastAngle = 0;
let gradientDirty = true;

// ===================================================================
// STREAMLINES & FLOW PARTICLES (F key toggle)
// ===================================================================
const flowGroup = new THREE.Group();
flowGroup.visible = false;
worldGroup.add(flowGroup);

let flowStreamlines = [];
let flowParticles = [];
let flowLastAngle = 0;
let flowLastStimp = STIMP_DEFAULT;
let flowPointsObj = null;

function traceStreamline(startX, startZ) {
    const stepSize = 0.04;
    let x = startX, z = startZ;
    const points = [[x, z]];
    const minSpSq = 0.0009; // 0.03^2

    for (let i = 0; i < 2000; i++) {
        const g = getGradientAt(x, z, angleDeg);
        const mag = Math.hypot(g.gx, g.gz);
        if (mag < 0.003) break;
        // Step along gradient direction (pure fall-line)
        x += (g.gx / mag) * stepSize;
        z += (g.gz / mag) * stepSize;
        if (greenSignedDistance(x, z) > -0.1) break;
        if (Math.hypot(x, z) < HOLE_RADIUS_M * 1.5) { points.push([x, z]); break; }
        const last = points[points.length - 1];
        const ddx = x - last[0], ddz = z - last[1];
        if (ddx * ddx + ddz * ddz >= minSpSq) points.push([x, z]);
    }
    return points;
}

function rebuildFlowVisuals() {
    while (flowGroup.children.length) {
        const c = flowGroup.children[0];
        flowGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    flowPointsObj = null;

    // Seed from points around the green boundary — lines that start on the
    // uphill side will trace long paths; downhill seeds exit quickly and
    // get filtered out by the minimum-length check.
    const halfWorld = TR_WORLD_SIZE / 2;
    const spacing = 0.21;
    flowStreamlines = [];

    // Scan the full world grid and seed from points near the green edge
    for (let x = -halfWorld; x <= halfWorld; x += spacing) {
        for (let z = -halfWorld; z <= halfWorld; z += spacing) {
            const sd = greenSignedDistance(x, z);
            // Seed from points just inside the edge
            if (sd > -0.5 && sd < -0.05) {
                const line = traceStreamline(x, z);
                if (line.length >= 8) flowStreamlines.push(line);
            }
        }
    }

    // Init particles (staggered)
    flowParticles = [];
    for (let i = 0; i < flowStreamlines.length; i++) {
        const lineLen = flowStreamlines[i].length;
        flowParticles.push([i, ((i * 7 + 13) % 100) / 100 * (lineLen - 1)]);
    }

    const yOff = 0.008;

    // Draw streamline curves
    const lineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(0.7, 0.85, 1.0),
        transparent: true, opacity: 0.35, depthTest: false
    });
    for (const line of flowStreamlines) {
        const pts = [];
        for (const [x, z] of line) pts.push(x, getTerrainHeight(x, z) + yOff, z);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        flowGroup.add(new THREE.Line(geo, lineMat));
    }

    // Particle points (use BufferAttribute to avoid array copy)
    if (flowStreamlines.length > 0) {
        const data = new Float32Array(flowStreamlines.length * 3);
        const geo = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(data, 3);
        attr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', attr);
        const mat = new THREE.PointsMaterial({
            color: new THREE.Color(1.0, 0.95, 0.4),
            size: 3, sizeAttenuation: false, depthTest: false
        });
        flowPointsObj = new THREE.Points(geo, mat);
        flowPointsObj.frustumCulled = false;
        flowGroup.add(flowPointsObj);
    }

    flowLastAngle = angleDeg;
    flowLastStimp = stimpM;
}

function updateFlowParticles(dt) {
    if (!flowPointsObj || flowStreamlines.length === 0) return;
    const arr = flowPointsObj.geometry.attributes.position.array;
    const yOff = 0.01;

    for (let pi = 0; pi < flowParticles.length; pi++) {
        const p = flowParticles[pi];
        const line = flowStreamlines[p[0]];
        const lineLen = line.length;
        const idx = Math.floor(p[1]) % lineLen;
        const [px, pz] = line[idx];

        const g = getGradientAt(px, pz, angleDeg);
        const mag = Math.hypot(g.gx, g.gz);
        const speed = 4.0 + 8.0 * Math.min(mag, 3.0);
        p[1] += speed * dt;

        let ix, iz;
        if (p[1] >= lineLen - 1) {
            // Reached end — snap back to start (no visible reverse travel)
            p[1] = 0;
            ix = line[0][0];
            iz = line[0][1];
        } else {
            // Interpolate position along streamline
            const idx2 = Math.floor(p[1]);
            const frac = p[1] - idx2;
            const idxNext = Math.min(idx2 + 1, lineLen - 1);
            ix = line[idx2][0] + (line[idxNext][0] - line[idx2][0]) * frac;
            iz = line[idx2][1] + (line[idxNext][1] - line[idx2][1]) * frac;
        }

        arr[pi * 3] = ix;
        arr[pi * 3 + 1] = getTerrainHeight(ix, iz) + yOff;
        arr[pi * 3 + 2] = iz;
    }
    flowPointsObj.geometry.attributes.position.needsUpdate = true;
}

// ===================================================================
// GRID FLOW VISUALIZATION (Type 2 — F key cycle)
// ===================================================================
const gridFlowGroup = new THREE.Group();
gridFlowGroup.visible = false;
worldGroup.add(gridFlowGroup);

const GRID_FLOW_SPACING = 0.5;   // grid segment size in meters

let gridFlowParticles = [];  // [{spawnX, spawnZ, targetX, targetZ, t}]
let gridFlowPointsObj = null;
let gridFlowLastAngle = 0;
let gridFlowLastStimp = STIMP_DEFAULT;

// Pick the neighboring grid intersection most aligned with the gradient
function pickGridTarget(x, z, sp) {
    const g = getGradientAt(x, z, angleDeg);
    const mag = Math.hypot(g.gx, g.gz);
    if (mag < 0.01) return null; // no meaningful slope

    // 4 cardinal neighbors on the grid
    const neighbors = [
        { dx:  sp, dz:  0 },
        { dx: -sp, dz:  0 },
        { dx:  0,  dz:  sp },
        { dx:  0,  dz: -sp },
    ];

    let bestDot = -Infinity, bestN = null;
    for (const n of neighbors) {
        const nx = x + n.dx, nz = z + n.dz;
        // Stay within green boundary
        if (greenSignedDistance(nx, nz) > -0.1) continue;
        const dot = g.gx * n.dx + g.gz * n.dz;
        if (dot > bestDot) { bestDot = dot; bestN = { x: nx, z: nz }; }
    }
    // Only move if gradient has a positive component toward the neighbor
    if (bestDot <= 0) return null;
    return bestN;
}

function rebuildGridFlow() {
    while (gridFlowGroup.children.length) {
        const c = gridFlowGroup.children[0];
        gridFlowGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    gridFlowPointsObj = null;
    gridFlowParticles = [];

    const halfWorld = TR_WORLD_SIZE / 2;
    const sp = GRID_FLOW_SPACING;
    const yOff = 0.008;

    // Build grid lines geometry — only inside the organic green shape
    const positions = [];
    const gridLineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(0.5, 0.7, 0.9),
        transparent: true, opacity: 0.2, depthTest: false
    });

    // Horizontal lines (constant z, varying x)
    for (let z = -halfWorld; z <= halfWorld + 0.001; z += sp) {
        for (let x = -halfWorld; x <= halfWorld - sp + 0.001; x += sp) {
            const x2 = x + sp;
            const mx = (x + x2) / 2;
            if (greenSignedDistance(mx, z) > -0.1) continue;
            positions.push(x, getTerrainHeight(x, z) + yOff, z);
            positions.push(x2, getTerrainHeight(x2, z) + yOff, z);
        }
    }
    // Vertical lines (constant x, varying z)
    for (let x = -halfWorld; x <= halfWorld + 0.001; x += sp) {
        for (let z = -halfWorld; z <= halfWorld - sp + 0.001; z += sp) {
            const z2 = z + sp;
            const mz = (z + z2) / 2;
            if (greenSignedDistance(x, mz) > -0.1) continue;
            positions.push(x, getTerrainHeight(x, z) + yOff, z);
            positions.push(x, getTerrainHeight(x, z2) + yOff, z2);
        }
    }

    if (positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(geo, gridLineMat);
        lines.frustumCulled = false;
        gridFlowGroup.add(lines);
    }

    // One particle per grid intersection inside the green
    let particleId = 0;
    for (let z = -halfWorld; z <= halfWorld + 0.001; z += sp) {
        for (let x = -halfWorld; x <= halfWorld + 0.001; x += sp) {
            if (greenSignedDistance(x, z) > -0.1) continue;
            const target = pickGridTarget(x, z, sp);
            if (!target) continue; // skip flat intersections with no downhill neighbor
            // Stagger initial progress so particles don't all move in sync
            const stagger = ((particleId * 31 + 11) % 100) / 100;
            gridFlowParticles.push({
                spawnX: x, spawnZ: z,
                targetX: target.x, targetZ: target.z,
                t: stagger, // progress 0→1 from spawn to target
            });
            particleId++;
        }
    }

    // Create Points object for particles
    if (gridFlowParticles.length > 0) {
        const data = new Float32Array(gridFlowParticles.length * 3);
        const geo = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(data, 3);
        attr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', attr);
        const mat = new THREE.PointsMaterial({
            color: new THREE.Color(1.0, 0.95, 0.4),
            size: 2, sizeAttenuation: false, depthTest: false
        });
        gridFlowPointsObj = new THREE.Points(geo, mat);
        gridFlowPointsObj.frustumCulled = false;
        gridFlowGroup.add(gridFlowPointsObj);
    }

    gridFlowLastAngle = angleDeg;
    gridFlowLastStimp = stimpM;
}

function updateGridFlowParticles(dt) {
    if (!gridFlowPointsObj || gridFlowParticles.length === 0) return;
    const arr = gridFlowPointsObj.geometry.attributes.position.array;
    const yOff = 0.01;
    const baseSpeed = 0.1;  // minimum traversals per second
    const gradScale = 1.5;  // extra traversals/sec per unit gradient

    const sp = GRID_FLOW_SPACING;

    for (let i = 0; i < gridFlowParticles.length; i++) {
        const p = gridFlowParticles[i];

        // Speed based on gradient magnitude at spawn point
        const g = getGradientAt(p.spawnX, p.spawnZ, angleDeg);
        const mag = Math.hypot(g.gx, g.gz);
        const speed = baseSpeed + gradScale * Math.min(mag, 3.0);

        p.t += speed * dt;

        if (p.t >= 1.0) {
            // Reached target — respawn at original intersection
            p.t -= 1.0;
            // Recompute target in case gradient changed
            const newTarget = pickGridTarget(p.spawnX, p.spawnZ, sp);
            if (newTarget) {
                p.targetX = newTarget.x;
                p.targetZ = newTarget.z;
            }
        }

        // Interpolate position between spawn and target
        const t = Math.min(p.t, 1.0);
        const px = p.spawnX + (p.targetX - p.spawnX) * t;
        const pz = p.spawnZ + (p.targetZ - p.spawnZ) * t;

        arr[i * 3]     = px;
        arr[i * 3 + 1] = getTerrainHeight(px, pz) + yOff;
        arr[i * 3 + 2] = pz;
    }
    gridFlowPointsObj.geometry.attributes.position.needsUpdate = true;
}

// ===================================================================
// SLOPE INDICATOR & SCALE BAR
// ===================================================================
const slopeIndicatorGroup = new THREE.Group();
worldGroup.add(slopeIndicatorGroup);

const scaleBarGroup = new THREE.Group();
worldGroup.add(scaleBarGroup);

function rebuildSlopeIndicator() {
    while (slopeIndicatorGroup.children.length) {
        const c = slopeIndicatorGroup.children[0];
        slopeIndicatorGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    if (Math.abs(angleDeg) < 0.01) return;

    const halfEst = greenBoundingRadius() * 0.5;
    const arrowX = -halfEst * 0.85;
    const yOff = 0.01;
    const arrowLen = Math.max(0.3, Math.min(1.5, Math.abs(angleDeg) * 0.15));
    const headSize = 0.12;
    const dir = angleDeg > 0 ? 1.0 : -1.0;
    const startZ = -(arrowLen / 2) * dir;
    const endZ = (arrowLen / 2) * dir;

    const pos = [
        arrowX, yOff, startZ, arrowX, yOff, endZ,
        arrowX, yOff, endZ, arrowX - headSize * 0.5, yOff, endZ - headSize * dir,
        arrowX, yOff, endZ, arrowX + headSize * 0.5, yOff, endZ - headSize * dir
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xff9900, depthTest: false, linewidth: 2 });
    slopeIndicatorGroup.add(new THREE.LineSegments(geo, mat));
}

function rebuildScaleBar() {
    while (scaleBarGroup.children.length) {
        const c = scaleBarGroup.children[0];
        scaleBarGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    const halfEst = greenBoundingRadius() * 0.5;
    const barZ = halfEst * 0.9;
    const yOff = 0.01;
    const numMeters = 4;
    const halfBar = numMeters / 2;
    const tickH = 0.08;

    const pos = [-halfBar, yOff, barZ, halfBar, yOff, barZ];
    for (let i = 0; i <= numMeters; i++) {
        const x = -halfBar + i;
        const th = (i === 0 || i === numMeters || i === numMeters / 2) ? tickH * 1.5 : tickH;
        pos.push(x, yOff, barZ - th, x, yOff, barZ + th);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
    scaleBarGroup.add(new THREE.LineSegments(geo, mat));
}

rebuildScaleBar();

// ===================================================================
// HUD
// ===================================================================
const statsEl = document.getElementById('stats');
const helpEl = document.getElementById('help');
const messageEl = document.getElementById('message');

function updateHUD() {
    const lines = [
        `angle: ${angleDeg.toFixed(1)} deg`,
        `stimp: ${stimpM.toFixed(1)} m`,
        `true roll: ${getTrueRollStrength().toFixed(1)}`,
        `start dist: ${ballCircleRadius.toFixed(1)} m`,
        `launch angle: ${launchAngleDeg > 0 ? '+' : ''}${launchAngleDeg} deg`,
    ];

    if (ballMoving) {
        lines.push(`speed: ${Math.hypot(ballVel[0], ballVel[2]).toFixed(2)} m/s`);
    } else {
        const aimDist = Math.max(
            Math.hypot(aimWorld.x - ballPos[0], aimWorld.z - ballPos[2]), 0.1
        );
        const v0 = STIMP_V0 * Math.sqrt(aimDist / stimpM);
        lines.push(`shot speed: ${v0.toFixed(2)} m/s`);
    }

    lines.push(`distance: ${travelDist.toFixed(2)} m`);
    lines.push(`to hole: ${Math.hypot(ballPos[0], ballPos[2]).toFixed(2)} m`);
    lines.push(`height: ${ballPos[1].toFixed(3)} m`);

    if (ballMoving || maxHeight > BALL_RADIUS_M + 0.01) {
        lines.push(`max height: ${maxHeight.toFixed(3)} m`);
        lines.push(`bounces: ${bounceCount}`);
    }

    statsEl.textContent = lines.join('\n');
    helpEl.style.display = showHelp ? '' : 'none';
    if (messageEl) messageEl.style.display = inHole ? '' : 'none';
    syncSlidersFromState();
}

// ===================================================================
// INPUT
// ===================================================================
const keysHeld = {};
window.addEventListener('keydown', (e) => { keysHeld[e.key] = true; });
window.addEventListener('keyup', (e) => { keysHeld[e.key] = false; });

renderer.domElement.addEventListener('mousemove', (e) => {
    mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// Prevent arrow keys from scrolling
window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
    }

    // Discrete key events
    // During game mode: allow shoot (space), camera (B, Z/U), help (H) only
    if (e.key === ' ' && !ballMoving && !inHole) {
        if (!gameState || gameState === 'putting') shoot();
    }
    if (e.key === 'h' || e.key === 'H') showHelp = !showHelp;
    if (e.key === 'b' || e.key === 'B') resetCamera();
    if (e.key === 'z' || e.key === 'Z') {
        camera.fov = Math.max(ZOOM_MIN, camera.fov - ZOOM_STEP);
        camera.updateProjectionMatrix();
    }
    if (e.key === 'u' || e.key === 'U') {
        camera.fov = Math.min(ZOOM_MAX, camera.fov + ZOOM_STEP);
        camera.updateProjectionMatrix();
    }
    // Allowed during game mode
    if (e.key === 'f' || e.key === 'F') cycleFlowMode();
    // Blocked during game mode
    if (!gameState) {
        if (e.key === 'x' || e.key === 'X') stimpM = Math.min(6.0, stimpM + 0.1);
        if (e.key === 'y' || e.key === 'Y') stimpM = Math.max(1.0, stimpM - 0.1);
        if ((e.key === 'r' || e.key === 'R') && !e.repeat) resetBall(e.shiftKey);
        if (e.key === '1' && !ballMoving && ballOnCircle) {
            ballCircleRadius = Math.max(BALL_CIRCLE_MIN, ballCircleRadius - BALL_CIRCLE_STEP);
            updateBallOnCircle();
        }
        if (e.key === '2' && !ballMoving && ballOnCircle) {
            ballCircleRadius = Math.min(BALL_CIRCLE_MAX, ballCircleRadius + BALL_CIRCLE_STEP);
            updateBallOnCircle();
        }
        if (e.key === '3') launchAngleDeg = Math.max(LAUNCH_ANGLE_MIN, launchAngleDeg - LAUNCH_ANGLE_STEP);
        if (e.key === '4') launchAngleDeg = Math.min(LAUNCH_ANGLE_MAX, launchAngleDeg + LAUNCH_ANGLE_STEP);
    }
});

// ---- Help line highlight on input ----
const helpLines = document.querySelectorAll('#help .help-line[data-keys]');
const helpTimers = new Map();

function highlightHelp(action) {
    for (const span of helpLines) {
        const keys = span.dataset.keys.split(',');
        if (keys.includes(action)) {
            span.classList.add('highlight');
            if (helpTimers.has(span)) clearTimeout(helpTimers.get(span));
            helpTimers.set(span, setTimeout(() => {
                span.classList.remove('highlight');
                helpTimers.delete(span);
            }, 2000));
        }
    }
}

window.addEventListener('keydown', (e) => {
    const keyVal = e.shiftKey && e.key !== 'Shift' ? `shift+${e.key}` : e.key;
    highlightHelp(keyVal);
});

let _mouseDownPos = null;
let _mouseDownTime = 0;
const CLICK_MAX_MOVE = 15;
const CLICK_MAX_TIME = 300;

renderer.domElement.addEventListener('mousedown', (e) => {
    highlightHelp(e.ctrlKey || e.metaKey ? 'ctrl+drag' : 'drag');
    _mouseDownPos = { x: e.clientX, y: e.clientY };
    _mouseDownTime = performance.now();
});

renderer.domElement.addEventListener('mouseup', (e) => {
    if (!_mouseDownPos) return;
    const dist = Math.hypot(e.clientX - _mouseDownPos.x, e.clientY - _mouseDownPos.y);
    const elapsed = performance.now() - _mouseDownTime;
    _mouseDownPos = null;
    if (dist < CLICK_MAX_MOVE && elapsed < CLICK_MAX_TIME && !ballMoving && inHole) {
        resetBall(false);
        return;
    }
    if (dist < CLICK_MAX_MOVE && elapsed < CLICK_MAX_TIME && !ballMoving && !inHole) {
        // Short click — set aimpoint via raycast
        const ndc = new THREE.Vector2(
            (e.clientX / window.innerWidth) * 2 - 1,
            -(e.clientY / window.innerHeight) * 2 + 1
        );
        _raycaster.setFromCamera(ndc, camera);
        _invMatrix.copy(worldGroup.matrixWorld).invert();
        const origin = _raycaster.ray.origin.clone().applyMatrix4(_invMatrix);
        const dir = _raycaster.ray.direction.clone().transformDirection(_invMatrix);
        if (Math.abs(dir.y) > 1e-10) {
            const t = -origin.y / dir.y;
            if (t > 0) {
                const ax = origin.x + t * dir.x;
                const az = origin.z + t * dir.z;
                aimWorld.set(ax, getTerrainHeight(ax, az), az);
                aimLocked = true;
                aimDot.material.color.setHex(0xe61a1a); // red — new active aimpoint
                clearHint();
                showAimPopup(e.clientX, e.clientY);
            }
        }
    }
});

renderer.domElement.addEventListener('wheel', () => {
    highlightHelp('wheel');
});

// ===================================================================
// SHARED ACTION HELPERS
// ===================================================================
function cycleFlowMode() {
    flowMode = (flowMode + 1) % 4;
    flowGroup.visible = flowMode === 1;
    gridFlowGroup.visible = flowMode === 2;
    gradientGroup.visible = flowMode === 3;
    if (flowMode === 1 && flowStreamlines.length === 0) rebuildFlowVisuals();
    if (flowMode === 2 && gridFlowParticles.length === 0) rebuildGridFlow();
    if (flowMode === 3) { gradientDirty = false; buildGradientArrows(); }
}

function resetCamera() {
    camera.position.set(0, CAMERA_HEIGHT, 0.01);
    camera.fov = ZOOM_DEFAULT;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
}

// ===================================================================
// TOUCH UI — SLIDERS & BUTTONS
// ===================================================================

// ---- Slider panel toggle ----
const sliderPanel = document.getElementById('slider-panel');
const sliderToggle = document.getElementById('slider-toggle');
sliderToggle.addEventListener('click', () => {
    sliderPanel.classList.toggle('collapsed');
    sliderToggle.textContent = sliderPanel.classList.contains('collapsed') ? '\u00AB' : '\u00BB';
});

// ---- Slider → variable wiring ----
const slAngle  = document.getElementById('sl-angle');
const slStimp  = document.getElementById('sl-stimp');
const slTroll  = document.getElementById('sl-troll');
const slDist   = document.getElementById('sl-dist');
const slPos    = document.getElementById('sl-pos');
const slLaunch = document.getElementById('sl-launch');

const valAngle  = document.getElementById('val-angle');
const valStimp  = document.getElementById('val-stimp');
const valTroll  = document.getElementById('val-troll');
const valDist   = document.getElementById('val-dist');
const valPos    = document.getElementById('val-pos');
const valLaunch = document.getElementById('val-launch');

slAngle.addEventListener('input', () => {
    if (gameState) { syncSlidersFromState(); return; }
    angleDeg = parseFloat(slAngle.value);
    valAngle.textContent = angleDeg.toFixed(1);
});
slStimp.addEventListener('input', () => {
    if (gameState) { syncSlidersFromState(); return; }
    stimpM = parseFloat(slStimp.value);
    valStimp.textContent = stimpM.toFixed(1);
});
slTroll.addEventListener('input', () => {
    if (gameState) { syncSlidersFromState(); return; }
    setTrueRollStrength(parseFloat(slTroll.value));
    valTroll.textContent = getTrueRollStrength().toFixed(1);
});
slDist.addEventListener('input', () => {
    if (gameState) { syncSlidersFromState(); return; }
    if (ballMoving || !ballOnCircle) return;
    ballCircleRadius = parseFloat(slDist.value);
    valDist.textContent = ballCircleRadius.toFixed(1);
    updateBallOnCircle();
});
slPos.addEventListener('input', () => {
    if (gameState) { syncSlidersFromState(); return; }
    if (ballMoving || !ballOnCircle) return;
    ballAngle = parseFloat(slPos.value) * Math.PI / 180;
    lastCircleAngle = ballAngle;
    valPos.textContent = Math.round(parseFloat(slPos.value));
    updateBallOnCircle();
});
slLaunch.addEventListener('input', () => {
    if (gameState) { syncSlidersFromState(); return; }
    launchAngleDeg = parseInt(slLaunch.value, 10);
    valLaunch.textContent = launchAngleDeg;
});

// ---- Bidirectional sync: keyboard → sliders ----
function syncSlidersFromState() {
    slAngle.value  = angleDeg;
    slStimp.value  = stimpM;
    slTroll.value  = getTrueRollStrength();
    slDist.value   = ballCircleRadius;
    slPos.value    = Math.round(ballAngle * 180 / Math.PI) % 360;
    slLaunch.value = launchAngleDeg;
    valAngle.textContent  = angleDeg.toFixed(1);
    valStimp.textContent  = stimpM.toFixed(1);
    valTroll.textContent  = getTrueRollStrength().toFixed(1);
    valDist.textContent   = ballCircleRadius.toFixed(1);
    valPos.textContent    = Math.round(ballAngle * 180 / Math.PI) % 360;
    valLaunch.textContent = launchAngleDeg;
}

// ---- Action buttons ----
document.getElementById('shoot-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (!ballMoving && !inHole && (!gameState || gameState === 'putting')) shoot();
});

hintBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (gameState === 'putting' && !hintUsedThisHole) showHint();
});

const flowBtn = document.getElementById('flow-btn');
flowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    cycleFlowMode();
});

document.getElementById('action-btns').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (gameState && action !== 'startGame' && action !== 'resetCam' && action !== 'cycleFlow') return;
    switch (action) {
        case 'reset':      resetBall(false); break;
        case 'newTerrain':  resetBall(true); break;
        case 'cycleFlow':   cycleFlowMode(); break;
        case 'resetCam':    resetCamera(); break;
        case 'startGame':   startGame(); break;
    }
});

// ---- OrbitControls safety guard for slider interaction ----
let _sliderActive = false;
document.getElementById('slider-content').addEventListener('pointerdown', () => {
    _sliderActive = true;
    controls.enabled = false;
});
window.addEventListener('pointerup', () => {
    if (_sliderActive) {
        _sliderActive = false;
        controls.enabled = true;
    }
});

// ---- Light debug sliders (inside slider panel) ----
{
    const ldSection = document.getElementById('ld-section');
    if (window.SHOW_LIGHT_DEBUG) ldSection.style.display = 'block';

    const ldSliders = [
        { id: 'ld-diffuse',  valId: 'ld-v-diffuse',  uniform: 'uEnDiffuse',    decimals: 2 },
        { id: 'ld-ambient',  valId: 'ld-v-ambient',   uniform: 'uEnAmbient',    decimals: 2 },
        { id: 'ld-specular', valId: 'ld-v-specular',  uniform: 'uEnSpecular',   decimals: 2 },
        { id: 'ld-fresnel',  valId: 'ld-v-fresnel',   uniform: 'uEnFresnel',    decimals: 2 },
        { id: 'ld-slope',    valId: 'ld-v-slope',     uniform: 'uSlopeAmplify', decimals: 0 },
    ];
    for (const s of ldSliders) {
        const slider = document.getElementById(s.id);
        const valSpan = document.getElementById(s.valId);
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            valSpan.textContent = v.toFixed(s.decimals);
            greenMaterial.uniforms[s.uniform].value = v;
        });
    }
    // DirLight (Three.js scene light, not a shader uniform)
    const dlSlider = document.getElementById('ld-dirlight');
    const dlVal = document.getElementById('ld-v-dirlight');
    dlSlider.addEventListener('input', () => {
        const v = parseFloat(dlSlider.value);
        dlVal.textContent = v.toFixed(2);
        dirLight.intensity = v;
    });
}

// ---- Touch aiming (tap on canvas to set aim point) ----
let _touchStartPos = null;
let _touchStartTime = 0;
const TAP_MAX_MOVE = 15;
const TAP_MAX_TIME = 300;

renderer.domElement.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    _touchStartPos = { x: t.clientX, y: t.clientY };
    _touchStartTime = performance.now();
}, { passive: true });

renderer.domElement.addEventListener('touchend', (e) => {
    if (!_touchStartPos) return;
    if (e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dist = Math.hypot(t.clientX - _touchStartPos.x, t.clientY - _touchStartPos.y);
    const elapsed = performance.now() - _touchStartTime;
    _touchStartPos = null;
    if (dist < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME && !ballMoving && inHole) {
        resetBall(false);
        return;
    }
    if (dist < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME && !ballMoving && !inHole) {
        // Short tap — set aimpoint via raycast
        const ndc = new THREE.Vector2(
            (t.clientX / window.innerWidth) * 2 - 1,
            -(t.clientY / window.innerHeight) * 2 + 1
        );
        _raycaster.setFromCamera(ndc, camera);
        _invMatrix.copy(worldGroup.matrixWorld).invert();
        const origin = _raycaster.ray.origin.clone().applyMatrix4(_invMatrix);
        const dir = _raycaster.ray.direction.clone().transformDirection(_invMatrix);
        if (Math.abs(dir.y) > 1e-10) {
            const tt = -origin.y / dir.y;
            if (tt > 0) {
                const ax = origin.x + tt * dir.x;
                const az = origin.z + tt * dir.z;
                aimWorld.set(ax, getTerrainHeight(ax, az), az);
                aimLocked = true;
                aimDot.material.color.setHex(0xe61a1a); // red — new active aimpoint
                clearHint();
                showAimPopup(t.clientX, t.clientY);
            }
        }
    }
}, { passive: true });

// ===================================================================
// GAME MODE
// ===================================================================
const gameHudEl = document.getElementById('game-hud');
const gameHoleEl = document.getElementById('game-hole');
const scorecardEl = document.getElementById('scorecard');
const scorePopupEl = document.getElementById('score-popup');
const gameOverEl = document.getElementById('game-over');
const gameFinalScoreEl = document.getElementById('game-final-score');
const gameGradeEl = document.getElementById('game-grade');
const gameExitLiveEl = document.getElementById('game-exit-live');

function updateScorecard() {
    let html = '';
    for (let i = 0; i < 9; i++) {
        const isCurrent = i === gameHoleIndex && gameState !== 'gameover';
        const isFuture = i > gameHoleIndex || (i === gameHoleIndex && (gameState === 'putting' || gameState === 'moving' || gameState === 'setup'));
        const cls = isCurrent ? ' current' : (isFuture ? ' future' : '');
        const pts = i < gameHoleScores.length ? gameHoleScores[i] : '-';
        html += `<div class="sc-hole${cls}"><span class="sc-num">${i + 1}</span><span class="sc-pts">${pts}</span></div>`;
    }
    html += `<div class="sc-total"><span class="sc-num">TOT</span><span class="sc-pts">${gameScore}</span></div>`;
    scorecardEl.innerHTML = html;
}

function startGame() {
    gameState = 'setup';
    gameHoleIndex = 0;
    gameScore = 0;
    gameHoleScores = [];
    // Hide free-play UI (keep stats visible)
    helpEl.style.display = 'none';
    sliderPanel.classList.add('collapsed');
    sliderPanel.style.display = 'none';
    document.getElementById('action-btns').style.display = 'none';
    gameOverEl.classList.remove('show');
    // Show game HUD + exit button + hint
    gameHudEl.style.display = 'block';
    gameExitLiveEl.style.display = 'block';
    hintBtn.style.display = 'block';
    hintBtn.classList.remove('used');
    flowBtn.style.display = 'block';
    updateScorecard();
    setupHole(0);
}

function setupHole(index) {
    const hole = GAME_HOLES[index];
    // Set parameters
    angleDeg = hole.slope;
    stimpM = hole.stimp;
    setTrueRollStrength(hole.trueRoll);
    ballCircleRadius = hole.distance;
    launchAngleDeg = 0; // pure roll in game mode

    // Rebuild terrain with specific seed
    clearAllTrails();
    shotAimPoints = [];
    clearAimPointMarkers();
    generateShapeSeeds();
    buildTrueRollGrids(hole.seed);
    worldGroup.remove(greenMesh);
    greenMesh.geometry.dispose();
    greenMesh = buildGreenMesh();
    worldGroup.add(greenMesh);
    rebuildSlopeIndicator();

    // Random ball angle
    ballAngle = Math.random() * Math.PI * 2;
    lastCircleAngle = ballAngle;
    updateBallOnCircle();
    ballMoving = false;
    ballOnCircle = true;
    ballAirborne = false;
    inHole = false;

    // Save start position for later
    gameStartPos = { x: ballPos[0], z: ballPos[2] };

    // Hide all visual aids
    flowMode = 0;
    flowGroup.visible = false;
    gridFlowGroup.visible = false;
    gradientGroup.visible = false;
    goodAimGroup.visible = false;

    // Reset camera
    resetCamera();

    gameCrossedHole = false;
    gameState = 'putting';

    // Reset hint for this hole
    clearHint();
    hintUsedThisHole = false;
    hintBtn.classList.remove('used');

    // Update game HUD
    gameHoleEl.textContent = `Hole ${index + 1}/9`;
    updateScorecard();
}

function scoreShot(oob) {
    const distToHole = Math.hypot(ballPos[0], ballPos[2]);
    const ballDiam = 2 * BALL_RADIUS_M;
    let pts = 0;
    let label = '';

    if (oob) {
        pts = 0;
        label = 'Out of bounds! +0';
    } else if (inHole) {
        pts = 10;
        label = 'IN THE HOLE! +10';
    } else if (gameCrossedHole) {
        pts = 5;
        label = 'Lip out! +5';
    } else if (distToHole <= ballDiam) {
        pts = 3;
        label = 'Close! +3';
    } else if (distToHole <= ballDiam * 3) {
        pts = 1;
        label = 'Near +1';
    } else {
        pts = 0;
        label = 'Miss +0';
    }

    gameScore += pts;
    gameHoleScores.push(pts);
    updateScorecard();

    // Show score popup
    scorePopupEl.textContent = label;
    scorePopupEl.classList.remove('show');
    void scorePopupEl.offsetWidth; // force reflow to restart animation
    scorePopupEl.classList.add('show');

    gameState = 'reveal';

    // Auto-advance after 3 seconds
    setTimeout(() => {
        if (gameState !== 'reveal') return; // guard against double-fire
        scorePopupEl.classList.remove('show');
        if (gameHoleIndex < 8) {
            gameHoleIndex++;
            setupHole(gameHoleIndex);
        } else {
            endGame();
        }
    }, 3000);
}

function endGame() {
    gameState = 'gameover';
    gameHudEl.style.display = 'none';
    gameExitLiveEl.style.display = 'none';
    hintBtn.style.display = 'none';
    flowBtn.style.display = 'none';
    clearHint();

    let grade;
    if (gameScore >= 81) grade = 'GOAT';
    else if (gameScore >= 61) grade = 'Tour Pro';
    else if (gameScore >= 41) grade = 'Scratch Golfer';
    else if (gameScore >= 21) grade = 'Club Player';
    else grade = 'Amateur';

    gameFinalScoreEl.textContent = `${gameScore} / 90`;
    gameGradeEl.textContent = grade;
    gameOverEl.classList.add('show');
}

function exitGame() {
    gameState = null;
    gameOverEl.classList.remove('show');
    gameHudEl.style.display = 'none';
    gameExitLiveEl.style.display = 'none';
    hintBtn.style.display = 'none';
    flowBtn.style.display = 'none';
    clearHint();
    scorePopupEl.classList.remove('show');
    // Restore free-play UI
    statsEl.style.display = '';
    helpEl.style.display = '';
    sliderPanel.style.display = '';
    document.getElementById('action-btns').style.display = '';
    // Reset to defaults
    angleDeg = 0;
    stimpM = STIMP_DEFAULT;
    setTrueRollStrength(1.0);
    ballCircleRadius = BALL_CIRCLE_RADIUS_DEFAULT;
    launchAngleDeg = LAUNCH_ANGLE_DEFAULT;
    resetBall(true);
    resetCamera();
}

// Wire game buttons
document.getElementById('game-play-again').addEventListener('click', () => startGame());
document.getElementById('game-exit-btn').addEventListener('click', () => exitGame());
gameExitLiveEl.addEventListener('click', () => exitGame());

// ===================================================================
// ACTIONS
// ===================================================================
function shoot() {
    const dirX = aimWorld.x - ballPos[0];
    const dirZ = aimWorld.z - ballPos[2];
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return;

    // Mark aimDot yellow — previous shot aimpoint
    aimDot.material.color.setHex(0xf0d259);
    clearHint();

    lastShotStartPos = { x: ballPos[0], z: ballPos[2] };

    const speedH = STIMP_V0 * Math.sqrt(len / stimpM);
    const dxn = dirX / len, dzn = dirZ / len;
    const launchRad = launchAngleDeg * Math.PI / 180;
    const totalSpeed = speedH / Math.cos(launchRad);

    ballVel[0] = speedH * dxn;
    ballVel[1] = totalSpeed * Math.sin(launchRad);
    ballVel[2] = speedH * dzn;

    ballMoving = true;
    ballOnCircle = false;
    ballAirborne = launchAngleDeg !== 0;
    inHole = false;
    bounceCount = 0;
    maxHeight = ballPos[1];
    ballSpin = launchAngleDeg / 15.0;
    travelDist = 0.0;

    // Game mode: transition to 'moving'
    if (gameState === 'putting') {
        gameState = 'moving';
        gameCrossedHole = false;
    }

    // Ensure first trail point
    if (!currentTrailLine || currentTrailLine.count === 0) {
        addTrailPoint(ballPos[0], ballPos[1], ballPos[2]);
    }

    shotAimPoints.push(aimWorld.clone());
    addAimPointMarker(aimWorld);

    breakPoints = [];
    breakLocked = false;
    prevVz = null;
    prevPosForVz = [ballPos[0], ballPos[2]];
    rebuildBreakMarkers();
}

function resetBall(newTerrain) {
    ballAngle = lastCircleAngle;
    const bx = ballCircleRadius * Math.cos(ballAngle);
    const bz = ballCircleRadius * Math.sin(ballAngle);
    const by = getTerrainHeight(bx, bz) + BALL_RADIUS_M;
    ballPos = [bx, by, bz];
    ballVel = [0, 0, 0];
    ballMoving = false;
    ballOnCircle = true;
    ballAirborne = false;
    aimLocked = false;
    aimDot.material.color.setHex(0xe61a1a); // red — no aimpoint chosen yet
    inHole = false;
    bounceCount = 0;
    maxHeight = 0.0;
    breakPoints = [];
    breakLocked = false;
    prevVz = null;
    ballSpin = 0.0;
    travelDist = 0.0;
    ballMesh.quaternion.identity();
    clearGhostMarker();

    if (newTerrain) {
        clearAllTrails();
        shotAimPoints = [];
        clearAimPointMarkers();
        generateShapeSeeds();
        buildTrueRollGrids(null);
        worldGroup.remove(greenMesh);
        greenMesh.geometry.dispose();
        greenMesh = buildGreenMesh();
        worldGroup.add(greenMesh);
        if (flowMode === 3) buildGradientArrows();
        if (flowMode === 1) rebuildFlowVisuals();
        if (flowMode === 2) rebuildGridFlow();
        rebuildSlopeIndicator();
    } else {
        startNewTrailSegment();
    }
    rebuildBreakMarkers();
}

function updateBallOnCircle() {
    const bx = ballCircleRadius * Math.cos(ballAngle);
    const bz = ballCircleRadius * Math.sin(ballAngle);
    const by = getTerrainHeight(bx, bz) + BALL_RADIUS_M;
    ballPos = [bx, by, bz];
}

// ===================================================================
// PHYSICS
// ===================================================================
function updatePhysics(dt) {
    if (!ballMoving) return;

    const angleRad = angleDeg * Math.PI / 180;
    const muRoll = stimpToMu(stimpM);
    const holeDepth = 0.40;

    // Check if over the hole
    const distToHoleCur = Math.hypot(ballPos[0], ballPos[2]);
    const overHole = distToHoleCur <= HOLE_RADIUS_M + BALL_RADIUS_M * 0.5;

    let groundLevel;
    if (overHole) {
        const sxz = Math.hypot(ballVel[0], ballVel[2]);
        const below = ballPos[1] < BALL_RADIUS_M * 0.5;
        groundLevel = (sxz < 1.45 || below) ? -holeDepth : getTerrainHeight(ballPos[0], ballPos[2]);
    } else {
        groundLevel = getTerrainHeight(ballPos[0], ballPos[2]);
    }

    const heightAbove = ballPos[1] - BALL_RADIUS_M - groundLevel;
    ballAirborne = heightAbove > LANDING_THRESHOLD;

    let ax = 0, ay = -GRAVITY, az = 0;

    if (!ballAirborne) {
        const speed = Math.hypot(ballVel[0], ballVel[2]);

        // Global slope
        az += GRAVITY * Math.sin(angleRad) * ROLLING_FACTOR;

        if (speed > 1e-4) {
            const normal = getTerrainNormal(ballPos[0], ballPos[2]);
            let friction = muRoll * GRAVITY * Math.abs(normal.y);

            // Spin effect
            let spinMod = 1.0 + ballSpin * SPIN_EFFECT_STRENGTH;
            spinMod = Math.max(0.5, Math.min(1.5, spinMod));

            ax -= friction * spinMod * (ballVel[0] / speed);
            az -= friction * spinMod * (ballVel[2] / speed);

            // Local terrain slope
            ax += -normal.x * GRAVITY * ROLLING_FACTOR;
            az += -normal.z * GRAVITY * ROLLING_FACTOR;
        }

        // Spin decay
        ballSpin *= Math.exp(-SPIN_DECAY_RATE * dt);
        if (Math.abs(ballSpin) < 0.01) ballSpin = 0;

        // True roll
        const tr = trueRollAccel(ballPos[0], ballPos[2], ballVel[0], ballVel[2]);
        ax += tr.ax;
        az += tr.az;

        // Lip gravity — radial force toward hole center when ball is on the lip
        {
            const lipOuter = HOLE_RADIUS_M * 2.3;  // influence zone ~2.3× hole radius
            const dh = Math.hypot(ballPos[0], ballPos[2]);
            if (dh > 0.001 && dh < lipOuter) {
                // Force ramps up as ball approaches hole edge, peaks at rim
                const t = 1.0 - dh / lipOuter;  // 0 at outer edge, ~1 at center
                const lipForce = GRAVITY * 2.5 * t * t;  // quadratic ramp
                ax += -ballPos[0] / dh * lipForce;
                az += -ballPos[2] / dh * lipForce;
            }
        }

        ay = 0;
        ballVel[1] = 0;
    } else {
        // Airborne — full gravity + global slope on Z
        az += GRAVITY * Math.sin(angleRad);
    }

    // Integrate velocity
    ballVel[0] += ax * dt;
    ballVel[1] += ay * dt;
    ballVel[2] += az * dt;

    let newX = ballPos[0] + ballVel[0] * dt;
    let newY = ballPos[1] + ballVel[1] * dt;
    let newZ = ballPos[2] + ballVel[2] * dt;

    if (newY > maxHeight) maxHeight = newY;

    // Floor check
    const dhn = Math.hypot(newX, newZ);
    let minBallY;
    if (dhn <= HOLE_RADIUS_M + BALL_RADIUS_M * 0.5) {
        const sxzf = Math.hypot(ballVel[0], ballVel[2]);
        const belowf = ballPos[1] < BALL_RADIUS_M * 0.5;
        minBallY = (sxzf < 1.45 || belowf) ? -holeDepth + BALL_RADIUS_M : getTerrainHeight(newX, newZ) + BALL_RADIUS_M;
    } else {
        minBallY = getTerrainHeight(newX, newZ) + BALL_RADIUS_M;
    }

    if (newY < minBallY) {
        if (ballAirborne && Math.abs(ballVel[1]) > MIN_BOUNCE_VEL) {
            bounceCount++;
            ballVel[1] = -ballVel[1] * BOUNCE_DAMPING;
            ballVel[0] *= BOUNCE_FRICTION;
            ballVel[2] *= BOUNCE_FRICTION;
            newY = minBallY;
        } else {
            newY = minBallY;
            ballVel[1] = 0;
            ballAirborne = false;
        }
    }

    const distMoved = Math.hypot(newX - ballPos[0], newZ - ballPos[2]);
    travelDist += distMoved;

    // Ball rotation (quaternion)
    if (distMoved > 1e-6) {
        const mx = newX - ballPos[0], mz = newZ - ballPos[2];
        const axisVec = new THREE.Vector3(-mz / distMoved, 0, mx / distMoved);
        const rotAngle = -distMoved / BALL_RADIUS_M;
        const dq = new THREE.Quaternion().setFromAxisAngle(axisVec, rotAngle);
        ballMesh.quaternion.premultiply(dq);
        ballMesh.quaternion.normalize();
    }

    // Tunneling detection
    const oldX = ballPos[0], oldZ = ballPos[2];
    const segDx = newX - oldX, segDz = newZ - oldZ;
    const segLenSq = segDx * segDx + segDz * segDz;
    let closestDist;
    if (segLenSq > 1e-12) {
        const tc = Math.max(0, Math.min(1, -(oldX * segDx + oldZ * segDz) / segLenSq));
        closestDist = Math.hypot(oldX + tc * segDx, oldZ + tc * segDz);
    } else {
        closestDist = Math.hypot(newX, newZ);
    }

    // Commit new position
    ballPos[0] = newX;
    ballPos[1] = newY;
    ballPos[2] = newZ;

    // Game mode: out of bounds check (6m from hole)
    const distToHole = Math.hypot(ballPos[0], ballPos[2]);
    if (gameState === 'moving' && distToHole > GAME_OOB_DIST) {
        ballMoving = false;
        ballVel = [0, 0, 0];
        scoreShot(true);
        return;
    }

    // Hole capture check
    const holeBottom = -holeDepth + BALL_RADIUS_M;
    const speedXz = Math.hypot(ballVel[0], ballVel[2]);
    const crossedHole = closestDist <= HOLE_RADIUS_M && !ballAirborne;
    const ballDroppedIn = (distToHole <= HOLE_RADIUS_M + BALL_RADIUS_M) && ballPos[1] < BALL_RADIUS_M * 0.5;

    // Track ball crossing hole for game lip-out detection
    if (gameState === 'moving' && (crossedHole || distToHole <= HOLE_RADIUS_M)) {
        gameCrossedHole = true;
    }

    if (ballDroppedIn || distToHole <= HOLE_RADIUS_M || crossedHole) {
        if (ballDroppedIn || (!ballAirborne && speedXz < 1.45)) {
            // Captured — save state for ghost simulation before zeroing
            const ghostPos = [ballPos[0], ballPos[1], ballPos[2]];
            const ghostVel = [ballVel[0], ballVel[1], ballVel[2]];
            const ghostSpin = ballSpin;

            ballMoving = false;
            ballVel = [0, 0, 0];
            if (crossedHole && distToHole > HOLE_RADIUS_M) {
                ballPos[0] = 0; ballPos[2] = 0;
            }
            ballPos[1] = holeBottom;
            inHole = true;

            // Ghost rest position (where ball would stop without hole)
            const rest = simulateGhostRest(ghostPos, ghostVel, ghostSpin);
            placeGhostCross(rest.x, rest.z);

            // Valid only if ghost would have stopped within 40cm of hole
            const ghostDist = Math.hypot(rest.x, rest.z);
            const validHoleIn = ghostDist <= MAX_GHOST_DIST;
            if (validHoleIn) {
                aimDot.material.color.setHex(0x1a7ae6); // blue — valid hole-in
                colorLastAimPoint(true);
            } else {
                aimDot.material.color.setHex(0xf0d259); // yellow — ball went in but too fast
                colorLastAimPoint(false);
            }

            // Game mode scoring on hole-in (only if valid)
            if (gameState === 'moving') scoreShot(!validHoleIn);
        } else if (distToHole <= HOLE_RADIUS_M) {
            // Lip-out
            ballVel[0] *= 0.92;
            ballVel[2] *= 0.92;
        }
    } else if (speedXz < 0.02 && !ballAirborne) {
        ballMoving = false;
        ballVel = [0, 0, 0];
        colorLastAimPoint(false);
        // Game mode scoring on miss/near
        if (gameState === 'moving') scoreShot(false);
    } else {
        // Don't trace trail inside the hole
        const dTrail = Math.hypot(ballPos[0], ballPos[2]);
        if (dTrail > HOLE_RADIUS_M) {
            addTrailPoint(ballPos[0], ballPos[1], ballPos[2]);
        }
    }

    // Break point detection (vz sign change)
    if (ballMoving && !breakLocked && !inHole && !ballAirborne) {
        const vz = ballVel[2];
        if (prevVz !== null) {
            if ((prevVz < 0 && vz >= 0) || (prevVz > 0 && vz <= 0)) {
                const denom = prevVz - vz;
                const t = Math.abs(denom) > 1e-6 ? prevVz / denom : 0;
                const bpx = prevPosForVz[0] + (ballPos[0] - prevPosForVz[0]) * t;
                const bpz = prevPosForVz[1] + (ballPos[2] - prevPosForVz[1]) * t;
                breakPoints.push([[bpx, bpz], [-vz, ballVel[0]]]);
                breakLocked = true;
                rebuildBreakMarkers();
            } else if (Math.abs(vz) <= 0.01) {
                breakPoints.push([[ballPos[0], ballPos[2]], [-vz, ballVel[0]]]);
                breakLocked = true;
                rebuildBreakMarkers();
            }
        }
        prevVz = vz;
        prevPosForVz = [ballPos[0], ballPos[2]];
    }
}

// ===================================================================
// AIM UPDATE (raycast to ground plane in worldGroup local space)
// ===================================================================
const _raycaster = new THREE.Raycaster();
const _invMatrix = new THREE.Matrix4();

function updateAim() {
    // When aimLocked, the aimpoint is fixed — don't follow the mouse
    if (aimLocked) return;

    _raycaster.setFromCamera(mouseNDC, camera);

    // Transform ray into worldGroup local coords
    _invMatrix.copy(worldGroup.matrixWorld).invert();
    const origin = _raycaster.ray.origin.clone().applyMatrix4(_invMatrix);
    const dir = _raycaster.ray.direction.clone().transformDirection(_invMatrix);

    if (Math.abs(dir.y) > 1e-10) {
        const t = -origin.y / dir.y;
        if (t > 0) {
            const ax = origin.x + t * dir.x;
            const az = origin.z + t * dir.z;
            aimWorld.set(ax, getTerrainHeight(ax, az), az);
        }
    }
}

// ===================================================================
// RESIZE
// ===================================================================
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===================================================================
// RENDER LOOP
// ===================================================================
ballMesh.position.set(ballPos[0], ballPos[1], ballPos[2]);

let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 1 / 30); // Clamp to avoid huge steps after tab switch

    // ---- Held keys ----
    if (!gameState) {
        if (keysHeld['ArrowUp'])   angleDeg = Math.min(ANGLE_MAX_DEG, angleDeg + ANGLE_STEP_DEG);
        if (keysHeld['ArrowDown']) angleDeg = Math.max(-ANGLE_MAX_DEG, angleDeg - ANGLE_STEP_DEG);
        if (keysHeld['q'] || keysHeld['Q']) setTrueRollStrength(Math.max(0, getTrueRollStrength() - 0.1));
        if (keysHeld['w'] || keysHeld['W']) setTrueRollStrength(Math.min(4, getTrueRollStrength() + 0.1));
    }

    if (!ballMoving && ballOnCircle) {
        if (keysHeld['ArrowLeft']) {
            ballAngle += 0.035;
            lastCircleAngle = ballAngle;
            updateBallOnCircle();
            clearHint();
        }
        if (keysHeld['ArrowRight']) {
            ballAngle -= 0.035;
            lastCircleAngle = ballAngle;
            updateBallOnCircle();
            clearHint();
        }
    }

    // ---- Physics ----
    updatePhysics(dt);

    // ---- Aim ----
    updateAim();

    // ---- Overlay updates ----
    if (flowMode === 1) {
        if (Math.abs(angleDeg - flowLastAngle) > 0.3 || Math.abs(stimpM - flowLastStimp) > 0.2) {
            rebuildFlowVisuals();
        }
        updateFlowParticles(dt);
    }
    if (flowMode === 2) {
        if (Math.abs(angleDeg - gridFlowLastAngle) > 0.3 || Math.abs(stimpM - gridFlowLastStimp) > 0.2) {
            rebuildGridFlow();
        }
        updateGridFlowParticles(dt);
    }
    if (flowMode === 3 && Math.abs(angleDeg - gradientLastAngle) > 0.3) {
        buildGradientArrows();
        gradientLastAngle = angleDeg;
    }
    if (Math.abs(angleDeg - (slopeIndicatorGroup._lastAngle || 0)) > 0.05) {
        rebuildSlopeIndicator();
        slopeIndicatorGroup._lastAngle = angleDeg;
    }

    // ---- World slope rotation ----
    worldGroup.rotation.x = angleDeg * Math.PI / 180;

    // ---- Ball mesh ----
    ballMesh.position.set(ballPos[0], ballPos[1], ballPos[2]);

    // ---- Ball shadow ----
    {
        const groundY = getTerrainHeight(ballPos[0], ballPos[2]);
        ballShadow.position.set(ballPos[0], groundY + 0.002, ballPos[2]);
        const heightAbove = Math.max(0, ballPos[1] - BALL_RADIUS_M - groundY);
        const scale = 1.0 + heightAbove * 2.0;
        ballShadow.scale.setScalar(scale);
        shadowMat.opacity = Math.max(0.08, 0.35 - heightAbove * 0.5);
        ballShadow.visible = !inHole;
    }

    // ---- Aim line / dot ----
    // aimDot is red when actively aiming (new click), yellow after a shot
    aimDot.visible = true;
    aimDot.position.set(aimWorld.x, aimWorld.y + 0.02, aimWorld.z);
    if (!ballMoving) {
        aimLine.visible = true;
        const p = aimLine.geometry.attributes.position.array;
        p[0] = ballPos[0]; p[1] = ballPos[1]; p[2] = ballPos[2];
        p[3] = aimWorld.x;  p[4] = aimWorld.y + 0.005; p[5] = aimWorld.z;
        aimLine.geometry.attributes.position.needsUpdate = true;
    } else {
        aimLine.visible = false;
    }

    // ---- HUD ----
    updateHUD();

    // ---- Update green shader uniforms ----
    if (greenMaterial) {
        greenMaterial.uniforms.uViewPos.value.copy(camera.position);
        greenMaterial.uniforms.uLightPos.value.set(5, 10, 5);
    }

    // ---- Render ----
    controls.update();
    renderer.render(scene, camera);
}

animate();
console.log('Putting Simulator - Phase 3 loaded');
