# Refactoring Status — STIMP/web

Objectif : rendre `main.js` (4123 lignes) maintenable et résistant aux bugs TDZ/shadowing.
Reprendre ici en cas d'arrêt.

---

## Étape 1 — ESLint [ DONE ✅ ]

### Tâches
- [x] Créer `package.json` (type: module, scripts lint/lint:fix)
- [x] Installer `eslint` + `globals`
- [x] Créer `eslint.config.js` (flat config ESLint 9, règles no-shadow / no-use-before-define / no-unused-vars)
- [x] `npm run lint` → 0 erreurs (1 warning intentionnel : gameStartPos feature "reveal" incomplète)

### Corrections apportées
- Suppression import `TR_TARGET_AMP` (jamais utilisé)
- Déplacement du chargeur EXR après la création de `renderer`
- Déclaration de `normalsVisible` déplacée avant `setHolePosition`
- Renommage locaux `aimLineGeo`/`aimLineMat` → `aimLineGeoLocal`/`aimLineMatLocal` (shadowaient les globaux)
- Déclaration `keysHeld` déplacée avant les listeners dpad
- Déclaration `placingHole` déplacée avant le handler mouseup
- Renommage `(_, iz)` / `(_, ix)` → `(_a, iz)` / `(_b, ix)` dans Array.from imbriqué
- Suppression `aimPtMatYellow` (jamais lu)
- Suppression `gradientDirty` (jamais lu)

### Fichiers créés/modifiés
- `package.json` (NEW)
- `eslint.config.js` (NEW)
- `js/main.js`

---

## Étape 2 — State grouping [ DONE ✅ ]

Regrouper les ~50 `let` globaux épars en objets cohérents déclarés avant `buildGreenMesh` :
`ball`, `env`, `glbCtx`, `gameCtx`, `charts`, `viz`

### Tâches
- [x] Déclarer les 6 objets d'état avant `// ---- Create green mesh` (ligne ~198)
- [x] Supprimer le bloc GAME STATE (angleDeg, stimpM, ballPos, ballVel, … ~40 let)
- [x] Supprimer `let normalsVisible` isolé (déplacé dans `viz`)
- [x] Supprimer `let showPhaseChart`, `let phaseData`, `let phaseV0` (déplacés dans `charts`)
- [x] Remplacer toutes les références : `ballPos` → `ball.pos`, `ballVel` → `ball.vel`, `angleDeg` → `env.angleDeg`, `stimpM` → `env.stimpM`, `glbMode` → `glbCtx.mode`, `gameState` → `gameCtx.state`, etc.
- [x] Corriger le shadow `const ball` dans `makeTree` → renommé `foliageSphere`
- [x] `npm run lint` → 0 erreurs, 0 warnings

### Corrections apportées
- Placeholder `// __STATE_OBJECTS_PLACEHOLDER__` utilisé pendant les renames pour éviter corruption des clés d'objet
- `makeBunker` : paramètre local `angleDeg` protégé avec nom temporaire `__bunkerAngle` pendant le rename global, puis restauré
- `showShotPopup` : paramètre local `maxHeightCm` restauré (faux positif du rename `maxHeight`)
- `makeTree` : `const ball` local renommé en `const foliageSphere` (no-shadow)

### Fichiers modifiés
- `js/main.js`

---

## Étape 3 — Extraction `js/glbLoader.js` [ DONE ✅ ]

Fonctions déplacées (~200 lignes) :
- `extractHeightGridFromGLB(glbCtx)`
- `applyGLBHeightVariation(glbCtx)`
- `loadGLBTerrain(file, glbCtx, { worldGroup, greenMesh, onLoaded })`

Restent dans main.js (couplées aux sliders DOM) :
- `applyGLBOffsetVisual()` / `applyGLBOffsetPhysics()`
- Handlers flip-x / flip-z (inline)

