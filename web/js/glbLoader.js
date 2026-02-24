import * as THREE from 'three';
import { GLTFLoader }  from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
    TR_WORLD_SIZE, TR_GRID_SIZE, HEIGHT_SCALE,
    smoothGrid, setHeightGrid, buildTrueRollGrids, generateHeightGrid, bilinearSample,
} from './terrain.js';

const _draco = new DRACOLoader();
_draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
const _gltfLoader = new GLTFLoader();
_gltfLoader.setDRACOLoader(_draco);

/**
 * Re-derive HEIGHT_GRID from the current GLB vertex positions + scene-root offset.
 * Writes glbCtx.baseHeightGrid and calls setHeightGrid().
 * @param {object} glbCtx  Shared GLB state object { sceneRoot, meshData, baseHeightGrid }
 */
export function extractHeightGridFromGLB(glbCtx) {
    const step = TR_WORLD_SIZE / (TR_GRID_SIZE - 1);
    const half = TR_WORLD_SIZE / 2;
    const offsetX = glbCtx.sceneRoot ? glbCtx.sceneRoot.position.x : 0;
    const offsetY = glbCtx.sceneRoot ? glbCtx.sceneRoot.position.y : 0;
    const offsetZ = glbCtx.sceneRoot ? glbCtx.sceneRoot.position.z : 0;
    const scaleS  = glbCtx.sceneRoot ? glbCtx.sceneRoot.scale.x   : 1;

    // Average Y per cell (avoids single outlier vertices creating artificial slopes)
    const rawSum = Array.from({ length: TR_GRID_SIZE }, () => new Array(TR_GRID_SIZE).fill(0));
    const rawCnt = Array.from({ length: TR_GRID_SIZE }, () => new Array(TR_GRID_SIZE).fill(0));
    for (const { geometry } of glbCtx.meshData) {
        const pos = geometry.attributes.position;
        for (let v = 0; v < pos.count; v++) {
            const wx = pos.getX(v) * scaleS + offsetX;
            const wy = pos.getY(v) * scaleS + offsetY;
            const wz = pos.getZ(v) * scaleS + offsetZ;
            const ix = Math.round((wx + half) / step);
            const iz = Math.round((wz + half) / step);
            if (ix >= 0 && ix < TR_GRID_SIZE && iz >= 0 && iz < TR_GRID_SIZE) {
                rawSum[iz][ix] += wy / HEIGHT_SCALE;
                rawCnt[iz][ix]++;
            }
        }
    }

    // Fill cells with no vertex data using the mean of all valid cells
    let sum = 0, count = 0;
    for (let iz = 0; iz < TR_GRID_SIZE; iz++)
        for (let ix = 0; ix < TR_GRID_SIZE; ix++)
            if (rawCnt[iz][ix] > 0) { sum += rawSum[iz][ix] / rawCnt[iz][ix]; count++; }
    const mean = count > 0 ? sum / count : 0;

    let grid = Array.from({ length: TR_GRID_SIZE }, (_a, iz) =>
        Array.from({ length: TR_GRID_SIZE }, (_b, ix) =>
            rawCnt[iz][ix] > 0 ? rawSum[iz][ix] / rawCnt[iz][ix] : mean
        )
    );

    // Smooth to reduce inter-cell noise from mesh tessellation
    grid = smoothGrid(grid, 2);

    glbCtx.baseHeightGrid = grid;
    setHeightGrid(grid);
}

/**
 * Blend GLB base heights with a procedural noise offset (used for height-variation mode).
 * @param {object} glbCtx  Shared GLB state object
 */
export function applyGLBHeightVariation(glbCtx) {
    const offsetGrid = generateHeightGrid(null);

    // New HEIGHT_GRID = base + procedural offset
    const newGrid = glbCtx.baseHeightGrid.map((row, iz) =>
        row.map((v, ix) => v + offsetGrid[iz][ix])
    );

    // Modify vertex Y of each mesh
    for (const { geometry, baseY } of glbCtx.meshData) {
        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), z = pos.getZ(i);
            const offset = bilinearSample(offsetGrid, x, z, TR_WORLD_SIZE);
            pos.setY(i, baseY[i] + offset * HEIGHT_SCALE);
        }
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
    }

    // Rebuild trueRoll grids, then restore our height grid
    buildTrueRollGrids(null);
    setHeightGrid(newGrid);
}

/**
 * Load a GLB/GLTF file, center+scale it to TR_WORLD_SIZE, add it to the scene,
 * then call onLoaded() so the caller can update UI and reset state.
 *
 * @param {File}   file      The GLB File object from an <input type="file">
 * @param {object} glbCtx   Shared GLB state object (mutated in-place)
 * @param {object} deps      { worldGroup, greenMesh, onLoaded }
 *   - worldGroup  THREE.Group  Scene group to add the GLB mesh into
 *   - greenMesh   THREE.Mesh   Procedural green mesh to hide after load
 *   - onLoaded    function     Called when loading+setup is complete
 */
