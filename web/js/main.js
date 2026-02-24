import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
// GLTFLoader no longer needed in main.js — imported inside glbLoader.js
import { Sky } from 'three/addons/objects/Sky.js';
import {
    buildTrueRollGrids, getTerrainHeight, getTerrainNormal, trueRollAccel,
    setTrueRollStrength, getTrueRollStrength,
    TR_GRID_SIZE, TR_WORLD_SIZE,
    setHeightGrid
} from './terrain.js';
import { greenSignedDistance, generateShapeSeeds, getShapeSeeds, greenBoundingRadius } from './greenShape.js';
import { createGreenMaterial } from './greenShader.js';
import { loadGLBTerrain, extractHeightGridFromGLB, applyGLBHeightVariation } from './glbLoader.js';
import { simulateGhostRest, solveHintTrajectory, simulateTrajectory } from './physics.js';

// ---- Constants (match Python) ----

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
const MAX_GHOST_DIST = 0.50;  // max ghost rest distance from hole for valid hole-in (meters)
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

// ---- Guide messages (sandbox mode) ----
const GUIDE = {
    WELCOME:    "Press 'H' for key helper",
    AIM:        'Tap the green to aim or R to reset',
    SHOOT:      'Press SPACE or SHOOT',
    ROLLING:    '',
    IN_HOLE:    'Click to reset',
    RESET:      '',
};

function stimpToMu(s) {
    const v0 = 1.83;
    return v0 * v0 / (2.0 * GRAVITY * s);
}

function getGradientAt(x, z, curAngleDeg) {
    const globalSlopeZ = GRAVITY * Math.sin(curAngleDeg * Math.PI / 180) * ROLLING_FACTOR;
    const normal = getTerrainNormal(x, z);
    let gx = normal.x * GRAVITY * ROLLING_FACTOR;
    let gz = normal.z * GRAVITY * ROLLING_FACTOR + globalSlopeZ;
    const tr = trueRollAccel(x, z, 0.3, 0.0);
    gx += tr.ax;
    gz += tr.az;
    return { gx, gz };
}

// ---- Scene setup ----
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
    ZOOM_DEFAULT, window.innerWidth / window.innerHeight, 0.01, 1200
);
camera.position.set(0, CAMERA_HEIGHT, 0.01);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

// EXR used only for environment lighting (not visual background)
new EXRLoader().load('textures/sky.exr', (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();
});

// ---- Atmospheric sky ----
{
    const sky = new Sky();
    sky.scale.setScalar(450);
    scene.add(sky);
    const u = sky.material.uniforms;
    u['turbidity'].value      = 3.0;   // slight haze
    u['rayleigh'].value       = 1.8;   // blue sky intensity
    u['mieCoefficient'].value = 0.004;
    u['mieDirectionalG'].value = 0.82;
    // Sun: ~20° elevation, azimuth matching the lateral dirLight direction
    const sunPos = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1,
        THREE.MathUtils.degToRad(90 - 20),   // polar (from zenith)
        THREE.MathUtils.degToRad(200)         // azimuth
    );
    u['sunPosition'].value.copy(sunPos);
}

// ---- Procedural cloud layer ----
{
    const cloudVS = `varying vec2 vW;
        void main(){ vW = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`;
    const cloudFS = `precision mediump float;
        varying vec2 vW;
        float rand(vec2 s){ return fract(sin(dot(s,vec2(12.9898,78.233)))*43758.5453); }
        float noise(vec2 s){
            vec2 i=floor(s),f=fract(s); f=f*f*(3.-2.*f);
            return mix(mix(rand(i),rand(i+vec2(1,0)),f.x),
                       mix(rand(i+vec2(0,1)),rand(i+vec2(1,1)),f.x),f.y);
        }
        float fbm(vec2 p){
            float v=0.,a=0.5;
            for(int i=0;i<6;i++){ v+=a*noise(p); p=p*2.1+vec2(1.7,9.2); a*=0.5; }
            return v;
        }
        void main(){
            vec2 uv = vW / 280.0;          // world → 0..1
            float c = fbm(uv * 5.0) - 0.38;
            c = smoothstep(0.0, 0.35, c);
            // thin out near horizon edges
            float edge = length(uv - 0.5) * 2.0;
            c *= 1.0 - smoothstep(0.55, 1.0, edge);
            if(c < 0.01) discard;
            // bright white centre, slightly grey at edges
            vec3 col = mix(vec3(0.82,0.84,0.86), vec3(1.0), c);
            gl_FragColor = vec4(col, c * 0.88);
        }`;
    const cloudGeo = new THREE.PlaneGeometry(560, 560);
    cloudGeo.rotateX(-Math.PI / 2);
    const cloudMesh = new THREE.Mesh(cloudGeo, new THREE.ShaderMaterial({
        vertexShader: cloudVS,
        fragmentShader: cloudFS,
        transparent: true,
        depthWrite: false,
    }));
    cloudMesh.position.y = 38;
    cloudMesh.renderOrder = -1;
    scene.add(cloudMesh);
}

// ---- Lighting ----
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(18, 10, 6);   // lateral low sun
dirLight.castShadow = true;
dirLight.shadow.mapSize.width  = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near   = 1;
dirLight.shadow.camera.far    = 120;
dirLight.shadow.camera.left   = -35;
dirLight.shadow.camera.right  =  35;
dirLight.shadow.camera.top    =  35;
dirLight.shadow.camera.bottom = -35;
dirLight.shadow.bias = -0.001;
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
controls.maxDistance = 50;
controls.update();

// ===================================================================
// ÉTAT GLOBAL — regroupé en objets pour éviter les TDZ et améliorer la lisibilité
// ===================================================================

const ball = {
    pos: [BALL_CIRCLE_RADIUS_DEFAULT, 0, 0],
    vel: [0, 0, 0],
    moving: false, onCircle: true, airborne: false, inHole: false,
    angle: 0, lastCircleAngle: 0, circleRadius: BALL_CIRCLE_RADIUS_DEFAULT,
    spin: 0, travelDist: 0, maxHeight: 0, bounceCount: 0,
    launchV0sq: null, launchMu: null, initialSpeed: null,
    speedAtHole: null, maxLateralDev: 0, lineErrorAtHole: null,
    entryAngle: null, breakApexTravelDist: 0,
    breakPoints: [], breakLocked: false,
    prevVz: null, prevPosForVz: null,
    closestHoleDist: Infinity, prevHoleDist: null, metricsShotStart: null,
};
const env = {
    angleDeg: 0.0, stimpM: STIMP_DEFAULT, launchAngleDeg: LAUNCH_ANGLE_DEFAULT,
};
const glbCtx = {
    mode: false, sceneRoot: null, meshData: [], baseHeightGrid: null,
};
const gameCtx = {
    state: null, holeIndex: 0, score: 0, scores: [],
    crossedHole: false, startPos: null,
};
const charts = {
    speedData: [], energyData: [], phaseData: [],
    speedSampleCounter: 0, phaseV0: null,
    showSpeed: false, showEnergy: false, showPhase: false,
};
const viz = {
    flowMode: 0, normalsVisible: false, showHelp: false,
};

// ---- Create green mesh (organic SDF shape + procedural grass shader) ----
let greenMaterial = null;

// Hole position in world XZ — moveable in GLB mode
let holeX = 0, holeZ = 0;
function distToHole(x, z) { return Math.hypot(x - holeX, z - holeZ); }

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
            if (distToHole(cx, cz) < holeMargin) continue;

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

let greenMesh;  // assigned in init()
let decorGroup; // assigned in init() via buildDecor()

// ---- Decorative scene (ground rough, bunkers, trees, cart path) ----
// Everything goes into a dedicated decorGroup so it can be hidden when a GLB is loaded.
function buildDecor() {
    const decorGroup = new THREE.Group();
    // Shared GLSL noise
    const noiseFn = `
        float dRand(vec2 s){ return fract(sin(dot(s,vec2(12.9898,78.233)))*43758.5453); }
        float dNoise(vec2 s){
            vec2 i=floor(s),f=fract(s); f=f*f*(3.-2.*f);
            return mix(mix(dRand(i),dRand(i+vec2(1,0)),f.x),
                       mix(dRand(i+vec2(0,1)),dRand(i+vec2(1,1)),f.x),f.y);
        }`;
    // Vertex shader that passes world XZ position
    const wposVS = `varying vec2 vW;
        void main(){ vec4 wp=modelMatrix*vec4(position,1.); vW=wp.xz; gl_Position=projectionMatrix*viewMatrix*wp; }`;

    // 1. Ground / rough grass
    const groundGeo = new THREE.PlaneGeometry(80, 80);
    groundGeo.rotateX(-Math.PI / 2);
    groundGeo.translate(0, -0.005, 0);
    decorGroup.add(new THREE.Mesh(groundGeo, new THREE.ShaderMaterial({
        vertexShader: wposVS,
        fragmentShader: `precision mediump float; varying vec2 vW; ${noiseFn}
            void main(){
                vec3 col = vec3(0.17, 0.25, 0.09);
                col += dNoise(vW*1.8)*0.05 + dNoise(vW*5.0)*0.025 + dNoise(vW*14.0)*0.012;
                float stripe = sin(vW.y*(3.14159/0.60))*0.5+0.5;
                col *= mix(0.96, 1.04, stripe);
                float d = length(vW)/38.0;
                col = mix(col, vec3(0.13,0.19,0.07), smoothstep(0.55,1.0,d));
                gl_FragColor = vec4(col, 1.);
            }`,
    })));

    // 2. Sand bunkers
    const bunkerMat = new THREE.ShaderMaterial({
        vertexShader: wposVS,
        fragmentShader: `precision mediump float; varying vec2 vW; ${noiseFn}
            void main(){
                vec3 sand = vec3(0.87, 0.81, 0.62);
                sand += dNoise(vW*9.0)*0.07 - dNoise(vW*22.0)*0.03;
                float rake = sin(vW.x*11.0 + vW.y*2.5)*0.012;
                sand.r += rake; sand.g += rake*0.8;
                gl_FragColor = vec4(sand, 1.);
            }`,
    });
    function makeBunker(cx, cz, rx, rz, angleDeg) {
        const nPts = 14;
        const ar = angleDeg * Math.PI / 180;
        const ca = Math.cos(ar), sa = Math.sin(ar);
        const pts = [];
        for (let i = 0; i < nPts; i++) {
            const t = (i / nPts) * Math.PI * 2;
            const r = 1.0 + 0.20*Math.sin(t*2.3+0.7) + 0.13*Math.sin(t*4.1+1.3) + 0.07*Math.sin(t*6.5+2.1);
            const lx = Math.cos(t)*rx*r, ly = Math.sin(t)*rz*r;
            pts.push(new THREE.Vector2(lx*ca - ly*sa, lx*sa + ly*ca));
        }
        const geo = new THREE.ShapeGeometry(new THREE.Shape(pts), 20);
        geo.rotateX(-Math.PI / 2);
        geo.translate(cx, 0.003, cz);
        return new THREE.Mesh(geo, bunkerMat);
    }
    decorGroup.add(makeBunker(-7.2,  5.8, 2.5, 1.6,  25));
    decorGroup.add(makeBunker( 6.8,  6.2, 2.2, 1.5, -10));
    decorGroup.add(makeBunker(-5.8, -6.5, 1.9, 1.3,  15));
    decorGroup.add(makeBunker( 5.5, -6.0, 1.6, 2.1, -35));

    // 3. Cart path — arc around the right side of the green
    {
        const pathShape = new THREE.Shape();
        pathShape.absarc(0, 0, 12.2, -Math.PI*0.85, Math.PI*0.15, false);
        pathShape.absarc(0, 0, 11.0,  Math.PI*0.15, -Math.PI*0.85, true);
        pathShape.closePath();
        const pgeo = new THREE.ShapeGeometry(pathShape, 48);
        pgeo.rotateX(-Math.PI / 2);
        pgeo.translate(0, 0.001, 0);
        decorGroup.add(new THREE.Mesh(pgeo, new THREE.MeshLambertMaterial({ color: 0x8c8070 })));
    }

    // 4. Trees — simple low-poly trunk + layered foliage spheres
    const trunkMat   = new THREE.MeshLambertMaterial({ color: 0x5C3D1E });
    const foliageMat = new THREE.MeshLambertMaterial({ color: 0x2A5218 });
    function makeTree(x, z, h) {
        const g = new THREE.Group();
        const tk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, h*0.35, 6), trunkMat);
        tk.position.y = h * 0.175;
        tk.castShadow = true;
        g.add(tk);
        [[0.52, 0.92], [0.68, 0.76], [0.83, 0.58], [0.96, 0.40]].forEach(([yt, r]) => {
            const foliageSphere = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 5), foliageMat);
            foliageSphere.position.y = h * yt;
            foliageSphere.castShadow = true;
            g.add(foliageSphere);
        });
        g.position.set(x, 0, z);
        return g;
    }
    [
        [-18, -14, 3.8], [-14, -19, 4.2], [  0, -21, 5.0],
        [ 16, -16, 4.5], [ 20,  -8, 3.6], [ 19,   6, 4.0],
        [ 15,  17, 4.8], [  0,  21, 4.2], [-16,  17, 3.9],
        [-20,   4, 4.4], [-19,  -7, 3.5],
    ].forEach(([x, z, h]) => decorGroup.add(makeTree(x, z, h)));

    // Shadow-receiving plane — transparent except where shadows fall
    const shadowPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(80, 80),
        new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.002;
    shadowPlane.receiveShadow = true;
    decorGroup.add(shadowPlane);

    worldGroup.add(decorGroup);
    return decorGroup;
}

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

    // Green collar — same shader as the green surface
    {
        const geo = new THREE.RingGeometry(outerRim, collarOuter, segments);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, 0.001, 0);
        group.add(new THREE.Mesh(geo, greenMaterial));
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

let holeGroup; // assigned in init()

function setHolePosition(x, z) {
    holeX = x;
    holeZ = z;
    holeGroup.position.set(holeX, getTerrainHeight(holeX, holeZ), holeZ);
    // Rebuild green mesh so the hole cutout moves with the hole
    worldGroup.remove(greenMesh);
    greenMesh.geometry.dispose();
    greenMesh = buildGreenMesh();
    worldGroup.add(greenMesh);
    if (glbCtx.mode) greenMesh.visible = false;
    resetBall(false);
    if (viz.normalsVisible) buildNormalsHelper();
}

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