### Tâches
- [x] Créer `js/glbLoader.js` avec exports (3 fonctions)
- [x] Ajouter import dans `js/main.js`
- [x] Retirer les 3 corps de fonctions de main.js
- [x] Adapter les appels : `extractHeightGridFromGLB(glbCtx)`, `applyGLBHeightVariation(glbCtx)`, `loadGLBTerrain(file, glbCtx, { onLoaded })`
- [x] Retirer les imports devenus inutiles dans main.js (GLTFLoader, HEIGHT_SCALE, generateHeightGrid, bilinearSample, smoothGrid)
- [x] Déplacer les `const glbXSlider…` avant le listener qui les référence
- [x] `npm run lint` → 0 erreurs, 0 warnings

### Fichiers créés/modifiés
- `js/glbLoader.js` (NEW)
- `js/main.js`

---

## Étape 4 — Extraction `js/physics.js` [ DONE ✅ ]

Fonctions extraites (les 3 quasi-pures) :
- `simulateGhostRest(startPos, vel, spin, { angleDeg, stimpM })`
- `simulateTrajectory(startPos, vel, { angleDeg, stimpM, holeX, holeZ })`
- `solveHintTrajectory({ ballPos, angleDeg, stimpM, holeX, holeZ })`

Restent dans main.js (orchestrateurs trop couplés à l'UI) :
- `shoot()` — modifie ball.*, charts.*, gameCtx.*, trail, popup
- `updatePhysics(dt)` — 400 lignes, lit/écrit tout l'état

Les constantes physiques sont dupliquées dans physics.js pour l'indépendance du module.

### Tâches
- [x] Créer `js/physics.js` avec 3 exports
- [x] Importer dans main.js, retirer `simulateTrajectory` (interne à physics.js)
- [x] Supprimer les 3 corps de fonctions de main.js
- [x] Call sites mis à jour avec paramètre ctx
- [x] `npm run lint` → 0 erreurs, 0 warnings

### Fichiers créés/modifiés
- `js/physics.js` (NEW)
- `js/main.js`

---

## Étape 5 — Fonction `init()` explicite [ DONE ✅ ]

Wrapper tout le code d'initialisation de niveau module dans une fonction `init()` appelée en dernier.

### Tâches
- [x] Identifier tout le code de niveau module (hors déclarations)
- [x] Wrapper dans `function init() { … }` + appel `init()` en fin de fichier
- [x] `npm run lint` → 0 erreurs, 0 warnings

### Corrections apportées
- `buildTrueRollGrids(null)` déplacé (était ligne ~194) dans `init()`
- `let greenMesh = buildGreenMesh(); worldGroup.add(greenMesh)` → `let greenMesh;` + appel dans `init()`
- IIFE `(function buildDecor() { ... })()` convertie en fonction nommée `buildDecor()` appelée depuis `init()`
- `const holeGroup = buildHole(); worldGroup.add(holeGroup)` → `let holeGroup;` + appel dans `init()`
- `const ballMesh = buildBall(); worldGroup.add(ballMesh)` → `let ballMesh;` + appel dans `init()`
- `worldGroup.add(ballShadow)` déplacé dans `init()`
- `ball.pos = [...]` (init terrain-aware) déplacé dans `init()`
- `worldGroup.add(trailGroup)` déplacé dans `init()`
- `ballMesh.position.set(...)` (orphelin avant animate) déplacé dans `init()`
- `syncSlidersFromState()` ajouté à `init()` pour assurer la cohérence UI dès le départ
- `animate(); setGuide(GUIDE.WELCOME); console.log(...)` regroupés dans `init()`

### Fichiers modifiés
- `js/main.js`

---

## Log des actions

| Date | Action |
|------|--------|
| 2026-02-22 | Création de ce fichier de suivi |
| 2026-02-22 | Étape 1 démarrée |
| 2026-02-22 | Étape 1 terminée — 0 erreur ESLint |
| 2026-02-22 | Étape 2 démarrée |
| 2026-02-22 | Étape 2 terminée — 6 objets d'état (ball, env, glbCtx, gameCtx, charts, viz), 0 erreur ESLint |
| 2026-02-22 | Étape 3 terminée — glbLoader.js extrait (3 fonctions), 0 erreur ESLint |
| 2026-02-22 | Étape 4 terminée — physics.js extrait (3 fonctions), 0 erreur ESLint |
| 2026-02-22 | Étape 5 démarrée |
| 2026-02-22 | Étape 5 terminée — init() explicite, 0 erreur ESLint |