export function loadGLBTerrain(file, glbCtx, { worldGroup, greenMesh, onLoaded }) {
    const url = URL.createObjectURL(file);
    _gltfLoader.load(url, (gltf) => {
        URL.revokeObjectURL(url);

        // Collect all meshes with valid position attributes, bake world transforms
        const meshes = [];
        gltf.scene.updateWorldMatrix(true, true);
        gltf.scene.traverse(o => {
            if (!o.isMesh || !o.geometry?.attributes?.position) return;
            const geo = o.geometry.clone();
            geo.applyMatrix4(o.matrixWorld);
            meshes.push({ geo, material: o.material });
        });
        if (meshes.length === 0) return;

        // Compute global bounding box (X, Y, Z) across all meshes
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const { geo } of meshes) {
            geo.computeBoundingBox();
            const bb = geo.boundingBox;
            minX = Math.min(minX, bb.min.x); maxX = Math.max(maxX, bb.max.x);
            minY = Math.min(minY, bb.min.y); maxY = Math.max(maxY, bb.max.y);
            minZ = Math.min(minZ, bb.min.z); maxZ = Math.max(maxZ, bb.max.z);
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;  // center Y to eliminate boundary artifacts
        const cz = (minZ + maxZ) / 2;
        const scaleXZ = TR_WORLD_SIZE / Math.max(maxX - minX, maxZ - minZ);

        // Center X, Y, Z and scale all meshes; store baseY for height-variation
        glbCtx.meshData = [];
        for (const { geo } of meshes) {
            const pos = geo.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                pos.setX(i, (pos.getX(i) - cx) * scaleXZ);
                pos.setY(i, (pos.getY(i) - cy) * scaleXZ);
                pos.setZ(i, (pos.getZ(i) - cz) * scaleXZ);
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();
            const baseY = new Float32Array(pos.count);
            for (let i = 0; i < pos.count; i++) baseY[i] = pos.getY(i);
            glbCtx.meshData.push({ geometry: geo, baseY });
        }

        // Auto-detect downward-facing mesh: if average vertex normal Y < 0,
        // winding is clockwise (viewed from above). Fix by flipping triangle winding
        // so normals point up — WITHOUT negating Y (negating inverts HEIGHT_GRID
        // and reverses slope forces).
        {
            let sumNY = 0, cntN = 0;
            for (const { geometry } of glbCtx.meshData) {
                const norm = geometry.attributes.normal;
                for (let i = 0; i < norm.count; i++) sumNY += norm.getY(i);
                cntN += norm.count;
            }
            if (cntN > 0 && sumNY / cntN < 0) {
                for (const { geometry, baseY } of glbCtx.meshData) {
                    if (geometry.index) {
                        const idx = geometry.index;
                        for (let i = 0; i < idx.count; i += 3) {
                            const t = idx.getX(i + 1);
                            idx.setX(i + 1, idx.getX(i + 2));
                            idx.setX(i + 2, t);
                        }
                        idx.needsUpdate = true;
                    } else {
                        // Non-indexed: swap vertex 1 and 2 of each triangle
                        const pos = geometry.attributes.position;
                        for (let i = 0; i < pos.count; i += 3) {
                            const x1 = pos.getX(i+1), y1 = pos.getY(i+1), z1 = pos.getZ(i+1);
                            pos.setXYZ(i+1, pos.getX(i+2), pos.getY(i+2), pos.getZ(i+2));
                            pos.setXYZ(i+2, x1, y1, z1);
                        }
                        pos.needsUpdate = true;
                        // Sync baseY after vertex reorder
                        for (let i = 0; i < pos.count; i++) baseY[i] = pos.getY(i);
                    }
                    geometry.computeVertexNormals();
                }
            }
        }

        // Remove old GLB scene if any
        if (glbCtx.sceneRoot) worldGroup.remove(glbCtx.sceneRoot);

        // Build new scene root from baked geometries
        glbCtx.sceneRoot = new THREE.Group();
        for (let i = 0; i < meshes.length; i++) {
            const mesh = new THREE.Mesh(glbCtx.meshData[i].geometry, meshes[i].material);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            glbCtx.sceneRoot.add(mesh);
        }
        worldGroup.add(glbCtx.sceneRoot);

        // Hide procedural green mesh
        greenMesh.visible = false;

        glbCtx.mode = true;

        // Extract HEIGHT_GRID, rebuild trueRoll grids
        extractHeightGridFromGLB(glbCtx);
        buildTrueRollGrids(null);
        setHeightGrid(glbCtx.baseHeightGrid);

        onLoaded();
    },
    undefined,
    (err) => { URL.revokeObjectURL(url); console.error('GLB load error:', err); onLoaded(err); });
}