let ballMesh; // assigned in init()

// ---- Ball shadow ----
const shadowGeo = new THREE.CircleGeometry(BALL_RADIUS_M * 1.2, 16);
shadowGeo.rotateX(-Math.PI / 2);
const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.35,
    depthWrite: false, side: THREE.DoubleSide
});
const ballShadow = new THREE.Mesh(shadowGeo, shadowMat);
// worldGroup.add(ballShadow) + ball.pos init moved to init()

// Aim
let aimWorld = new THREE.Vector3(ball.pos[0], 0, ball.pos[2]);
const mouseNDC = new THREE.Vector2(0, 0);
let aimLocked = false; // true once the player clicks to set an aimpoint

// Shot aim point storage
let shotAimPoints = [];
let validAimPts = []; // blue aim points for GoodAimZone
let lastShotStartPos = null; // ball position when last shot was fired

const GAME_OOB_DIST = 6.0; // ball too far from hole = lost

const GAME_HOLES = [
    { slope:  1.0, stimp: 3.0, trueRoll: 0.0, distance: 2.0, seed: 1001 },
    { slope: -1.0, stimp: 3.0, trueRoll: 0.5, distance: 2.5, seed: 1002 },
    { slope:  2.0, stimp: 3.5, trueRoll: 0.5, distance: 3.0, seed: 1003 },
    { slope: -2.0, stimp: 3.5, trueRoll: 1.0, distance: 3.0, seed: 1004 },
    { slope:  3.0, stimp: 3.5, trueRoll: 1.0, distance: 3.5, seed: 1005 },
    { slope: -3.0, stimp: 3.5, trueRoll: 1.5, distance: 3.5, seed: 1006 },
    { slope:  2.5, stimp: 3.5, trueRoll: 1.5, distance: 4.0, seed: 1007 },
    { slope: -2.5, stimp: 3.5, trueRoll: 2.0, distance: 4.5, seed: 1008 },
    { slope:  1.5, stimp: 3.5, trueRoll: 2.0, distance: 5.0, seed: 1009 },
];

// ===================================================================
// TRAIL SYSTEM (efficient pre-allocated buffers)
// ===================================================================
const MAX_TRAIL_PTS = 5000;
const trailGroup = new THREE.Group();
// worldGroup.add(trailGroup) moved to init()
const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true, depthTest: false,
    blending: THREE.AdditiveBlending, transparent: true,
});

// Each segment: { line, count, data, colorData }
let trailLines = [];
let currentTrailLine = null;

function trailSpeedColor(ratio) {
    // ratio 0→1: ice-blue → cyan → yellow → red-orange  (boosted for visibility)
    let r, g, b;
    if (ratio > 0.7) {
        const t = (ratio - 0.7) / 0.3;
        r = 1.0; g = 0.35 + 0.65 * (1 - t); b = 0.0;  // yellow → hot red
    } else if (ratio > 0.35) {
        const t = (ratio - 0.35) / 0.35;
        r = t * 1.0; g = 0.85; b = 1.0 - t * 0.9;      // cyan → yellow
    } else {
        const t = ratio / 0.35;
        r = 0.1 + 0.3 * t; g = 0.7 + 0.2 * t; b = 1.0; // ice-blue → cyan
    }
    return [r, g, b];
}

function newTrailSegment() {
    const data      = new Float32Array(MAX_TRAIL_PTS * 3);
    const colorData = new Float32Array(MAX_TRAIL_PTS * 3);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(data, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(colorData, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, trailMat);
    line.frustumCulled = false;
    line.renderOrder = 999;
    trailGroup.add(line);
    const seg = { line, count: 0, data, colorData };
    trailLines.push(seg);
    currentTrailLine = seg;
    return seg;
}

function addTrailPoint(x, y, z, speedRatio = 1.0) {
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
    const [r, g, b] = trailSpeedColor(Math.min(1, Math.max(0, speedRatio)));
    seg.colorData[i] = r; seg.colorData[i + 1] = g; seg.colorData[i + 2] = b;
    seg.count++;
    seg.line.geometry.attributes.position.needsUpdate = true;
    seg.line.geometry.attributes.color.needsUpdate = true;
    seg.line.geometry.setDrawRange(0, seg.count);
}

function clearAllTrails() {
    for (const seg of trailLines) {
        trailGroup.remove(seg.line);
        seg.line.geometry.dispose();
    }
    trailLines = [];
    currentTrailLine = null;
    clearTrailParticles();
}

function startNewTrailSegment() {
    currentTrailLine = null;
}

// ===================================================================
// TRAIL PARTICLE SYSTEM
// ===================================================================

// Radial glow sprite texture (64×64 canvas)
const _glowCanvas = document.createElement('canvas');
_glowCanvas.width = _glowCanvas.height = 64;
{
    const ctx = _glowCanvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0,    'rgba(255,255,255,1.0)');
    g.addColorStop(0.15, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.3)');
    g.addColorStop(1.0,  'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
}
const glowTex = new THREE.CanvasTexture(_glowCanvas);

const MAX_TP      = 900;
const TP_LIFETIME = 52;   // frames ≈ 0.87 s at 60 fps

const _tpPos    = new Float32Array(MAX_TP * 3);
const _tpCol    = new Float32Array(MAX_TP * 3);
const _tpBase   = new Float32Array(MAX_TP * 3);   // base colour at emission
const _tpAge    = new Float32Array(MAX_TP).fill(1); // 1 = dead

const _tpGeo = new THREE.BufferGeometry();
const _tpPosAttr = new THREE.BufferAttribute(_tpPos, 3);
_tpPosAttr.setUsage(THREE.DynamicDrawUsage);
const _tpColAttr = new THREE.BufferAttribute(_tpCol, 3);
_tpColAttr.setUsage(THREE.DynamicDrawUsage);
_tpGeo.setAttribute('position', _tpPosAttr);
_tpGeo.setAttribute('color',    _tpColAttr);
_tpGeo.setDrawRange(0, MAX_TP);

const _tpMesh = new THREE.Points(_tpGeo, new THREE.PointsMaterial({
    size: 11,
    sizeAttenuation: false,
    vertexColors: true,
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    alphaTest: 0.001,
}));
_tpMesh.frustumCulled = false;
_tpMesh.renderOrder   = 998;
worldGroup.add(_tpMesh);

let _tpHead = 0;

function emitTrailParticles(x, y, z, speedRatio) {
    for (let n = 0; n < 3; n++) {
        const i = _tpHead % MAX_TP;
        _tpHead++;
        // Slight positional jitter for volume
        _tpPos[i*3]   = x + (Math.random() - 0.5) * 0.018;
        _tpPos[i*3+1] = y + Math.random() * 0.012;
        _tpPos[i*3+2] = z + (Math.random() - 0.5) * 0.018;
        _tpAge[i] = 0;
        const [r, g, b] = trailSpeedColor(Math.min(1, Math.max(0, speedRatio)));
        _tpBase[i*3] = r; _tpBase[i*3+1] = g; _tpBase[i*3+2] = b;
        _tpCol[i*3]  = r; _tpCol[i*3+1]  = g; _tpCol[i*3+2]  = b;
    }
    _tpPosAttr.needsUpdate = true;
}

function updateTrailParticles() {
    const inv = 1.0 / TP_LIFETIME;
    for (let i = 0; i < MAX_TP; i++) {
        if (_tpAge[i] >= 1.0) {
            _tpCol[i*3] = _tpCol[i*3+1] = _tpCol[i*3+2] = 0; // black = invisible
            continue;
        }
        _tpAge[i] += inv;
        const t = Math.max(0, 1 - _tpAge[i]);
        const bright = t * t;   // quadratic fade
        _tpCol[i*3]   = _tpBase[i*3]   * bright;
        _tpCol[i*3+1] = _tpBase[i*3+1] * bright;
        _tpCol[i*3+2] = _tpBase[i*3+2] * bright;
    }
    _tpColAttr.needsUpdate = true;
}

function clearTrailParticles() {
    _tpAge.fill(1.0);
    _tpCol.fill(0);
    _tpColAttr.needsUpdate = true;
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
    const bx = ball.pos[0], bz = ball.pos[2];
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

    // Height of aim point relative to ball start, accounting for global slope tilt.
    // worldGroup is rotated by env.angleDeg around X, so the world-Y of a local point (x, h, z)
    // is  h·cos(θ) − z·sin(θ).  For the difference between two surface points:
    //   ΔY = (hAim − hBall)·cos(θ) − (az − bz)·sin(θ)
    const thetaRad = env.angleDeg * Math.PI / 180;
    const hAim  = getTerrainHeight(ax, az);
    const hBall = getTerrainHeight(bx, bz);
    const dh = ((hAim - hBall) * Math.cos(thetaRad) - (az - bz) * Math.sin(thetaRad)) * 100;
    const dhArrow = Math.abs(dh) < 0.05 ? '' : (dh > 0 ? '↑' : '↓');
    const dhStr = dhArrow + (dh >= 0 ? '+' : '') + dh.toFixed(1) + ' cm';

    const dhColor = Math.abs(dh) < 0.05 ? '#7ef0a0' : (dh > 0 ? '#7ef0a0' : '#f07e7e');
    aimPopup.innerHTML = `${nBalls.toFixed(1)} balls (${cm.toFixed(1)} cm)<br><span style="color:${dhColor}">${dhStr} &nbsp;|&nbsp; ${lineLen.toFixed(2)} m</span>`;
    aimPopup.style.left = screenX + 'px';
    aimPopup.style.top = screenY + 'px';
    aimPopup.style.display = 'block';

    if (aimPopupTimer) clearTimeout(aimPopupTimer);
    aimPopupTimer = setTimeout(() => { aimPopup.style.display = 'none'; }, 2000);
}

// Shot info popup (shown at ball position on shoot, dismissed on next pointer/touch)
const shotPopup = document.createElement('div');
shotPopup.style.cssText = `
    position: absolute; pointer-events: none; display: none;
    background: rgba(0,0,0,0.80); border: 1px solid rgba(255,255,255,0.3);
    color: #fff; padding: 6px 12px; border-radius: 4px;
    font-family: 'Courier New', monospace; font-size: 12px;
    white-space: nowrap; z-index: 30; transform: translate(-50%, calc(-100% - 14px));
    line-height: 1.7;
`;
document.getElementById('hud').appendChild(shotPopup);

function showShotPopup(totalSpeed, maxHeightCm, flightLenCm, angle, spin) {
    const v = new THREE.Vector3(ball.pos[0], ball.pos[1], ball.pos[2]);
    worldGroup.updateMatrixWorld();
    v.applyMatrix4(worldGroup.matrixWorld);
    v.project(camera);
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;

    const angleStr = (angle >= 0 ? '+' : '') + angle + '°';
    const spinStr  = spin !== 0 ? spin.toFixed(2) : '0';
    const muRoll   = stimpToMu(env.stimpM);
    const terrH    = getTerrainHeight(ball.pos[0], ball.pos[2]);
    const terrN    = getTerrainNormal(ball.pos[0], ball.pos[2]);
    const slopeStr = `${terrN.x >= 0 ? '+' : ''}${terrN.x.toFixed(3)}, ${terrN.z >= 0 ? '+' : ''}${terrN.z.toFixed(3)}`;
    shotPopup.innerHTML =
        `speed: <span style="color:#ffe033">${totalSpeed.toFixed(2)} m/s</span><br>` +
        `height: <span style="color:#ffe033">${maxHeightCm.toFixed(1)} cm</span><br>` +
        `flight: <span style="color:#ffe033">${flightLenCm.toFixed(1)} cm</span><br>` +
        `angle: <span style="color:#ffe033">${angleStr}</span><br>` +
        `spin: <span style="color:#ffe033">${spinStr}</span><br>` +
        `µ: <span style="color:#88ff88">${muRoll.toFixed(4)}</span>  ` +
        `h: <span style="color:#88ff88">${(terrH * 1000).toFixed(1)} mm</span><br>` +
        `slope nx,nz: <span style="color:#88ff88">${slopeStr}</span>`;
    shotPopup.style.left = sx + 'px';
    shotPopup.style.top  = sy + 'px';
    shotPopup.style.display = 'block';
}

document.addEventListener('pointerdown', () => { shotPopup.style.display = 'none'; });
document.addEventListener('touchstart',  () => { shotPopup.style.display = 'none'; }, { passive: true });

// ===================================================================
// FLIGHT POPUP — side-view of ball launch trajectory (bottom-right)
// ===================================================================
// SHOT AIM POINT MARKERS
// ===================================================================
const aimPtGroup = new THREE.Group();
worldGroup.add(aimPtGroup);
const aimPtGeo = new THREE.SphereGeometry(BALL_RADIUS_M * 1.0, 8, 8);

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

// simulateGhostRest → moved to physics.js

// ===================================================================
// HINT SYSTEM — solve & display ideal trajectory in Game mode
// ===================================================================
const hintGroup = new THREE.Group();
worldGroup.add(hintGroup);
let hintUsedThisHole = false;
const hintBtn = document.getElementById('hint-btn');

// simulateTrajectory, solveHintTrajectory → moved to physics.js

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

    const path = solveHintTrajectory({ ballPos: ball.pos, angleDeg: env.angleDeg, stimpM: env.stimpM, holeX, holeZ });
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
            const aimLineGeoLocal = new THREE.BufferGeometry();
            aimLineGeoLocal.setAttribute('position', new THREE.Float32BufferAttribute(aimLineVerts, 3));
            const aimLineMatLocal = new THREE.LineBasicMaterial({
                color: 0xf0e020, depthTest: false, transparent: true, opacity: 0.7
            });
            const aimLineMesh = new THREE.Line(aimLineGeoLocal, aimLineMatLocal);
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
            const angleRad = env.angleDeg * Math.PI / 180;
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
    for (const [pos] of ball.breakPoints) {
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

const contourGroup = new THREE.Group();
contourGroup.visible = false;
worldGroup.add(contourGroup);

function buildContourVis() {
    while (contourGroup.children.length) {
        const c = contourGroup.children[0];
        contourGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }

    const halfWorld = TR_WORLD_SIZE / 2;
    const sp = 0.08; // grid spacing for heatmap + contours
    const yOff = 0.005;
    const nx = Math.ceil(TR_WORLD_SIZE / sp) + 1;
    const nz = nx;

    // --- Pass 1: sample height and gradient magnitude on grid ---
    const heights = new Float32Array(nx * nz);
    const gradMag = new Float32Array(nx * nz);
    let hMin = Infinity, hMax = -Infinity;
    let gMax = 0;

    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            const x = -halfWorld + ix * sp;
            const z = -halfWorld + iz * sp;
            const idx = iz * nx + ix;
            const h = getTerrainHeight(x, z);
            heights[idx] = h;
            if (greenSignedDistance(x, z) < -0.1) {
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
            const g = getGradientAt(x, z, env.angleDeg);
            const m = Math.hypot(g.gx, g.gz);
            gradMag[idx] = m;
            if (m > gMax && greenSignedDistance(x, z) < -0.1) gMax = m;
        }
    }

    // --- Pass 2: heatmap mesh (vertex-colored quads) ---
    const heatPos = [];
    const heatCol = [];
    const heatIdx = [];
    let heatVert = 0;

    for (let iz = 0; iz < nz - 1; iz++) {
        for (let ix = 0; ix < nx - 1; ix++) {
            const x0 = -halfWorld + ix * sp;
            const z0 = -halfWorld + iz * sp;
            const cx = x0 + sp * 0.5, cz = z0 + sp * 0.5;
            if (greenSignedDistance(cx, cz) > -0.1) continue;
            if (distToHole(cx, cz) < HOLE_RADIUS_M + 0.02) continue;

            // 4 corners: (ix,iz), (ix+1,iz), (ix,iz+1), (ix+1,iz+1)
            const corners = [
                [ix, iz], [ix + 1, iz], [ix, iz + 1], [ix + 1, iz + 1]
            ];
            const base = heatVert;
            for (const [ci, cj] of corners) {
                const px = -halfWorld + ci * sp;
                const pz = -halfWorld + cj * sp;
                const idx = cj * nx + ci;
                heatPos.push(px, heights[idx] + yOff, pz);
                // Color: blue (low gradient) → red (high gradient)
                const t = gMax > 0.001 ? Math.min(gradMag[idx] / gMax, 1.0) : 0;
                heatCol.push(
                    0.2 + t * 0.7,      // R: 0.2 → 0.9
                    0.3 - t * 0.1,      // G: 0.3 → 0.2
                    0.9 - t * 0.8       // B: 0.9 → 0.1
                );
                heatVert++;
            }
            heatIdx.push(base, base + 1, base + 3);
            heatIdx.push(base, base + 3, base + 2);
        }
    }

    if (heatPos.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(heatPos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(heatCol, 3));
        geo.setIndex(heatIdx);
        const mat = new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.35,
            depthTest: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 993;
        contourGroup.add(mesh);
    }

    // --- Pass 3: iso contour lines via marching squares ---
    const hRange = hMax - hMin;
    if (hRange < 1e-6) return;
    const nLevels = 12;
    const contourPos = [];

    for (let li = 1; li < nLevels; li++) {
        const level = hMin + (hRange * li) / nLevels;

        for (let iz = 0; iz < nz - 1; iz++) {
            for (let ix = 0; ix < nx - 1; ix++) {
                const cx = -halfWorld + (ix + 0.5) * sp;
                const cz = -halfWorld + (iz + 0.5) * sp;
                if (greenSignedDistance(cx, cz) > -0.1) continue;

                // 4 corner values (clockwise: TL, TR, BR, BL)
                const i00 = iz * nx + ix;        // top-left
                const i10 = iz * nx + ix + 1;    // top-right
                const i11 = (iz + 1) * nx + ix + 1; // bottom-right
                const i01 = (iz + 1) * nx + ix;  // bottom-left
                const v0 = heights[i00], v1 = heights[i10];
                const v2 = heights[i11], v3 = heights[i01];

                // Classify corners (1 = above level)
                const c0 = v0 >= level ? 1 : 0;
                const c1 = v1 >= level ? 1 : 0;
                const c2 = v2 >= level ? 1 : 0;
                const c3 = v3 >= level ? 1 : 0;
                const caseIdx = c0 | (c1 << 1) | (c2 << 2) | (c3 << 3);
                if (caseIdx === 0 || caseIdx === 15) continue;

                // Interpolation on edges
                const x0 = -halfWorld + ix * sp;
                const z0 = -halfWorld + iz * sp;
                const x1 = x0 + sp;
                const z1 = z0 + sp;

                function lerp(va, vb, pa, pb) {
                    const t = (level - va) / (vb - va);
                    return [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
                }

                // Edges: top(0-1), right(1-2), bottom(2-3), left(3-0)
                const eTop = (c0 !== c1) ? lerp(v0, v1, [x0, z0], [x1, z0]) : null;
                const eRight = (c1 !== c2) ? lerp(v1, v2, [x1, z0], [x1, z1]) : null;
                const eBot = (c2 !== c3) ? lerp(v2, v3, [x1, z1], [x0, z1]) : null;
                const eLeft = (c3 !== c0) ? lerp(v3, v0, [x0, z1], [x0, z0]) : null;

                // Marching squares edge table
                const edges = [];
                switch (caseIdx) {
                    case 1: case 14: edges.push(eTop, eLeft); break;
                    case 2: case 13: edges.push(eTop, eRight); break;
                    case 3: case 12: edges.push(eLeft, eRight); break;
                    case 4: case 11: edges.push(eRight, eBot); break;
                    case 5: edges.push(eTop, eRight, eBot, eLeft); break;
                    case 6: case 9:  edges.push(eTop, eBot); break;
                    case 7: case 8:  edges.push(eLeft, eBot); break;
                    case 10: edges.push(eTop, eLeft, eRight, eBot); break;
                }

                // Emit line segments (pairs of points)
                for (let ei = 0; ei < edges.length; ei += 2) {
                    const a = edges[ei], b = edges[ei + 1];
                    if (!a || !b) continue;
                    const ha = getTerrainHeight(a[0], a[1]);
                    const hb = getTerrainHeight(b[0], b[1]);
                    contourPos.push(a[0], ha + yOff + 0.001, a[1]);
                    contourPos.push(b[0], hb + yOff + 0.001, b[1]);
                }
            }
        }
    }

    if (contourPos.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(contourPos, 3));
        const mat = new THREE.LineBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false
        });
        const lines = new THREE.LineSegments(geo, mat);
        lines.renderOrder = 994;
        contourGroup.add(lines);
    }
}

