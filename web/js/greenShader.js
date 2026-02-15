// Custom ShaderMaterial for organic green with procedural grass
// Ported from golf_green.html's GLSL shaders, scaled for 12m world

import * as THREE from 'three';

const vertexShader = /* glsl */ `
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;
    varying float vLocalHeight;

    void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vLocalHeight = position.y;  // terrain height before worldGroup rotation
        gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
`;

const fragmentShader = /* glsl */ `
    precision highp float;

    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;
    varying float vLocalHeight;

    uniform vec3 uLightPos;
    uniform vec3 uViewPos;
    uniform vec4 uShapeSeedA;
    uniform vec4 uShapeSeedB;
    uniform float uSlopeAmplify;
    uniform float uEnDiffuse;
    uniform float uEnAmbient;
    uniform float uEnSpecular;
    uniform float uEnFresnel;

    // Scale factor: 60m world → 12m world
    const float S = 0.4;

    // ---- Noise ----
    float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        f = f * f * (3.0 - 2.0 * f);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // ---- Heightmap for normal perturbation ----
    float heightMap(vec2 uv) {
        float h = noise(uv * 3.0) * 0.3;
        h += noise(uv * 6.0) * 0.2;
        h += noise(uv * 50.0) * 0.1;
        h += noise(uv * 100.0) * 0.05;
        return h;
    }

    vec3 getNormal(vec2 uv) {
        float epsilon = 0.001;
        float h0 = heightMap(uv);
        float hx = heightMap(uv + vec2(epsilon, 0.0));
        float hy = heightMap(uv + vec2(0.0, epsilon));
        return normalize(vec3(
            (h0 - hx) * 50.0,
            epsilon,
            (h0 - hy) * 50.0
        ));
    }

    // ---- Procedural grass color driven by terrain elevation ----
    vec3 grassColor(vec2 uv, float elevation) {
        vec3 grassDark      = vec3(0.22, 0.26, 0.12);
        vec3 grassMid       = vec3(0.30, 0.36, 0.15);
        vec3 grassLight     = vec3(0.36, 0.42, 0.18);
        vec3 grassVeryLight = vec3(0.40, 0.46, 0.20);

        // Elevation drives the main tone (remap from typical range to 0..1)
        // HEIGHT_SCALE=0.02, TARGET_AMP=0.1 → heights roughly -0.002..+0.002
        float elevNorm = clamp(elevation * 250.0 + 0.5, 0.0, 1.0);

        // Add a touch of noise so it's not purely banded
        float detailNoise = noise(uv * 8.0) * 0.12 + noise(uv * 15.0) * 0.08;
        float mainZone = clamp(elevNorm + detailNoise - 0.1, 0.0, 1.0);

        vec3 color;
        if (mainZone < 0.3) {
            color = mix(grassDark, grassMid, mainZone / 0.3);
        } else if (mainZone < 0.6) {
            color = mix(grassMid, grassLight, (mainZone - 0.3) / 0.3);
        } else {
            color = mix(grassLight, grassVeryLight, (mainZone - 0.6) / 0.4);
        }

        // Fine grain for grass blade texture
        float finDetail   = noise(uv * 80.0) * 0.2 + noise(uv * 120.0) * 0.15;
        float microDetail = noise(uv * 300.0) * 0.08;
        color += (finDetail + microDetail) * 0.015;

        return color;
    }

    // ---- SDF for organic shape (scaled for 12m world) ----
    float sdEllipse(vec2 p, vec2 r) {
        vec2 q = p / r;
        return length(q) - 1.0;
    }

    mat2 rot2(float a) {
        float s = sin(a), c = cos(a);
        return mat2(c, -s, s, c);
    }

    float greenSignedDistance(vec2 p) {
        float a0 = mix(-0.18, 0.22, uShapeSeedA.x);
        float a1 = mix(-0.45, -0.05, uShapeSeedA.y);
        float a2 = mix(0.08, 0.55, uShapeSeedA.z);

        vec2 o1 = vec2(mix(2.8, 6.2, uShapeSeedA.w), mix(-3.2, -0.6, uShapeSeedB.x)) * S;
        vec2 o2 = vec2(mix(-6.0, -2.6, uShapeSeedB.y), mix(0.8, 3.8, uShapeSeedB.z)) * S;

        vec2 p0 = rot2(a0) * p;
        vec2 p1 = rot2(a1) * (p - o1);
        vec2 p2 = rot2(a2) * (p - o2);

        vec2 rMain = vec2(mix(10.5, 15.5, uShapeSeedB.w), mix(8.2, 11.8, uShapeSeedA.x)) * S;
        vec2 rL1   = vec2(mix(4.2, 7.0, uShapeSeedA.y),   mix(3.4, 5.6, uShapeSeedA.z)) * S;
        vec2 rL2   = vec2(mix(4.0, 6.8, uShapeSeedB.x),   mix(3.0, 5.0, uShapeSeedB.y)) * S;

        float dMain  = sdEllipse(p0, rMain);
        float dLobe1 = sdEllipse(p1, rL1);
        float dLobe2 = sdEllipse(p2, rL2);

        float d = min(dMain, min(dLobe1, dLobe2));

        // Edge noise (frequencies scaled up, amplitude scaled down)
        float edgeF1  = mix(0.16, 0.32, uShapeSeedA.w) / S;
        float edgeF2  = mix(0.36, 0.62, uShapeSeedB.z) / S;
        float edgeAmp = mix(0.22, 0.62, uShapeSeedB.w) * S;
        float edgeNoise = noise(p * edgeF1 + uShapeSeedA.xy * 3.0) * 0.6
                        + noise(p * edgeF2 + uShapeSeedB.xy * 5.0) * 0.35;
        d += (edgeNoise - 0.45) * edgeAmp;
        return d;
    }

    void main() {
        vec2 ground = vWorldPosition.xz;
        float greenSd = greenSignedDistance(ground);

        // Discard pixels outside the organic green shape
        if (greenSd > 0.0) {
            discard;
        }

        // UV scaled for 12m world — multiply by 2.5 so noise frequencies
        // produce fine grain comparable to golf_green.html's 60m world
        vec2 uv = vWorldPosition.xz * 2.5;

        vec3 grassCol = grassColor(uv, vLocalHeight);

        // Amplify terrain slope so height variations are visible in lighting
        vec3 terrainN = vWorldNormal;
        terrainN.xz *= uSlopeAmplify;
        terrainN = normalize(terrainN);

        // Perturbed normal for grass blade relief
        vec3 perturbedNormal = getNormal(uv);
        vec3 finalNormal = normalize(mix(terrainN, perturbedNormal, 0.35));

        // Lighting — directional (parallel rays, like sun)
        vec3 lightDir = normalize(uLightPos);
        vec3 viewDir  = normalize(uViewPos - vWorldPosition);
        vec3 halfDir  = normalize(lightDir + viewDir);

        // Diffuse
        float diff = max(dot(finalNormal, lightDir), 0.0);
        vec3 diffuse = diff * grassCol * vec3(1.0, 1.0, 0.98);

        // Ambient
        vec3 ambient = grassCol * uEnAmbient;

        // Specular with wetness variation
        float wetness = 0.55 + noise(uv * 10.0) * 0.35;
        float shininess = mix(18.0, 42.0, wetness);
        float spec = pow(max(dot(finalNormal, halfDir), 0.0), shininess);
        vec3 specular = spec * vec3(0.82, 0.85, 0.72) * (0.32 * wetness);

        // Fresnel
        float fresnel = pow(1.0 - max(dot(viewDir, finalNormal), 0.0), 3.0);
        vec3 fresnelSpecular = fresnel * vec3(0.68, 0.74, 0.60) * (0.22 * wetness);

        // Height-based self-occlusion
        float heightShadow = heightMap(uv);
        heightShadow = mix(0.95, 1.0, heightShadow);

        // Collar — slightly darker near the edge
        float edgeBand = smoothstep(-1.0, -0.1, greenSd);
        vec3 collarTint = mix(vec3(0.86, 0.90, 0.82), vec3(1.0), edgeBand);

        vec3 finalColor = (ambient + diffuse * uEnDiffuse + specular * uEnSpecular + fresnelSpecular * uEnFresnel) * heightShadow * collarTint;

        // Light fog for depth
        float fog = 1.0 - length(vWorldPosition) * 0.02;
        finalColor = mix(vec3(0.0), finalColor, clamp(fog, 0.0, 1.0));

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

/**
 * Create the custom green ShaderMaterial.
 */
export function createGreenMaterial(seedA, seedB) {
    return new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            uLightPos:     { value: new THREE.Vector3(5, 10, 5) },
            uViewPos:      { value: new THREE.Vector3(0, 5, 10) },
            uShapeSeedA:   { value: new THREE.Vector4(seedA[0], seedA[1], seedA[2], seedA[3]) },
            uShapeSeedB:   { value: new THREE.Vector4(seedB[0], seedB[1], seedB[2], seedB[3]) },
            uSlopeAmplify: { value: 20.0 },
            uEnDiffuse:    { value: 1.0 },
            uEnAmbient:    { value: 0.45 },
            uEnSpecular:   { value: 1.0 },
            uEnFresnel:    { value: 1.0 },
        },
        side: THREE.DoubleSide,
    });
}