// ===================================================================
// NORMALS HELPER — visualise HEIGHT_GRID normals as line segments
// ===================================================================
let normalsHelper = null;

function buildNormalsHelper() {
    if (normalsHelper) {
        worldGroup.remove(normalsHelper);
        normalsHelper.geometry.dispose();
        normalsHelper.material.dispose();
        normalsHelper = null;
    }

    const step   = 2;                       // sample every N grid cells
    const len    = 0.25;                    // arrow length in world units
    const half   = TR_WORLD_SIZE / 2;
    const gstep  = TR_WORLD_SIZE / (TR_GRID_SIZE - 1);
    const pts    = [];

    for (let iz = 0; iz < TR_GRID_SIZE; iz += step) {
        for (let ix = 0; ix < TR_GRID_SIZE; ix += step) {
            const wx = -half + ix * gstep;
            const wz = -half + iz * gstep;
            const wy = getTerrainHeight(wx, wz);
            const n  = getTerrainNormal(wx, wz);
            pts.push(wx,       wy,       wz);
            pts.push(wx + n.x * len, wy + n.y * len, wz + n.z * len);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false, transparent: true, opacity: 0.7 });
    normalsHelper = new THREE.LineSegments(geo, mat);
    normalsHelper.renderOrder = 10;
    worldGroup.add(normalsHelper);
}

function toggleNormalsHelper() {
    viz.normalsVisible = !viz.normalsVisible;
    if (viz.normalsVisible) {
        buildNormalsHelper();
    } else if (normalsHelper) {
        worldGroup.remove(normalsHelper);
        normalsHelper.geometry.dispose();
        normalsHelper.material.dispose();
        normalsHelper = null;
    }
}

function refreshNormalsIfVisible() {
    if (viz.normalsVisible) buildNormalsHelper();
}

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
            if (distToHole(x, z) < HOLE_RADIUS_M * 3) continue;

            const { gx, gz } = getGradientAt(x, z, env.angleDeg);
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
        const g = getGradientAt(x, z, env.angleDeg);
        const mag = Math.hypot(g.gx, g.gz);
        if (mag < 0.003) break;
        // Step along gradient direction (pure fall-line)
        x += (g.gx / mag) * stepSize;
        z += (g.gz / mag) * stepSize;
        if (greenSignedDistance(x, z) > -0.1) break;
        if (distToHole(x, z) < HOLE_RADIUS_M * 1.5) { points.push([x, z]); break; }
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
    const spacing = 0.36;
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

    flowLastAngle = env.angleDeg;
    flowLastStimp = env.stimpM;
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

        const g = getGradientAt(px, pz, env.angleDeg);
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
    const g = getGradientAt(x, z, env.angleDeg);
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

    gridFlowLastAngle = env.angleDeg;
    gridFlowLastStimp = env.stimpM;
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
        const g = getGradientAt(p.spawnX, p.spawnZ, env.angleDeg);
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
    if (Math.abs(env.angleDeg) < 0.01) return;

    const halfEst = greenBoundingRadius() * 0.5;
    const arrowX = -halfEst * 0.85;
    const yOff = 0.01;
    const arrowLen = Math.max(0.3, Math.min(1.5, Math.abs(env.angleDeg) * 0.15));
    const headSize = 0.12;
    const dir = env.angleDeg > 0 ? 1.0 : -1.0;
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
const guideEl = document.getElementById('guide');
let guideTimer = null;

function setGuide(text, duration) {
    if (gameCtx.state) { guideEl.classList.remove('show'); return; }
    if (!text) { guideEl.classList.remove('show'); return; }
    guideEl.textContent = text;
    guideEl.classList.add('show');
    if (guideTimer) clearTimeout(guideTimer);
    if (duration) {
        guideTimer = setTimeout(() => { guideEl.classList.remove('show'); }, duration);
    } else {
        guideTimer = null;
    }
}

function clearGuide() { guideEl.classList.remove('show'); if (guideTimer) { clearTimeout(guideTimer); guideTimer = null; } }

function updateHUD() {
    const lines = [
        `angle: ${env.angleDeg.toFixed(1)} deg`,
        `stimp: ${env.stimpM.toFixed(1)} m`,
        `true roll: ${getTrueRollStrength().toFixed(1)}`,
        `start dist: ${ball.circleRadius.toFixed(1)} m`,
        `launch angle: ${env.launchAngleDeg > 0 ? '+' : ''}${env.launchAngleDeg} deg`,
    ];

    if (ball.moving) {
        lines.push(`speed: ${Math.hypot(ball.vel[0], ball.vel[2]).toFixed(2)} m/s`);
    } else {
        const aimDist = Math.max(
            Math.hypot(aimWorld.x - ball.pos[0], aimWorld.z - ball.pos[2]), 0.1
        );
        const v0 = STIMP_V0 * Math.sqrt(aimDist / env.stimpM);
        lines.push(`shot speed: ${v0.toFixed(2)} m/s`);
    }

    lines.push(`distance: ${ball.travelDist.toFixed(2)} m`);
    lines.push(`to hole: ${distToHole(ball.pos[0], ball.pos[2]).toFixed(2)} m`);
    lines.push(`height: ${ball.pos[1].toFixed(3)} m`);

    if (ball.moving || ball.maxHeight > BALL_RADIUS_M + 0.01) {
        lines.push(`max height: ${ball.maxHeight.toFixed(3)} m`);
        lines.push(`bounces: ${ball.bounceCount}`);
    }

    statsEl.textContent = lines.join('\n');
    helpEl.style.display = viz.showHelp ? '' : 'none';
    if (messageEl) messageEl.style.display = ball.inHole ? '' : 'none';
    syncSlidersFromState();
}

// ===================================================================
// SPEED CHART
// ===================================================================
const speedCanvas = document.getElementById('speed-chart');
const speedCtx = speedCanvas.getContext('2d');

function drawSpeedChart() {
    if (!charts.showSpeed) return;
    const W = speedCanvas.width, H = speedCanvas.height;
    const pad = { l: 45, r: 15, t: 30, b: 30 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

    speedCtx.clearRect(0, 0, W, H);

    // Background
    speedCtx.fillStyle = 'rgba(10, 12, 16, 0.75)';
    speedCtx.fillRect(0, 0, W, H);

    if (charts.speedData.length < 4) return; // need at least 2 points (pairs of dist,speed)

    // Find ranges
    let maxDist = 0, maxSpeed = 0;
    for (let i = 0; i < charts.speedData.length; i += 2) {
        if (charts.speedData[i] > maxDist) maxDist = charts.speedData[i];
        if (charts.speedData[i + 1] > maxSpeed) maxSpeed = charts.speedData[i + 1];
    }
    if (maxDist < 0.01) maxDist = 1;
    if (maxSpeed < 0.01) maxSpeed = 1;
    // Round up for nice axis
    maxDist = Math.ceil(maxDist * 2) / 2;
    maxSpeed = Math.ceil(maxSpeed * 4) / 4;

    // Grid lines
    speedCtx.strokeStyle = 'rgba(255,255,255,0.1)';
    speedCtx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = pad.t + ch - (i / 4) * ch;
        speedCtx.beginPath();
        speedCtx.moveTo(pad.l, y);
        speedCtx.lineTo(pad.l + cw, y);
        speedCtx.stroke();
    }
    for (let i = 0; i <= 4; i++) {
        const x = pad.l + (i / 4) * cw;
        speedCtx.beginPath();
        speedCtx.moveTo(x, pad.t);
        speedCtx.lineTo(x, pad.t + ch);
        speedCtx.stroke();
    }

    // Axes
    speedCtx.strokeStyle = 'rgba(255,255,255,0.4)';
    speedCtx.lineWidth = 1;
    speedCtx.beginPath();
    speedCtx.moveTo(pad.l, pad.t);
    speedCtx.lineTo(pad.l, pad.t + ch);
    speedCtx.lineTo(pad.l + cw, pad.t + ch);
    speedCtx.stroke();

    // Labels
    speedCtx.fillStyle = 'rgba(255,255,255,0.6)';
    speedCtx.font = '15px Courier New';
    speedCtx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
        const x = pad.l + (i / 4) * cw;
        speedCtx.fillText((maxDist * i / 4).toFixed(1), x, pad.t + ch + 14);
    }
    speedCtx.fillText('(m)', pad.l + cw / 2, pad.t + ch + 26);
    speedCtx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const y = pad.t + ch - (i / 4) * ch;
        speedCtx.fillText((maxSpeed * i / 4).toFixed(1), pad.l - 5, y + 5);
    }
    speedCtx.save();
    speedCtx.translate(12, pad.t + ch / 2);
    speedCtx.rotate(-Math.PI / 2);
    speedCtx.textAlign = 'center';
    speedCtx.fillText('(m/s)', 0, 0);
    speedCtx.restore();

    // Curve
    speedCtx.strokeStyle = '#ffe033';
    speedCtx.lineWidth = 2;
    speedCtx.beginPath();
    for (let i = 0; i < charts.speedData.length; i += 2) {
        const x = pad.l + (charts.speedData[i] / maxDist) * cw;
        const y = pad.t + ch - (charts.speedData[i + 1] / maxSpeed) * ch;
        if (i === 0) speedCtx.moveTo(x, y);
        else speedCtx.lineTo(x, y);
    }
    speedCtx.stroke();
}

function toggleSpeedChart() {
    charts.showSpeed = !charts.showSpeed;
    speedCanvas.style.display = charts.showSpeed ? 'block' : 'none';
    if (!charts.showSpeed) speedCtx.clearRect(0, 0, speedCanvas.width, speedCanvas.height);
}

// ===================================================================
// ENERGY BUDGET CHART
// ===================================================================
const energyCanvas = document.getElementById('energy-chart');
const energyCtx = energyCanvas.getContext('2d');

function drawEnergyChart() {
    if (!charts.showEnergy) return;
    const W = energyCanvas.width, H = energyCanvas.height;
    energyCtx.clearRect(0, 0, W, H);

    // Background
    energyCtx.fillStyle = 'rgba(0,0,0,0.7)';
    energyCtx.fillRect(0, 0, W, H);

    const pad = { l: 42, r: 14, t: 20, b: 40 };
    const cw = W - pad.l - pad.r;
    const ch = H - pad.t - pad.b;

    // Determine x range
    let maxDist = 0.5;
    for (let i = 0; i < charts.energyData.length; i += 2) {
        if (charts.energyData[i] > maxDist) maxDist = charts.energyData[i];
    }
    // If we have launch params, extend range to where flat reference hits 0
    if (ball.launchV0sq > 0 && ball.launchMu !== null) {
        const flatStop = ball.launchV0sq / (2 * ball.launchMu * GRAVITY);
        if (flatStop > maxDist) maxDist = flatStop;
    }

    // Grid lines
    energyCtx.strokeStyle = 'rgba(255,255,255,0.1)';
    energyCtx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
        const y = pad.t + (g / 4) * ch;
        energyCtx.beginPath();
        energyCtx.moveTo(pad.l, y);
        energyCtx.lineTo(pad.l + cw, y);
        energyCtx.stroke();
    }

    // Axes
    energyCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    energyCtx.lineWidth = 1.5;
    energyCtx.beginPath();
    energyCtx.moveTo(pad.l, pad.t);
    energyCtx.lineTo(pad.l, pad.t + ch);
    energyCtx.lineTo(pad.l + cw, pad.t + ch);
    energyCtx.stroke();

    // Axis labels
    energyCtx.fillStyle = '#ccc';
    energyCtx.font = '15px monospace';
    energyCtx.textAlign = 'right';
    energyCtx.textBaseline = 'middle';
    const yLabels = ['100%', '75%', '50%', '25%', '0%'];
    for (let g = 0; g <= 4; g++) {
        const y = pad.t + (g / 4) * ch;
        energyCtx.fillText(yLabels[g], pad.l - 4, y);
    }
    // X axis ticks + labels
    energyCtx.textAlign = 'center';
    energyCtx.textBaseline = 'top';
    energyCtx.strokeStyle = 'rgba(255,255,255,0.4)';
    energyCtx.lineWidth = 1;
    const xTicks = 5;
    for (let t = 0; t <= xTicks; t++) {
        const x = pad.l + (t / xTicks) * cw;
        energyCtx.beginPath();
        energyCtx.moveTo(x, pad.t + ch);
        energyCtx.lineTo(x, pad.t + ch + 5);
        energyCtx.stroke();
        energyCtx.fillStyle = '#ccc';
        energyCtx.fillText((maxDist * t / xTicks).toFixed(1), x, pad.t + ch + 7);
    }
    // X axis unit label
    energyCtx.fillStyle = '#999';
    energyCtx.fillText('(m)', pad.l + cw / 2, pad.t + ch + 20);

    // Y axis label (rotated)
    energyCtx.save();
    energyCtx.translate(10, pad.t + ch / 2);
    energyCtx.rotate(-Math.PI / 2);
    energyCtx.textAlign = 'center';
    energyCtx.textBaseline = 'middle';
    energyCtx.fillText('KE %', 0, 0);
    energyCtx.restore();

    // Flat green reference curve (grey dotted)
    if (ball.launchV0sq > 0 && ball.launchMu !== null) {
        energyCtx.setLineDash([6, 4]);
        energyCtx.strokeStyle = 'rgba(180,180,180,0.7)';
        energyCtx.lineWidth = 1.5;
        energyCtx.beginPath();
        const steps = 80;
        let started = false;
        for (let s = 0; s <= steps; s++) {
            const d = (s / steps) * maxDist;
            const keFlat = Math.max(0, 1 - (2 * ball.launchMu * GRAVITY * d) / ball.launchV0sq);
            const px = pad.l + (d / maxDist) * cw;
            const py = pad.t + ch - keFlat * ch;
            if (!started) { energyCtx.moveTo(px, py); started = true; }
            else energyCtx.lineTo(px, py);
            if (keFlat === 0) break;
        }
        energyCtx.stroke();
        energyCtx.setLineDash([]);
    }

    // Actual KE curve (yellow fill + stroke)
    if (charts.energyData.length >= 4) {
        // Build flat reference values at same x positions for fill
        energyCtx.beginPath();
        // Forward pass along actual curve
        for (let i = 0; i < charts.energyData.length; i += 2) {
            const d = charts.energyData[i];
            const ke = charts.energyData[i + 1];
            const px = pad.l + (d / maxDist) * cw;
            const py = pad.t + ch - ke * ch;
            if (i === 0) energyCtx.moveTo(px, py);
            else energyCtx.lineTo(px, py);
        }
        // Reverse pass along flat reference for fill
        for (let i = charts.energyData.length - 2; i >= 0; i -= 2) {
            const d = charts.energyData[i];
            let keFlat = 1;
            if (ball.launchV0sq > 0 && ball.launchMu !== null) {
                keFlat = Math.max(0, 1 - (2 * ball.launchMu * GRAVITY * d) / ball.launchV0sq);
            }
            const px = pad.l + (d / maxDist) * cw;
            const py = pad.t + ch - keFlat * ch;
            energyCtx.lineTo(px, py);
        }
        energyCtx.closePath();
        energyCtx.fillStyle = 'rgba(255, 200, 50, 0.18)';
        energyCtx.fill();

        // Actual curve stroke
        energyCtx.beginPath();
        for (let i = 0; i < charts.energyData.length; i += 2) {
            const d = charts.energyData[i];
            const ke = charts.energyData[i + 1];
            const px = pad.l + (d / maxDist) * cw;
            const py = pad.t + ch - ke * ch;
            if (i === 0) energyCtx.moveTo(px, py);
            else energyCtx.lineTo(px, py);
        }
        energyCtx.strokeStyle = '#ffc832';
        energyCtx.lineWidth = 2;
        energyCtx.stroke();
    }
}

function toggleEnergyChart() {
    charts.showEnergy = !charts.showEnergy;
    energyCanvas.style.display = charts.showEnergy ? 'block' : 'none';
    if (!charts.showEnergy) energyCtx.clearRect(0, 0, energyCanvas.width, energyCanvas.height);
}

// ===================================================================
// PHASE SPACE PORTRAIT
// ===================================================================
const phaseCanvas = document.getElementById('phase-chart');
const phaseCtx    = phaseCanvas.getContext('2d');

function drawPhaseChart() {
    if (!charts.showPhase) return;
    const W = phaseCanvas.width, H = phaseCanvas.height;
    phaseCtx.clearRect(0, 0, W, H);
    phaseCtx.fillStyle = 'rgba(0,0,0,0.75)';
    phaseCtx.fillRect(0, 0, W, H);

    const pad = { l: 42, r: 14, t: 22, b: 30 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    const cx = pad.l + cw / 2, cy = pad.t + ch / 2;
    const scale = Math.min(cw, ch) / 2;
    const maxV  = Math.max(charts.phaseV0 * 1.05, 0.01);

    // Grid
    phaseCtx.strokeStyle = 'rgba(255,255,255,0.08)';
    phaseCtx.lineWidth = 1;
    for (let g = -1; g <= 1; g += 0.5) {
        const px = cx + g * scale;
        const py = cy + g * scale;
        phaseCtx.beginPath(); phaseCtx.moveTo(px, pad.t); phaseCtx.lineTo(px, pad.t + ch); phaseCtx.stroke();
        phaseCtx.beginPath(); phaseCtx.moveTo(pad.l, py); phaseCtx.lineTo(pad.l + cw, py); phaseCtx.stroke();
    }

    // Axes
    phaseCtx.strokeStyle = 'rgba(255,255,255,0.4)';
    phaseCtx.lineWidth = 1.5;
    phaseCtx.beginPath(); phaseCtx.moveTo(cx, pad.t); phaseCtx.lineTo(cx, pad.t + ch); phaseCtx.stroke();
    phaseCtx.beginPath(); phaseCtx.moveTo(pad.l, cy); phaseCtx.lineTo(pad.l + cw, cy); phaseCtx.stroke();

    // Axis labels
    phaseCtx.fillStyle = '#aaa'; phaseCtx.font = '15px monospace';
    phaseCtx.textAlign = 'center'; phaseCtx.textBaseline = 'top';
    phaseCtx.fillText('vx', pad.l + cw - 2, cy + 4);
    phaseCtx.textAlign = 'left'; phaseCtx.textBaseline = 'middle';
    phaseCtx.fillText('vz', cx + 4, pad.t + 4);

    // Title
    phaseCtx.fillStyle = '#666'; phaseCtx.textAlign = 'left'; phaseCtx.textBaseline = 'top';
    phaseCtx.fillText('Phase space  (vx, vz)', pad.l, 4);

    // Origin target
    phaseCtx.fillStyle = '#ff4444';
    phaseCtx.beginPath(); phaseCtx.arc(cx, cy, 4, 0, Math.PI * 2); phaseCtx.fill();

    if (charts.phaseData.length < 4) return;

    // Trajectory — colour by speed magnitude
    phaseCtx.lineWidth = 1.8;
    for (let i = 2; i < charts.phaseData.length; i += 2) {
        const vx0 = charts.phaseData[i-2], vz0 = charts.phaseData[i-1];
        const vx1 = charts.phaseData[i],   vz1 = charts.phaseData[i+1];
        const ratio = Math.hypot(vx1, vz1) / maxV;
        const [r, g, b] = trailSpeedColor(Math.min(1, ratio));
        phaseCtx.strokeStyle = `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`;
        phaseCtx.beginPath();
        phaseCtx.moveTo(cx + (vx0 / maxV) * scale, cy - (vz0 / maxV) * scale);
        phaseCtx.lineTo(cx + (vx1 / maxV) * scale, cy - (vz1 / maxV) * scale);
        phaseCtx.stroke();
    }

    // Current point
    const n = charts.phaseData.length;
    const cvx = charts.phaseData[n-2], cvz = charts.phaseData[n-1];
    phaseCtx.fillStyle = '#fff';
    phaseCtx.beginPath();
    phaseCtx.arc(cx + (cvx / maxV) * scale, cy - (cvz / maxV) * scale, 3, 0, Math.PI*2);
    phaseCtx.fill();
}

function togglePhaseChart() {
    charts.showPhase = !charts.showPhase;
    phaseCanvas.style.display = charts.showPhase ? 'block' : 'none';
    if (!charts.showPhase) phaseCtx.clearRect(0, 0, phaseCanvas.width, phaseCanvas.height);
}


// ===================================================================
// METRICS PANEL
// ===================================================================
const metricsPanel = document.getElementById('metrics-panel');
const mToHole = document.getElementById('m-to-hole');
const mInitSpeed = document.getElementById('m-init-speed');
const mSpeedHole = document.getElementById('m-speed-hole');
const mFinalDist = document.getElementById('m-final-dist');
const mMaxBreak = document.getElementById('m-max-break');
const mBreakApex = document.getElementById('m-break-apex');
const mLineError = document.getElementById('m-line-error');
const mEntryAngle = document.getElementById('m-entry-angle');

document.getElementById('metrics-toggle').addEventListener('click', () => {
    metricsPanel.classList.toggle('collapsed');
});

// ===================================================================
// D-PAD
// ===================================================================
const keysHeld = {};
const dpadEl = document.getElementById('dpad');
const dpadMap = {
    'dpad-up':    'ArrowUp',
    'dpad-down':  'ArrowDown',
    'dpad-left':  'ArrowLeft',
    'dpad-right': 'ArrowRight',
};
Object.entries(dpadMap).forEach(([id, key]) => {
    const btn = document.getElementById(id);
    btn.addEventListener('pointerdown', e => { e.preventDefault(); keysHeld[key] = true; });
    btn.addEventListener('pointerup',     () => { delete keysHeld[key]; });
    btn.addEventListener('pointerleave',  () => { delete keysHeld[key]; });
    btn.addEventListener('pointercancel', () => { delete keysHeld[key]; });
});

// Distance +/- buttons
const dpadDistLabel = document.getElementById('dpad-dist-label');
function updateDistLabel() {
    dpadDistLabel.textContent = ball.circleRadius.toFixed(1);
}
document.getElementById('dpad-dist-minus').addEventListener('click', () => {
    if (ball.moving || !ball.onCircle) return;
    ball.circleRadius = Math.max(BALL_CIRCLE_MIN, ball.circleRadius - BALL_CIRCLE_STEP);
    updateBallOnCircle();
    updateDistLabel();
});
document.getElementById('dpad-dist-plus').addEventListener('click', () => {
    if (ball.moving || !ball.onCircle) return;
    ball.circleRadius = Math.min(BALL_CIRCLE_MAX, ball.circleRadius + BALL_CIRCLE_STEP);
    updateBallOnCircle();
    updateDistLabel();
});

function updateMetrics() {
    if (metricsPanel.classList.contains('collapsed')) return;
    const dh = distToHole(ball.pos[0], ball.pos[2]);
    mToHole.textContent = dh.toFixed(2) + ' m';

    // Initial speed
    if (ball.initialSpeed !== null) {
        mInitSpeed.textContent = ball.initialSpeed.toFixed(2) + ' m/s';
    }

    // Speed at hole
    if (ball.speedAtHole !== null) {
        mSpeedHole.textContent = ball.speedAtHole.toFixed(2) + ' m/s';
    } else if (ball.moving) {
        mSpeedHole.textContent = '...';
    }

    // Final distance to hole (updated when stopped)
    if (!ball.moving && ball.travelDist > 0.01) {
        mFinalDist.textContent = dh.toFixed(2) + ' m';
    } else if (ball.moving) {
        mFinalDist.textContent = '...';
    }

    // Max break
    if (ball.maxLateralDev > 0.001) {
        const ballDiam = 2 * BALL_RADIUS_M;
        const nBalls = ball.maxLateralDev / ballDiam;
        mMaxBreak.textContent = nBalls.toFixed(1) + ' balls (' + (ball.maxLateralDev * 100).toFixed(1) + ' cm)';
    } else if (ball.moving) {
        mMaxBreak.textContent = '...';
    }

    // Break apex (% of total travel)
    if (ball.breakApexTravelDist > 0 && ball.travelDist > 0.01) {
        const pct = (ball.breakApexTravelDist / ball.travelDist) * 100;
        mBreakApex.textContent = pct.toFixed(0) + '% (' + ball.breakApexTravelDist.toFixed(2) + ' m)';
    } else if (ball.moving) {
        mBreakApex.textContent = '...';
    }

    // Line error at hole
    if (ball.lineErrorAtHole !== null) {
        const ballDiam = 2 * BALL_RADIUS_M;
        const nBalls = ball.lineErrorAtHole / ballDiam;
        mLineError.textContent = nBalls.toFixed(1) + ' balls (' + (ball.lineErrorAtHole * 100).toFixed(1) + ' cm)';
    } else if (ball.moving) {
        mLineError.textContent = '...';
    }

    // Entry angle
    if (ball.entryAngle !== null) {
        mEntryAngle.textContent = ball.entryAngle.toFixed(1) + '°';
    } else if (ball.moving) {
        mEntryAngle.textContent = '...';
    }
}

// ===================================================================
// INPUT
// ===================================================================
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
    if (e.key === ' ' && !ball.moving && !ball.inHole) {
        if (!gameCtx.state || gameCtx.state === 'putting') shoot();
    }
    if (e.key === 'h' || e.key === 'H') viz.showHelp = !viz.showHelp;
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
    if (!gameCtx.state) {
        if (e.key === 'x' || e.key === 'X') env.stimpM = Math.min(6.0, env.stimpM + 0.1);
        if (e.key === 'y' || e.key === 'Y') env.stimpM = Math.max(1.0, env.stimpM - 0.1);
        if ((e.key === 'r' || e.key === 'R') && !e.repeat) resetBall(e.shiftKey);
        if (e.key === '1' && !ball.moving && ball.onCircle) {
            ball.circleRadius = Math.max(BALL_CIRCLE_MIN, ball.circleRadius - BALL_CIRCLE_STEP);
            updateBallOnCircle(); updateDistLabel();
        }
        if (e.key === '2' && !ball.moving && ball.onCircle) {
            ball.circleRadius = Math.min(BALL_CIRCLE_MAX, ball.circleRadius + BALL_CIRCLE_STEP);
            updateBallOnCircle(); updateDistLabel();
        }
        if (e.key === '3') env.launchAngleDeg = Math.max(LAUNCH_ANGLE_MIN, env.launchAngleDeg - LAUNCH_ANGLE_STEP);
        if (e.key === '4') env.launchAngleDeg = Math.min(LAUNCH_ANGLE_MAX, env.launchAngleDeg + LAUNCH_ANGLE_STEP);
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
let placingHole = false;

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
    if (dist < CLICK_MAX_MOVE && elapsed < CLICK_MAX_TIME && !ball.moving && ball.inHole) {
        resetBall(false);
        return;
    }
    if (dist < CLICK_MAX_MOVE && elapsed < CLICK_MAX_TIME && !ball.moving) {
        const ndc = new THREE.Vector2(
            (e.clientX / window.innerWidth) * 2 - 1,
            -(e.clientY / window.innerHeight) * 2 + 1
        );
        // Place Hole mode (GLB only)
        if (placingHole && glbCtx.mode) {
            const pt = resolveAimPoint(ndc);
            if (pt) {
                setHolePosition(pt.x, pt.z);
                placingHole = false;
                document.getElementById('glb-place-hole').textContent = 'Place Hole';
                document.getElementById('glb-place-hole').style.color = '';
            }
            return;
        }
        // Short click — set aimpoint via raycast
        if (!ball.inHole) {
            const pt = resolveAimPoint(ndc);
            if (pt) {
                aimWorld.set(pt.x, getTerrainHeight(pt.x, pt.z), pt.z);
                aimLocked = true;
                aimDot.material.color.setHex(0xe61a1a);
                clearHint();
                showAimPopup(e.clientX, e.clientY);
                setGuide(GUIDE.SHOOT, 3000);
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
    viz.flowMode = (viz.flowMode + 1) % 5;
    flowGroup.visible      = viz.flowMode === 1;
    gridFlowGroup.visible  = viz.flowMode === 2;
    gradientGroup.visible  = viz.flowMode === 3;
    contourGroup.visible   = viz.flowMode === 4;
    if (viz.flowMode === 1 && flowStreamlines.length === 0) rebuildFlowVisuals();
    if (viz.flowMode === 2 && gridFlowParticles.length === 0) rebuildGridFlow();
    if (viz.flowMode === 3) { buildGradientArrows(); }
    if (viz.flowMode === 4 && contourGroup.children.length === 0) buildContourVis();
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

// ---- Sidebar (N key + tab) ----
const sidebar    = document.getElementById('sidebar');
const sidebarTab = document.getElementById('sidebar-tab');
sidebarTab.addEventListener('click', () => sidebar.classList.toggle('hidden'));
document.addEventListener('keydown', (e) => {
    if ((e.key === 'n' || e.key === 'N') && document.activeElement.tagName !== 'INPUT')
        sidebar.classList.toggle('hidden');
});

// ---- Panel accordion ----
for (const { panelId, toggleId } of [
    { panelId: 'panel-green',    toggleId: 'toggle-green'    },
    { panelId: 'panel-lighting', toggleId: 'toggle-lighting' },
    { panelId: 'panel-glb',      toggleId: 'toggle-glb'      },
]) {
    document.getElementById(toggleId).addEventListener('click', () => {
        const panel  = document.getElementById(panelId);
        const isOpen = panel.classList.contains('open');
        document.querySelectorAll('.side-panel.open').forEach(p => p.classList.remove('open'));
        if (!isOpen) panel.classList.add('open');
    });
}

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
    if (gameCtx.state) { syncSlidersFromState(); return; }
    env.angleDeg = parseFloat(slAngle.value);
    valAngle.textContent = env.angleDeg.toFixed(1);
});
slStimp.addEventListener('input', () => {
    if (gameCtx.state) { syncSlidersFromState(); return; }
    env.stimpM = parseFloat(slStimp.value);
    valStimp.textContent = env.stimpM.toFixed(1);
});
slTroll.addEventListener('input', () => {
    if (gameCtx.state) { syncSlidersFromState(); return; }
    setTrueRollStrength(parseFloat(slTroll.value));
    valTroll.textContent = getTrueRollStrength().toFixed(1);
});
slDist.addEventListener('input', () => {
    if (gameCtx.state) { syncSlidersFromState(); return; }
    if (ball.moving || !ball.onCircle) return;
    ball.circleRadius = parseFloat(slDist.value);
    valDist.textContent = ball.circleRadius.toFixed(1);
    updateBallOnCircle();
});
slPos.addEventListener('input', () => {
    if (gameCtx.state) { syncSlidersFromState(); return; }
    if (ball.moving || !ball.onCircle) return;
    ball.angle = parseFloat(slPos.value) * Math.PI / 180;
    ball.lastCircleAngle = ball.angle;
    valPos.textContent = Math.round(parseFloat(slPos.value));
    updateBallOnCircle();
});
slLaunch.addEventListener('input', () => {
    if (gameCtx.state) { syncSlidersFromState(); return; }
    env.launchAngleDeg = parseInt(slLaunch.value, 10);
    valLaunch.textContent = env.launchAngleDeg;
});

// ---- Bidirectional sync: keyboard → sliders ----
function syncSlidersFromState() {
    slAngle.value  = env.angleDeg;
    slStimp.value  = env.stimpM;
    slTroll.value  = getTrueRollStrength();
    slDist.value   = ball.circleRadius;
    slPos.value    = Math.round(ball.angle * 180 / Math.PI) % 360;
    slLaunch.value = env.launchAngleDeg;
    valAngle.textContent  = env.angleDeg.toFixed(1);
    valStimp.textContent  = env.stimpM.toFixed(1);
    valTroll.textContent  = getTrueRollStrength().toFixed(1);
    valDist.textContent   = ball.circleRadius.toFixed(1);
    valPos.textContent    = Math.round(ball.angle * 180 / Math.PI) % 360;
    valLaunch.textContent = env.launchAngleDeg;
}

// ---- Action buttons ----
document.getElementById('shoot-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (!ball.moving && !ball.inHole && (!gameCtx.state || gameCtx.state === 'putting')) shoot();
});

hintBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (gameCtx.state === 'putting' && !hintUsedThisHole) showHint();
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
    if (gameCtx.state && action !== 'startGame' && action !== 'resetCam' && action !== 'cycleFlow') return;
    switch (action) {
        case 'reset':      resetBall(false); break;
        case 'newTerrain':  resetBall(true); break;
        case 'cycleFlow':   cycleFlowMode(); break;
        case 'resetCam':    resetCamera(); break;
        case 'toggleSpeed':   toggleSpeedChart(); break;
        case 'toggleEnergy':  toggleEnergyChart(); break;
        case 'togglePhase':   togglePhaseChart();  break;
        case 'toggleNormals': toggleNormalsHelper(); break;

        case 'startGame':     startGame(); break;
        case 'loadGLBTerrain': document.getElementById('glb-terrain-input').click(); break;
    }
});

// ---- GLB position controls ----
const glbPosPanel  = document.getElementById('panel-glb');
const glbXSlider     = document.getElementById('glb-x');
const glbYSlider     = document.getElementById('glb-y');
const glbZSlider     = document.getElementById('glb-z');
const glbScaleSlider = document.getElementById('glb-scale');
const glbXVal        = document.getElementById('glb-x-val');
const glbYVal        = document.getElementById('glb-y-val');
const glbZVal        = document.getElementById('glb-z-val');
const glbScaleVal    = document.getElementById('glb-scale-val');

document.getElementById('glb-terrain-input').addEventListener('change', (e) => {
    if (e.target.files[0]) loadGLBTerrain(e.target.files[0], glbCtx, {
        worldGroup,
        greenMesh,
        onLoaded: (err) => {
            if (err) return;
            decorGroup.visible = false;
            glbXSlider.value = 0; glbYSlider.value = 0; glbZSlider.value = 0;
            glbXVal.textContent = '0.0'; glbYVal.textContent = '0.00'; glbZVal.textContent = '0.0';
            glbScaleSlider.value = 1; glbScaleVal.textContent = '×1.00';
            glbPosPanel.classList.remove('glb-hidden');
            glbPosPanel.classList.add('open');
        },
    });
    e.target.value = '';
});

// Scale — visual only while dragging
function applyGLBScaleVisual() {
    if (!glbCtx.sceneRoot) return;
    const s = parseFloat(glbScaleSlider.value);
    glbScaleVal.textContent = '×' + s.toFixed(2);
    glbCtx.sceneRoot.scale.setScalar(s);
}

// Scale — rebuild HEIGHT_GRID on release
function applyGLBScalePhysics() {
    if (!glbCtx.sceneRoot) return;
    applyGLBScaleVisual();
    extractHeightGridFromGLB(glbCtx);
    buildTrueRollGrids(null);
    setHeightGrid(glbCtx.baseHeightGrid);
    refreshNormalsIfVisible();
    if (!ball.moving) {
        const bx = ball.pos[0], bz = ball.pos[2];
        ball.pos[1] = getTerrainHeight(bx, bz) + BALL_RADIUS_M;
    }
}

// Visual-only update: move mesh instantly while dragging (no physics recalculation)
function applyGLBOffsetVisual() {
    if (!glbCtx.sceneRoot) return;
    const x = parseFloat(glbXSlider.value);
    const y = parseFloat(glbYSlider.value);
    const z = parseFloat(glbZSlider.value);
    glbXVal.textContent = x.toFixed(1);
    glbYVal.textContent = y.toFixed(1);
    glbZVal.textContent = z.toFixed(1);
    glbCtx.sceneRoot.position.set(x, y, z);
}

// Physics update: recalculate HEIGHT_GRID on slider release
function applyGLBOffsetPhysics() {
    if (!glbCtx.sceneRoot) return;
    applyGLBOffsetVisual();
    extractHeightGridFromGLB(glbCtx);
    buildTrueRollGrids(null);
    setHeightGrid(glbCtx.baseHeightGrid);
    refreshNormalsIfVisible();
    if (!ball.moving) {
        const bx = ball.pos[0], bz = ball.pos[2];
        ball.pos[1] = getTerrainHeight(bx, bz) + BALL_RADIUS_M;
    }
}

/**
 * Calibrate GLB physics so the ball rolls the expected Stimpmeter distance
 * on the flattest area of the terrain.
 *
 * Algorithm:
 *   1. Find the flattest cell in HEIGHT_GRID (min gradient magnitude).
 *   2. Run simulateGhostRest in +X and −X from that cell (angleDeg=0, stimpM=3).
 *   3. Average the two distances → D_avg. Expected: 3.0 m.
 *   4. k = 3.0 / D_avg.  Scale vertex Y and HEIGHT_GRID by k to enforce the contract.
 */
// State for the visual calibration animation (null = not running)
let calibAnim = null;

function calibrateGLB() {
    if (!glbCtx.mode || !glbCtx.baseHeightGrid || !glbCtx.meshData.length) return;

    const calibResultEl = document.getElementById('glb-calib-result');
    const overlay = document.getElementById('calib-overlay');

    // 1. Use the aimDot position chosen by the user as the calibration launch point
    const flatX = aimWorld.x;
    const flatZ = aimWorld.z;
    if (greenSignedDistance(flatX, flatZ) > -0.3) {
        calibResultEl.textContent = 'Erreur : placez le curseur sur le green';
        return;
    }
    const flatY = getTerrainHeight(flatX, flatZ) + BALL_RADIUS_M;

    // 2a. Visual trajectories — use actual game params so animation looks like a real shot
    const visualCtx = { angleDeg: env.angleDeg, stimpM: env.stimpM, holeX: 999, holeZ: 999 };
    const traj1 = simulateTrajectory([flatX, flatY, flatZ], [ STIMP_V0, 0], visualCtx);
    const traj2 = simulateTrajectory([flatX, flatY, flatZ], [-STIMP_V0, 0], visualCtx);

    if (traj1.path.length < 2 || traj2.path.length < 2) {
        calibResultEl.textContent = 'Erreur : terrain trop pentu au point plat';
        return;
    }

    // 2b. k-factor trajectories — force angleDeg:0 to isolate HEIGHT_GRID amplitude
    //     (slope from world tilt would inflate dAvg and corrupt k)
    const kCtx = { angleDeg: 0, stimpM: env.stimpM, holeX: 999, holeZ: 999 };
    const kTraj1 = simulateTrajectory([flatX, flatY, flatZ], [ STIMP_V0, 0], kCtx);
    const kTraj2 = simulateTrajectory([flatX, flatY, flatZ], [-STIMP_V0, 0], kCtx);
    const kLast1 = kTraj1.path[kTraj1.path.length - 1];
    const kLast2 = kTraj2.path[kTraj2.path.length - 1];
    const kDAvg = (Math.hypot(kLast1[0] - flatX, kLast1[2] - flatZ)
                 + Math.hypot(kLast2[0] - flatX, kLast2[2] - flatZ)) / 2;

    // 3. Create marker mesh (orange sphere, slightly larger than ball)
    if (calibAnim && calibAnim.markerMesh) worldGroup.remove(calibAnim.markerMesh);
    const markerGeo = new THREE.SphereGeometry(BALL_RADIUS_M * 1.5, 12, 8);
    const markerMat = new THREE.MeshPhongMaterial({ color: 0xff8800, emissive: 0x331100 });
    const markerMesh = new THREE.Mesh(markerGeo, markerMat);
    worldGroup.add(markerMesh);

    // 4. Start animation state
    calibAnim = {
        paths:  [traj1.path, traj2.path],
        phase:  0,         // 0 = rolling +X, 1 = rolling -X
        frame:  0,
        markerMesh,
        flatX, flatY, flatZ,
        kDAvg,             // pre-computed flat-simulation distance for k factor
        d1: null, d2: null,
    };

    // 5. Show overlay
    overlay.style.display = 'flex';
    document.getElementById('calib-phase').textContent   = 'Calibrage  1/2 → +X';
    document.getElementById('calib-speed').textContent   = 'Vitesse : — m/s';
    document.getElementById('calib-dist').textContent    = 'Distance : 0.00 m';
    document.getElementById('calib-summary').textContent = '';
    calibResultEl.textContent = 'Calibrage en cours…';
}

/**
 * Called every frame from animate() while calibAnim is active.
 * Advances the marker ball one path-frame and updates the HUD.
 * Each path frame = 4 simulation steps = 4/120 s ≈ 33 ms of sim time.
 */
function updateCalibAnim() {
    const ca = calibAnim;
    const path = ca.paths[ca.phase];
    const nextFrame = Math.min(ca.frame + 1, path.length - 1);
    ca.frame = nextFrame;

    const pt = path[nextFrame];
    ca.markerMesh.position.set(pt[0], pt[1], pt[2]);

    // Instantaneous speed: distance between consecutive path frames / sim time per frame
    let speed = 0;
    if (nextFrame > 0) {
        const prev = path[nextFrame - 1];
        const dSeg = Math.hypot(pt[0] - prev[0], pt[1] - prev[1], pt[2] - prev[2]);
        speed = dSeg / (4 / 120);  // 4 sim steps at 1/120 s each
    }

    const dist = Math.hypot(pt[0] - ca.flatX, pt[2] - ca.flatZ);
    document.getElementById('calib-speed').textContent = `Vitesse : ${speed.toFixed(3)} m/s`;
    document.getElementById('calib-dist').textContent  = `Distance : ${dist.toFixed(2)} m`;

    // End of current path?
    if (nextFrame >= path.length - 1) {
        const last = path[path.length - 1];
        const d = Math.hypot(last[0] - ca.flatX, last[2] - ca.flatZ);

        if (ca.phase === 0) {
            // Switch to second direction
            ca.d1 = d;
            ca.frame = 0;
            ca.phase = 1;
            document.getElementById('calib-phase').textContent = 'Calibrage  2/2 → −X';
            document.getElementById('calib-summary').textContent = `D+X = ${d.toFixed(2)} m`;
            ca.markerMesh.position.set(ca.flatX, ca.flatY, ca.flatZ);
        } else {
            // Both paths done — apply calibration factor
            ca.d2 = d;
            applyCalibFactor();
        }
    }
}

/**
 * Called when both calibration paths have been animated.
 * Computes k = 3.0 / D_avg and scales the GLB terrain accordingly.
 */
function applyCalibFactor() {
    const ca = calibAnim;
    // Use the flat-simulation distance (angleDeg:0) to isolate HEIGHT_GRID amplitude.
    // ca.d1/d2 are the visual distances (informational only, may include slope effect).
    const dAvg = ca.kDAvg;
    const calibResultEl = document.getElementById('glb-calib-result');
    const overlay = document.getElementById('calib-overlay');

    // Clean up marker
    worldGroup.remove(ca.markerMesh);
    calibAnim = null;
    overlay.style.display = 'none';

    // Validate
    if (dAvg < 0.05) {
        calibResultEl.textContent = 'Erreur : terrain trop pentu au point plat';
        return;
    }
    const k = env.stimpM / dAvg;
    if (k < 0.05 || k > 20.0) {
        calibResultEl.textContent = `Erreur : k=${k.toFixed(2)} hors limites`;
        return;
    }

    // Scale vertex Y and baseY by k — keeps visual & physics height in sync
    for (const { geometry, baseY } of glbCtx.meshData) {
        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            pos.setY(i, pos.getY(i) * k);
            baseY[i] *= k;
        }
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
    }

    // Scale sceneRoot Y offset so extractHeightGridFromGLB stays consistent
    if (glbCtx.sceneRoot) {
        const newOffsetY = glbCtx.sceneRoot.position.y * k;
        glbCtx.sceneRoot.position.y = newOffsetY;
        const clampedY = Math.max(-2, Math.min(2, newOffsetY));
        glbYSlider.value = clampedY;
        glbYVal.textContent = clampedY.toFixed(2);
    }

    // Re-derive HEIGHT_GRID from the now-scaled vertices
    extractHeightGridFromGLB(glbCtx);
    buildTrueRollGrids(null);
    setHeightGrid(glbCtx.baseHeightGrid);
    refreshNormalsIfVisible();

    // Reposition ball at new terrain height
    if (!ball.moving) {
        ball.pos[1] = getTerrainHeight(ball.pos[0], ball.pos[2]) + BALL_RADIUS_M;
    }

    calibResultEl.textContent = `k=${k.toFixed(2)}  D=${dAvg.toFixed(2)}m → ${env.stimpM.toFixed(1)}m`;
    console.log(`[GLB calibration] kDAvg=${dAvg.toFixed(3)}m target=${env.stimpM.toFixed(1)}m k=${k.toFixed(4)}`);
}

glbXSlider.addEventListener('input',  applyGLBOffsetVisual);
glbYSlider.addEventListener('input',  applyGLBOffsetVisual);
glbZSlider.addEventListener('input',  applyGLBOffsetVisual);
glbXSlider.addEventListener('change', applyGLBOffsetPhysics);
glbYSlider.addEventListener('change', applyGLBOffsetPhysics);
glbZSlider.addEventListener('change', applyGLBOffsetPhysics);
glbScaleSlider.addEventListener('input',  applyGLBScaleVisual);
glbScaleSlider.addEventListener('change', applyGLBScalePhysics);


document.getElementById('glb-pos-reset').addEventListener('click', () => {
    glbXSlider.value = 0; glbYSlider.value = 0; glbZSlider.value = 0;
    glbScaleSlider.value = 1; glbScaleVal.textContent = '×1.00';
    if (glbCtx.sceneRoot) glbCtx.sceneRoot.scale.setScalar(1);
    applyGLBOffsetPhysics();
});

// Flip mesh vertices along Z, then re-derive HEIGHT_GRID from the updated mesh.
// Keeps visual and physics in sync (HEIGHT_GRID always follows the visual).
document.getElementById('glb-flip-z').addEventListener('click', () => {
    if (!glbCtx.meshData.length) return;
    for (const { geometry } of glbCtx.meshData) {
        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, -pos.getZ(i));
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
    }
    extractHeightGridFromGLB(glbCtx);
    buildTrueRollGrids(null);
    setHeightGrid(glbCtx.baseHeightGrid);
    refreshNormalsIfVisible();
    if (!ball.moving) ball.pos[1] = getTerrainHeight(ball.pos[0], ball.pos[2]) + BALL_RADIUS_M;
});

// Flip mesh vertices along X, then re-derive HEIGHT_GRID.
document.getElementById('glb-flip-x').addEventListener('click', () => {
    if (!glbCtx.meshData.length) return;
    for (const { geometry } of glbCtx.meshData) {
        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
    }
    extractHeightGridFromGLB(glbCtx);
    buildTrueRollGrids(null);
    setHeightGrid(glbCtx.baseHeightGrid);
    refreshNormalsIfVisible();
    if (!ball.moving) ball.pos[1] = getTerrainHeight(ball.pos[0], ball.pos[2]) + BALL_RADIUS_M;
});

// ---- OrbitControls safety guard for slider interaction ----
let _sliderActive = false;
document.getElementById('panels-container').addEventListener('pointerdown', () => {
    _sliderActive = true;
    controls.enabled = false;
});
window.addEventListener('pointerup', () => {
    if (_sliderActive) {
        _sliderActive = false;
        controls.enabled = true;
    }
});

// ---- Light debug sliders ----
{
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
    if (dist < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME && !ball.moving && ball.inHole) {
        resetBall(false);
        return;
    }
    if (dist < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME && !ball.moving) {
        const ndc = new THREE.Vector2(
            (t.clientX / window.innerWidth) * 2 - 1,
            -(t.clientY / window.innerHeight) * 2 + 1
        );
        // Place Hole mode (GLB only)
        if (placingHole && glbCtx.mode) {
            const pt = resolveAimPoint(ndc);
            if (pt) {
                setHolePosition(pt.x, pt.z);
                placingHole = false;
                document.getElementById('glb-place-hole').textContent = 'Place Hole';
                document.getElementById('glb-place-hole').style.color = '';
            }
            return;
        }
        // Short tap — set aimpoint via raycast
        if (!ball.inHole) {
            const pt = resolveAimPoint(ndc);
            if (pt) {
                aimWorld.set(pt.x, getTerrainHeight(pt.x, pt.z), pt.z);
                aimLocked = true;
                aimDot.material.color.setHex(0xe61a1a);
                clearHint();
                showAimPopup(t.clientX, t.clientY);
                setGuide(GUIDE.SHOOT, 3000);
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
        const isCurrent = i === gameCtx.holeIndex && gameCtx.state !== 'gameover';
        const isFuture = i > gameCtx.holeIndex || (i === gameCtx.holeIndex && (gameCtx.state === 'putting' || gameCtx.state === 'moving' || gameCtx.state === 'setup'));
        const cls = isCurrent ? ' current' : (isFuture ? ' future' : '');
        const pts = i < gameCtx.scores.length ? gameCtx.scores[i] : '-';
        html += `<div class="sc-hole${cls}"><span class="sc-num">${i + 1}</span><span class="sc-pts">${pts}</span></div>`;
    }
    html += `<div class="sc-total"><span class="sc-num">TOT</span><span class="sc-pts">${gameCtx.score}</span></div>`;
    scorecardEl.innerHTML = html;
}

function startGame() {
    gameCtx.state = 'setup';
    gameCtx.holeIndex = 0;
    gameCtx.score = 0;
    gameCtx.scores = [];
    // Hide free-play UI (keep stats visible)
    clearGuide();
    helpEl.style.display = 'none';
    document.getElementById('panels-container').style.display = 'none';
    document.getElementById('action-btns').style.display = 'none';
    dpadEl.style.display = 'none';
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
    env.angleDeg = hole.slope;
    env.stimpM = hole.stimp;
    setTrueRollStrength(hole.trueRoll);
    ball.circleRadius = hole.distance;
    env.launchAngleDeg = 0; // pure roll in game mode

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
    ball.angle = Math.random() * Math.PI * 2;
    ball.lastCircleAngle = ball.angle;
    updateBallOnCircle();
    ball.moving = false;
    ball.onCircle = true;
    ball.airborne = false;
    ball.inHole = false;

    // Save start position for later
    gameCtx.startPos = { x: ball.pos[0], z: ball.pos[2] };

    // Hide all visual aids
    viz.flowMode = 0;
    flowGroup.visible = false;
    gridFlowGroup.visible = false;
    gradientGroup.visible = false;
    contourGroup.visible = false;
    goodAimGroup.visible = false;

    // Reset camera
    resetCamera();

    gameCtx.crossedHole = false;
    gameCtx.state = 'putting';

    // Reset hint for this hole
    clearHint();
    hintUsedThisHole = false;
    hintBtn.classList.remove('used');

    // Update game HUD
    gameHoleEl.textContent = `Hole ${index + 1}/9`;
    updateScorecard();
}

function scoreShot(oob, tooFast = false) {
    const dth = distToHole(ball.pos[0], ball.pos[2]);
    const ballDiam = 2 * BALL_RADIUS_M;
    let pts = 0;
    let label = '';

    if (oob) {
        pts = 0;
        label = 'Out of bounds! +0';
    } else if (tooFast) {
        pts = 5;
        label = 'Ball too fast! +5';
    } else if (ball.inHole) {
        pts = 10;
        label = 'IN THE HOLE! +10';
    } else if (gameCtx.crossedHole) {
        pts = 5;
        label = 'Lip out! +5';
    } else if (dth <= ballDiam) {
        pts = 3;
        label = 'Close! +3';
    } else if (dth <= ballDiam * 3) {
        pts = 1;
        label = 'Near +1';
    } else {
        pts = 0;
        label = 'Miss +0';
    }

    gameCtx.score += pts;
    gameCtx.scores.push(pts);
    updateScorecard();

    // Show score popup
    scorePopupEl.textContent = label;
    scorePopupEl.classList.remove('show');
    void scorePopupEl.offsetWidth; // force reflow to restart animation
    scorePopupEl.classList.add('show');

    gameCtx.state = 'reveal';

    // Auto-advance after 3 seconds
    setTimeout(() => {
        if (gameCtx.state !== 'reveal') return; // guard against double-fire
        scorePopupEl.classList.remove('show');
        if (gameCtx.holeIndex < 8) {
            gameCtx.holeIndex++;
            setupHole(gameCtx.holeIndex);
        } else {
            endGame();
        }
    }, 3000);
}

function endGame() {
    gameCtx.state = 'gameover';
    gameHudEl.style.display = 'none';
    gameExitLiveEl.style.display = 'none';
    hintBtn.style.display = 'none';
    flowBtn.style.display = 'none';
    clearHint();

    let grade;
    if (gameCtx.score >= 81) grade = 'GOAT';
    else if (gameCtx.score >= 61) grade = 'Tour Pro';
    else if (gameCtx.score >= 41) grade = 'Scratch Golfer';
    else if (gameCtx.score >= 21) grade = 'Club Player';
    else grade = 'Amateur';

    gameFinalScoreEl.textContent = `${gameCtx.score} / 90`;
    gameGradeEl.textContent = grade;
    gameOverEl.classList.add('show');
}

function exitGame() {
    gameCtx.state = null;
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
    document.getElementById('panels-container').style.display = '';
    document.getElementById('action-btns').style.display = '';
    dpadEl.style.display = '';
    // Reset to defaults
    env.angleDeg = 0;
    env.stimpM = STIMP_DEFAULT;
    setTrueRollStrength(1.0);
    ball.circleRadius = BALL_CIRCLE_RADIUS_DEFAULT;
    updateDistLabel();
    env.launchAngleDeg = LAUNCH_ANGLE_DEFAULT;
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
    const dirX = aimWorld.x - ball.pos[0];
    const dirZ = aimWorld.z - ball.pos[2];
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return;

    // Mark aimDot yellow — previous shot aimpoint
    aimDot.material.color.setHex(0xf0d259);
    clearHint();
    clearGuide();
    charts.speedData = [];
    charts.speedSampleCounter = 0;
    charts.energyData = [];
    charts.phaseData  = [];
    ball.speedAtHole = null;
    ball.maxLateralDev = 0;
    ball.breakApexTravelDist = 0;
    ball.lineErrorAtHole = null;
    ball.entryAngle = null;
    ball.initialSpeed = null;
    ball.metricsShotStart = { x: ball.pos[0], z: ball.pos[2] };
    ball.closestHoleDist = Infinity;
    ball.prevHoleDist = Infinity;

    lastShotStartPos = { x: ball.pos[0], z: ball.pos[2] };

    const speedH = STIMP_V0 * Math.sqrt(len / env.stimpM);
    const dxn = dirX / len, dzn = dirZ / len;
    const launchRad = env.launchAngleDeg * Math.PI / 180;
    const totalSpeed = speedH / Math.cos(launchRad);

    ball.vel[0] = speedH * dxn;
    ball.vel[1] = totalSpeed * Math.sin(launchRad);
    ball.vel[2] = speedH * dzn;
    ball.initialSpeed = speedH;
    charts.phaseV0    = speedH;
    ball.launchV0sq = speedH * speedH;
    ball.launchMu = stimpToMu(env.stimpM);

    ball.moving = true;
    ball.onCircle = false;
    ball.airborne = env.launchAngleDeg !== 0;
    ball.inHole = false;
    ball.bounceCount = 0;
    ball.maxHeight = ball.pos[1];
    ball.spin = env.launchAngleDeg / 15.0;
    ball.travelDist = 0.0;

    const maxHeightCm  = ball.vel[1] > 0 ? (ball.vel[1] * ball.vel[1]) / (2 * GRAVITY) * 100 : 0;
    const flightLenCm  = ball.vel[1] > 0 ? (speedH * ball.vel[1] / GRAVITY) * 100 : 0;
    showShotPopup(totalSpeed, maxHeightCm, flightLenCm, env.launchAngleDeg, ball.spin);


    // Game mode: transition to 'moving'
    if (gameCtx.state === 'putting') {
        gameCtx.state = 'moving';
        gameCtx.crossedHole = false;
    }

    // Ensure first trail point
    if (!currentTrailLine || currentTrailLine.count === 0) {
        addTrailPoint(ball.pos[0], ball.pos[1], ball.pos[2]);
    }

    shotAimPoints.push(aimWorld.clone());
    addAimPointMarker(aimWorld);

    ball.breakPoints = [];
    ball.breakLocked = false;
    ball.prevVz = null;
    ball.prevPosForVz = [ball.pos[0], ball.pos[2]];
    rebuildBreakMarkers();
}

function resetBall(newTerrain) {
    ball.angle = ball.lastCircleAngle;
    const bx = holeX + ball.circleRadius * Math.cos(ball.angle);
    const bz = holeZ + ball.circleRadius * Math.sin(ball.angle);
    const by = getTerrainHeight(bx, bz) + BALL_RADIUS_M;
    ball.pos = [bx, by, bz];
    ball.vel = [0, 0, 0];
    ball.moving = false;
    ball.onCircle = true;
    ball.airborne = false;
    aimLocked = false;
    aimDot.material.color.setHex(0xe61a1a); // red — no aimpoint chosen yet
    ball.inHole = false;
    ball.bounceCount = 0;
    ball.maxHeight = 0.0;
    ball.breakPoints = [];
    ball.breakLocked = false;
    ball.prevVz = null;
    ball.spin = 0.0;
    ball.travelDist = 0.0;
    ballMesh.quaternion.identity();
    clearGhostMarker();

    if (newTerrain) {
        clearAllTrails();
        shotAimPoints = [];
        clearAimPointMarkers();
        if (glbCtx.mode) {
            applyGLBHeightVariation(glbCtx);
        } else {
            decorGroup.visible = true;
            generateShapeSeeds();
            buildTrueRollGrids(null);
            worldGroup.remove(greenMesh);
            greenMesh.geometry.dispose();
            greenMesh = buildGreenMesh();
            worldGroup.add(greenMesh);
        }
        if (viz.flowMode === 3) buildGradientArrows();
        if (viz.flowMode === 4) buildContourVis();
        if (viz.flowMode === 1) rebuildFlowVisuals();
        if (viz.flowMode === 2) rebuildGridFlow();
        rebuildSlopeIndicator();
    } else {
        startNewTrailSegment();
    }
    rebuildBreakMarkers();
    if (!gameCtx.state) setGuide(GUIDE.AIM);
}

function updateBallOnCircle() {
    const bx = holeX + ball.circleRadius * Math.cos(ball.angle);
    const bz = holeZ + ball.circleRadius * Math.sin(ball.angle);
    const by = getTerrainHeight(bx, bz) + BALL_RADIUS_M;
    ball.pos = [bx, by, bz];
}

// ===================================================================
// PHYSICS
// ===================================================================
function updatePhysics(dt) {
    if (!ball.moving) return;

    // Sub-step at 1/120 s to match simulateTrajectory's fixed step — identical integration
    const SIM_DT = 1 / 120;
    const nSteps = Math.max(1, Math.round(dt / SIM_DT));
    const subDt  = dt / nSteps;

    for (let _s = 0; _s < nSteps; _s++) {
    if (!ball.moving) break;

    const angleRad = env.angleDeg * Math.PI / 180;
    const muRoll = stimpToMu(env.stimpM);
    const holeDepth = 0.40;

    // Check if over the hole
    const distToHoleCur = distToHole(ball.pos[0], ball.pos[2]);
    const overHole = distToHoleCur <= HOLE_RADIUS_M + BALL_RADIUS_M * 0.5;

    let groundLevel;
    if (overHole) {
        const sxz = Math.hypot(ball.vel[0], ball.vel[2]);
        const below = ball.pos[1] < BALL_RADIUS_M * 0.5;
        groundLevel = (sxz < 1.45 || below) ? -holeDepth : getTerrainHeight(ball.pos[0], ball.pos[2]);
    } else {
        groundLevel = getTerrainHeight(ball.pos[0], ball.pos[2]);
    }

    const heightAbove = ball.pos[1] - BALL_RADIUS_M - groundLevel;
    ball.airborne = heightAbove > LANDING_THRESHOLD;

    let ax = 0, ay = -GRAVITY, az = 0;

    if (!ball.airborne) {
        const speed = Math.hypot(ball.vel[0], ball.vel[2]);

        // Global slope
        az += GRAVITY * Math.sin(angleRad) * ROLLING_FACTOR;

        if (speed > 1e-4) {
            const normal = getTerrainNormal(ball.pos[0], ball.pos[2]);
            let friction = muRoll * GRAVITY * Math.abs(normal.y);

            // Spin effect
            let spinMod = 1.0 + ball.spin * SPIN_EFFECT_STRENGTH;
            spinMod = Math.max(0.5, Math.min(1.5, spinMod));

            ax -= friction * spinMod * (ball.vel[0] / speed);
            az -= friction * spinMod * (ball.vel[2] / speed);

            // Local terrain slope
            ax += normal.x * GRAVITY * ROLLING_FACTOR;
            az += normal.z * GRAVITY * ROLLING_FACTOR;
        }

        // Spin decay
        ball.spin *= Math.exp(-SPIN_DECAY_RATE * subDt);
        if (Math.abs(ball.spin) < 0.01) ball.spin = 0;

        // True roll
        const tr = trueRollAccel(ball.pos[0], ball.pos[2], ball.vel[0], ball.vel[2]);
        ax += tr.ax;
        az += tr.az;

        // Lip gravity — radial force toward hole center when ball is on the lip
        {
            const lipOuter = HOLE_RADIUS_M * 2.3;  // influence zone ~2.3× hole radius
            const dh = distToHole(ball.pos[0], ball.pos[2]);
            if (dh > 0.001 && dh < lipOuter) {
                // Force ramps up as ball approaches hole edge, peaks at rim
                const t = 1.0 - dh / lipOuter;  // 0 at outer edge, ~1 at center
                const lipForce = GRAVITY * 2.5 * t * t;  // quadratic ramp
                ax += -(ball.pos[0] - holeX) / dh * lipForce;
                az += -(ball.pos[2] - holeZ) / dh * lipForce;
            }
        }

        ay = 0;
        ball.vel[1] = 0;
    } else {
        // Airborne — full gravity + global slope on Z
        az += GRAVITY * Math.sin(angleRad);
    }

    // Integrate velocity
    ball.vel[0] += ax * subDt;
    ball.vel[1] += ay * subDt;
    ball.vel[2] += az * subDt;

    let newX = ball.pos[0] + ball.vel[0] * subDt;
    let newY = ball.pos[1] + ball.vel[1] * subDt;
    let newZ = ball.pos[2] + ball.vel[2] * subDt;

    if (newY > ball.maxHeight) ball.maxHeight = newY;

    // Floor check
    const dhn = distToHole(newX, newZ);
    let minBallY;
    if (dhn <= HOLE_RADIUS_M + BALL_RADIUS_M * 0.5) {
        const sxzf = Math.hypot(ball.vel[0], ball.vel[2]);
        const belowf = ball.pos[1] < BALL_RADIUS_M * 0.5;
        minBallY = (sxzf < 1.45 || belowf) ? -holeDepth + BALL_RADIUS_M : getTerrainHeight(newX, newZ) + BALL_RADIUS_M;
    } else {
        minBallY = getTerrainHeight(newX, newZ) + BALL_RADIUS_M;
    }

    if (newY < minBallY) {
        if (ball.airborne && Math.abs(ball.vel[1]) > MIN_BOUNCE_VEL) {
            ball.bounceCount++;
            ball.vel[1] = -ball.vel[1] * BOUNCE_DAMPING;
            ball.vel[0] *= BOUNCE_FRICTION;
            ball.vel[2] *= BOUNCE_FRICTION;
            newY = minBallY;
        } else {
            newY = minBallY;
            ball.vel[1] = 0;
            ball.airborne = false;
        }
    }

    const distMoved = Math.hypot(newX - ball.pos[0], newZ - ball.pos[2]);
    ball.travelDist += distMoved;

    // Record speed / energy data for charts (always, so charts work when opened after shot)
    charts.speedSampleCounter++;
    if (charts.speedSampleCounter % 3 === 0) {
        const spd = Math.hypot(ball.vel[0], ball.vel[2]);
        charts.speedData.push(ball.travelDist, spd);
        if (ball.launchV0sq > 0) {
            charts.energyData.push(ball.travelDist, (spd * spd) / ball.launchV0sq);
        }
        charts.phaseData.push(ball.vel[0], ball.vel[2]);
    }

    // Metrics: speed at hole passage + lateral deviation + entry angle + line error
    if (ball.metricsShotStart) {
        const dh = distToHole(newX, newZ);
        const curSpeed = Math.hypot(ball.vel[0], ball.vel[2]);

        // Speed + line error + entry angle at closest approach to hole
        if (dh < ball.closestHoleDist) {
            ball.closestHoleDist = dh;
        } else if (ball.prevHoleDist <= ball.closestHoleDist + 0.005 && ball.speedAtHole === null) {
            // Ball just started moving away from hole → record metrics at passage
            ball.speedAtHole = curSpeed;

            // Line error: perpendicular distance from hole to trajectory at passage point
            const sx = ball.metricsShotStart.x, sz = ball.metricsShotStart.z;
            const lx = -sx, lz = -sz;
            const ll = Math.hypot(lx, lz);
            if (ll > 0.01) {
                ball.lineErrorAtHole = Math.abs(newX * lz - newZ * lx) / ll;
            }

            // Entry angle: angle between ball velocity and line ball→hole
            if (curSpeed > 0.01) {
                const toHoleX = -newX, toHoleZ = -newZ;
                const toHoleLen = Math.hypot(toHoleX, toHoleZ);
                if (toHoleLen > 0.001) {
                    const dot = (ball.vel[0] * toHoleX + ball.vel[2] * toHoleZ) / (curSpeed * toHoleLen);
                    ball.entryAngle = Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
                }
            }
        }
        ball.prevHoleDist = dh;

        // Lateral deviation from start→hole line + break apex tracking
        const sx = ball.metricsShotStart.x, sz = ball.metricsShotStart.z;
        const lx = -sx, lz = -sz;
        const lineLen = Math.hypot(lx, lz);
        if (lineLen > 0.01) {
            const cross = Math.abs((newX - sx) * lz - (newZ - sz) * lx) / lineLen;
            if (cross > ball.maxLateralDev) {
                ball.maxLateralDev = cross;
                ball.breakApexTravelDist = ball.travelDist;
            }
        }
    }

    // Ball rotation (quaternion)
    if (distMoved > 1e-6) {
        const mx = newX - ball.pos[0], mz = newZ - ball.pos[2];
        const axisVec = new THREE.Vector3(-mz / distMoved, 0, mx / distMoved);
        const rotAngle = -distMoved / BALL_RADIUS_M;
        const dq = new THREE.Quaternion().setFromAxisAngle(axisVec, rotAngle);
        ballMesh.quaternion.premultiply(dq);
        ballMesh.quaternion.normalize();
    }

    // Tunneling detection
    const oldX = ball.pos[0], oldZ = ball.pos[2];
    const segDx = newX - oldX, segDz = newZ - oldZ;
    const segLenSq = segDx * segDx + segDz * segDz;
    let closestDist;
    if (segLenSq > 1e-12) {
        const tc = Math.max(0, Math.min(1, -(oldX * segDx + oldZ * segDz) / segLenSq));
        closestDist = Math.hypot(oldX + tc * segDx, oldZ + tc * segDz);
    } else {
        closestDist = distToHole(newX, newZ);
    }

    // Commit new position
    ball.pos[0] = newX;
    ball.pos[1] = newY;
    ball.pos[2] = newZ;

    // Game mode: out of bounds check (6m from hole)
    const dthCur = distToHole(ball.pos[0], ball.pos[2]);
    if (gameCtx.state === 'moving' && dthCur > GAME_OOB_DIST) {
        ball.moving = false;
        ball.vel = [0, 0, 0];
        scoreShot(true);
        return;
    }

    // Hole capture check
    const holeBottom = -holeDepth + BALL_RADIUS_M;
    const speedXz = Math.hypot(ball.vel[0], ball.vel[2]);
    const crossedHole = closestDist <= HOLE_RADIUS_M && !ball.airborne;
    const ballDroppedIn = (dthCur <= HOLE_RADIUS_M + BALL_RADIUS_M) && ball.pos[1] < BALL_RADIUS_M * 0.5;

    // Track ball crossing hole for game lip-out detection
    if (gameCtx.state === 'moving' && (crossedHole || dthCur <= HOLE_RADIUS_M)) {
        gameCtx.crossedHole = true;
    }

    if (ballDroppedIn || dthCur <= HOLE_RADIUS_M || crossedHole) {
        if (ballDroppedIn || (!ball.airborne && speedXz < 1.45)) {
            // Captured — save state for ghost simulation before zeroing
            const ghostPos = [ball.pos[0], ball.pos[1], ball.pos[2]];
            const ghostVel = [ball.vel[0], ball.vel[1], ball.vel[2]];
            const ghostSpin = ball.spin;

            ball.moving = false;
            ball.vel = [0, 0, 0];
            if (crossedHole && dthCur > HOLE_RADIUS_M) {
                ball.pos[0] = holeX; ball.pos[2] = holeZ;
            }
            ball.pos[1] = holeBottom;
            ball.inHole = true;

            // Ghost rest position (where ball would stop without hole)
            const rest = simulateGhostRest(ghostPos, ghostVel, ghostSpin, { angleDeg: env.angleDeg, stimpM: env.stimpM });
            placeGhostCross(rest.x, rest.z);

            // Valid only if ghost would have stopped within 40cm of hole
            const ghostDist = distToHole(rest.x, rest.z);
            const validHoleIn = ghostDist <= MAX_GHOST_DIST;
            if (validHoleIn) {
                aimDot.material.color.setHex(0x1a7ae6); // blue — valid hole-in
                colorLastAimPoint(true);
            } else {
                aimDot.material.color.setHex(0xf0d259); // yellow — ball went in but too fast
                colorLastAimPoint(false);
            }

            // Game mode scoring on hole-in (only if valid)
            if (gameCtx.state === 'moving') scoreShot(false, !validHoleIn);
            else setGuide(GUIDE.IN_HOLE);
        } else if (dthCur <= HOLE_RADIUS_M) {
            // Lip-out
            ball.vel[0] *= 0.92;
            ball.vel[2] *= 0.92;
        }
    } else if (speedXz < 0.02 && !ball.airborne) {
        ball.moving = false;
        ball.vel = [0, 0, 0];
        colorLastAimPoint(false);
        // Game mode scoring on miss/near
        if (gameCtx.state === 'moving') scoreShot(false);
        else setGuide(GUIDE.AIM);
    } else {
        // Don't trace trail inside the hole
        const dTrail = distToHole(ball.pos[0], ball.pos[2]);
        if (dTrail > HOLE_RADIUS_M) {
            const trailSpd = Math.hypot(ball.vel[0], ball.vel[2]);
            const trailRatio = ball.initialSpeed > 0 ? trailSpd / ball.initialSpeed : 0;
            addTrailPoint(ball.pos[0], ball.pos[1], ball.pos[2], trailRatio);
            emitTrailParticles(ball.pos[0], ball.pos[1], ball.pos[2], trailRatio);
        }
    }

    // Break point detection (vz sign change)
    if (ball.moving && !ball.breakLocked && !ball.inHole && !ball.airborne) {
        const vz = ball.vel[2];
        if (ball.prevVz !== null) {
            if ((ball.prevVz < 0 && vz >= 0) || (ball.prevVz > 0 && vz <= 0)) {
                const denom = ball.prevVz - vz;
                const t = Math.abs(denom) > 1e-6 ? ball.prevVz / denom : 0;
                const bpx = ball.prevPosForVz[0] + (ball.pos[0] - ball.prevPosForVz[0]) * t;
                const bpz = ball.prevPosForVz[1] + (ball.pos[2] - ball.prevPosForVz[1]) * t;
                ball.breakPoints.push([[bpx, bpz], [-vz, ball.vel[0]]]);
                ball.breakLocked = true;
                rebuildBreakMarkers();
            } else if (Math.abs(vz) <= 0.01) {
                ball.breakPoints.push([[ball.pos[0], ball.pos[2]], [-vz, ball.vel[0]]]);
                ball.breakLocked = true;
                rebuildBreakMarkers();
            }
        }
        ball.prevVz = vz;
        ball.prevPosForVz = [ball.pos[0], ball.pos[2]];
    }

    } // end sub-step loop
}

// ===================================================================
// AIM UPDATE (raycast to ground plane in worldGroup local space)
// ===================================================================
const _raycaster = new THREE.Raycaster();
const _invMatrix = new THREE.Matrix4();

// ---- Place Hole mode (GLB only) ----
document.getElementById('glb-place-hole').addEventListener('click', () => {
    placingHole = !placingHole;
    document.getElementById('glb-place-hole').textContent =
        placingHole ? 'Click terrain…' : 'Place Hole';
    document.getElementById('glb-place-hole').style.color = placingHole ? '#ffe033' : '';
});

document.getElementById('glb-calibrate').addEventListener('click', calibrateGLB);

// Resolve a screen NDC coordinate to a world-space XZ position on the terrain.
// In GLB mode: raycasts against the actual mesh surface for accurate XZ.
// In procedural mode: intersects the Y=0 ground plane.
function resolveAimPoint(ndc) {
    _raycaster.setFromCamera(ndc, camera);

    if (glbCtx.mode && glbCtx.sceneRoot) {
        const hits = _raycaster.intersectObject(glbCtx.sceneRoot, true);
        if (hits.length > 0) {
            // Transform hit point from world space to worldGroup local space
            const localPt = hits[0].point.clone().applyMatrix4(_invMatrix.copy(worldGroup.matrixWorld).invert());
            return { x: localPt.x, z: localPt.z };
        }
        return null;
    }

    // Procedural mode: intersect Y=0 plane in worldGroup local space
    _invMatrix.copy(worldGroup.matrixWorld).invert();
    const origin = _raycaster.ray.origin.clone().applyMatrix4(_invMatrix);
    const dir    = _raycaster.ray.direction.clone().transformDirection(_invMatrix);
    if (Math.abs(dir.y) < 1e-10) return null;
    const t = -origin.y / dir.y;
    if (t <= 0) return null;
    return { x: origin.x + t * dir.x, z: origin.z + t * dir.z };
}

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
let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 1 / 30); // Clamp to avoid huge steps after tab switch

    // ---- Calibration animation (GLB physics calibration — marker ball rolling) ----
    if (calibAnim) {
        updateCalibAnim();
        worldGroup.rotation.x = env.angleDeg * Math.PI / 180;
        controls.update();
        renderer.render(scene, camera);
        return;
    }

    // ---- Held keys ----
    if (!gameCtx.state) {
        if (keysHeld['ArrowUp'])   env.angleDeg = Math.max(-ANGLE_MAX_DEG, env.angleDeg - ANGLE_STEP_DEG);
        if (keysHeld['ArrowDown']) env.angleDeg = Math.min(ANGLE_MAX_DEG, env.angleDeg + ANGLE_STEP_DEG);
        if (keysHeld['q'] || keysHeld['Q']) setTrueRollStrength(Math.max(0, getTrueRollStrength() - 0.1));
        if (keysHeld['w'] || keysHeld['W']) setTrueRollStrength(Math.min(4, getTrueRollStrength() + 0.1));
    }

    if (!ball.moving && ball.onCircle) {
        if (keysHeld['ArrowLeft']) {
            ball.angle += 0.035;
            ball.lastCircleAngle = ball.angle;
            updateBallOnCircle();
            clearHint();
        }
        if (keysHeld['ArrowRight']) {
            ball.angle -= 0.035;
            ball.lastCircleAngle = ball.angle;
            updateBallOnCircle();
            clearHint();
        }
    }

    // ---- Physics ----
    updatePhysics(dt);

    // ---- Aim ----
    updateAim();

    // ---- Overlay updates ----
    if (viz.flowMode === 1) {
        if (Math.abs(env.angleDeg - flowLastAngle) > 0.3 || Math.abs(env.stimpM - flowLastStimp) > 0.2) {
            rebuildFlowVisuals();
        }
        updateFlowParticles(dt);
    }
    if (viz.flowMode === 2) {
        if (Math.abs(env.angleDeg - gridFlowLastAngle) > 0.3 || Math.abs(env.stimpM - gridFlowLastStimp) > 0.2) {
            rebuildGridFlow();
        }
        updateGridFlowParticles(dt);
    }
    if (viz.flowMode === 3 && Math.abs(env.angleDeg - gradientLastAngle) > 0.3) {
        buildGradientArrows();
        gradientLastAngle = env.angleDeg;
    }
    if (Math.abs(env.angleDeg - (slopeIndicatorGroup._lastAngle || 0)) > 0.05) {
        rebuildSlopeIndicator();
        slopeIndicatorGroup._lastAngle = env.angleDeg;
    }

    // ---- World slope rotation ----
    worldGroup.rotation.x = env.angleDeg * Math.PI / 180;

    // ---- Ball mesh ----
    ballMesh.position.set(ball.pos[0], ball.pos[1], ball.pos[2]);

    // ---- Ball shadow ----
    {
        const groundY = getTerrainHeight(ball.pos[0], ball.pos[2]);
        ballShadow.position.set(ball.pos[0], groundY + 0.002, ball.pos[2]);
        const heightAbove = Math.max(0, ball.pos[1] - BALL_RADIUS_M - groundY);
        const scale = 1.0 + heightAbove * 2.0;
        ballShadow.scale.setScalar(scale);
        shadowMat.opacity = Math.max(0.08, 0.35 - heightAbove * 0.5);
        ballShadow.visible = !ball.inHole;
    }

    // ---- Aim line / dot ----
    // aimDot is red when actively aiming (new click), yellow after a shot
    aimDot.visible = true;
    aimDot.position.set(aimWorld.x, aimWorld.y + 0.02, aimWorld.z);
    if (!ball.moving) {
        aimLine.visible = true;
        const p = aimLine.geometry.attributes.position.array;
        p[0] = ball.pos[0]; p[1] = ball.pos[1]; p[2] = ball.pos[2];
        p[3] = aimWorld.x;  p[4] = aimWorld.y + 0.005; p[5] = aimWorld.z;
        aimLine.geometry.attributes.position.needsUpdate = true;
    } else {
        aimLine.visible = false;
    }

    // ---- HUD ----
    updateTrailParticles();
    updateHUD();
    drawSpeedChart();
    drawEnergyChart();
    drawPhaseChart();
    updateMetrics();

    // ---- Update green shader uniforms ----
    if (greenMaterial) {
        greenMaterial.uniforms.uViewPos.value.copy(camera.position);
        greenMaterial.uniforms.uLightPos.value.set(5, 10, 5);
    }

    // ---- Render ----
    controls.update();
    renderer.render(scene, camera);
}

// ===================================================================
// ENTRY POINT — all side-effectful initialisation in one place
// ===================================================================
function init() {
    // 1. Physics/terrain grids
    buildTrueRollGrids(null);

    // 2. Visual scene objects
    greenMesh = buildGreenMesh();
    worldGroup.add(greenMesh);
    decorGroup = buildDecor();
    holeGroup = buildHole();
    worldGroup.add(holeGroup);
    ballMesh = buildBall();
    worldGroup.add(ballMesh);
    worldGroup.add(ballShadow);
    worldGroup.add(trailGroup);

    // 3. Proper ball starting position (needs terrain height + ballMesh)
    ball.pos = [ball.circleRadius, getTerrainHeight(ball.circleRadius, 0) + BALL_RADIUS_M, 0];
    ballMesh.position.set(ball.pos[0], ball.pos[1], ball.pos[2]);

    // 4. Sync UI sliders to initial state values
    syncSlidersFromState();

    // 5. Start render loop and set welcome message
    animate();
    setGuide(GUIDE.WELCOME);
    console.log('Putting Simulator - Phase 3 loaded');
}

init();
