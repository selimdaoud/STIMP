# Architecture — STIMP/web

Simulateur de putting en navigateur, pur ES Modules natifs (pas de bundler).
Three.js est chargé via CDN + import map défini dans `index.html`.

---

## 1. Vue d'ensemble

```
index.html
  └── <script type="module" src="js/main.js">
        ├── imports terrain.js     (grilles de hauteur + physique terrain)
        ├── imports greenShape.js  (SDF de la forme du green)
        ├── imports greenShader.js (ShaderMaterial GLSL du gazon)
        ├── imports glbLoader.js   (chargement de terrain GLB/GLTF)
        └── imports physics.js     (simulations de trajectoire)
```

Le navigateur résout les imports ES Module directement : aucun `npm run build`,
aucun Webpack/Vite. Le code tourne tel quel.

---

## 2. Les six fichiers JS

### `js/terrain.js` — 147 lignes
**Rôle :** générer et interroger la géométrie physique du terrain.

Expose une grille `HEIGHT_GRID` (50×50 valeurs) qui encode l'élévation en mètres
de chaque point du monde 12 m × 12 m.

| Export | Description |
|--------|-------------|
| `buildTrueRollGrids(seed)` | Génère HEIGHT_GRID + deux grilles TRUE_ROLL_AX/AY (biais de roulis aléatoires). Appelé depuis `init()` et `resetBall(newTerrain=true)`. |
| `setHeightGrid(grid)` | Injecte une grille externe (cas GLB). |
| `generateHeightGrid(seed)` | Génère une grille procédurale sans la stocker (utilisé par glbLoader pour le mode height-variation). |
| `getTerrainHeight(x, z)` | Hauteur interpolée bilinéairement en un point XZ quelconque. |
| `getTerrainNormal(x, z)` | Normale de surface au point XZ (différences finies sur getTerrainHeight). |
| `trueRollAccel(x, z, vx, vz)` | Accélération parasite de roulis vrai : simule l'imprévisibilité d'un vrai green à haute vitesse. |
| `smoothGrid / bilinearSample` | Utilitaires de traitement de grille. |

**Constantes clés :**
- `TR_GRID_SIZE = 50` : résolution de la grille
- `TR_WORLD_SIZE = 12.0` : taille du monde en mètres
- `HEIGHT_SCALE = 0.01` : facteur m/unité pour les hauteurs GLB

---

### `js/greenShape.js` — 118 lignes
**Rôle :** définir la **forme organique** du green via un SDF (Signed Distance Field).

La forme est une union de 3 ellipses rotées + bruit de bord, paramétrée par
8 scalaires aléatoires (`shapeSeedA[4]`, `shapeSeedB[4]`). Ces seeds sont
régénérées à chaque nouveau terrain.

| Export | Description |
|--------|-------------|
| `generateShapeSeeds()` | Tire 8 nouveaux nombres aléatoires → nouvelle forme. |
| `getShapeSeeds()` | Retourne les seeds courants (copiés dans le ShaderMaterial GLSL). |
| `greenSignedDistance(x, z)` | Retourne < 0 si (x, z) est dans le green, > 0 sinon. Utilisé par buildGreenMesh pour inclure/exclure les quads, et par physics.js pour détecter la sortie de balle. |
| `greenBoundingRadius()` | Rayon approx. du green (pour les besoins du HUD). |

**Important :** la même formule SDF existe en doublon en GLSL dans `greenShader.js`
pour que le fragment shader puisse `discard` les pixels hors-green pixel-perfect,
indépendamment du maillage.

---

### `js/greenShader.js` — 244 lignes
**Rôle :** le `ShaderMaterial` Three.js qui peint le gazon.

Exporte une seule fonction `createGreenMaterial(seedA, seedB)` qui retourne un
`THREE.ShaderMaterial` avec deux shaders GLSL intégrés :

**Vertex shader :**
- Passe la position monde et la normale monde au fragment.
- Passe `vLocalHeight` (hauteur avant rotation de la pente) pour colorer
  les hauts vs. les bas du terrain.

**Fragment shader :**
- Évalue le SDF (même code que `greenShape.js`) et fait `discard` si > 0.
- Calcule la couleur herbe procédurale : 4 tons de vert modulés par
  l'élévation, le bruit fin, et les **bandes de tonte** (sinus sur X monde).
- Applique un éclairage Blinn-Phong : diffus + ambiant + spéculaire + Fresnel.
- Ajoute un **assombrissement de frange** près du bord du SDF.

Les seeds de forme sont passés comme uniforms `uShapeSeedA` / `uShapeSeedB`
(vec4) pour que le shader et le CPU voient exactement la même forme.

---

### `js/glbLoader.js` — 211 lignes
**Rôle :** charger un fichier GLB/GLTF utilisateur et en extraire la physique.

| Export | Description |
|--------|-------------|
| `loadGLBTerrain(file, glbCtx, { worldGroup, greenMesh, onLoaded })` | Charge le GLB, bake les transforms monde, centre et met à l'échelle dans les 12 m, détecte et corrige les normales inversées, appelle `onLoaded()`. |
| `extractHeightGridFromGLB(glbCtx)` | Rasterise les vertices du GLB sur la grille 50×50 pour en dériver `HEIGHT_GRID`. Stocke dans `glbCtx.baseHeightGrid`. |
| `applyGLBHeightVariation(glbCtx)` | Ajoute une perturbation procédurale aux hauteurs de base du GLB (pour la variété), met à jour les vertices et HEIGHT_GRID. |

**Flux GLB :**
```
Fichier .glb
  → GLTFLoader.load()
  → applyMatrix4 (bake transform)
  → centrage + mise à l'échelle (→ 12 m)
  → détection normales inversées → flip winding
  → ajout dans worldGroup
  → extractHeightGridFromGLB → HEIGHT_GRID
  → buildTrueRollGrids(null)  ← recalcule le roulis vrai
  → onLoaded()                ← main.js met à jour l'UI
```

---

### `js/physics.js` — 250 lignes
**Rôle :** les trois simulations de trajectoire pures (sans effet de bord UI).

Fonctionne en mode headless : pas d'import Three.js, aucun accès à l'état global.
Toutes les données nécessaires sont passées en paramètre.

| Export | Description |
|--------|-------------|
| `simulateGhostRest(startPos, startVel, startSpin, { angleDeg, stimpM })` | Simule la balle jusqu'à l'arrêt, **sans** trou. Retourne `{ x, z }` la position finale. Sert à afficher le **ghost ball** (où la balle s'arrêterait sans le trou). |
| `simulateTrajectory(startPos, vel, { angleDeg, stimpM, holeX, holeZ })` | Simule un coup complet avec gravité de lèvre de trou. Retourne `{ path, hitHole, holeSpeed, minDistToHole }`. Utilisé en interne par `solveHintTrajectory`. |
| `solveHintTrajectory({ ballPos, angleDeg, stimpM, holeX, holeZ })` | Brute-force sur 360 directions × 18 itérations de recherche binaire pour trouver le coup qui rentre dans le trou à la vitesse la plus basse (la plus sûre). Retourne le meilleur chemin ou `null`. |

**Intégrateur physique (commun aux deux simulations) :**
```
Pour chaque pas dt = 1/120 s :
  1. Détection sol (airborne ou non)
  2. Si au sol :
     a. Friction de stimp : F = μ·g·|Ny| · (1 + spin·0.15)
     b. Composante de pente : F = g·sin(angleDeg) · 5/7
     c. Normale terrain : accélération latérale
     d. True Roll : perturbation aléatoire spatiale
     e. [simulateTrajectory seulement] Gravité de lèvre de trou
  3. Si airborne : seule la gravité + composante de pente
  4. Intégration Euler : vel += acc·dt, pos += vel·dt
  5. Collision sol (bounce ou pose)
  6. Sortie si hors-green (SDF > 0) ou trou touché
```

---

### `js/main.js` — 3720 lignes
**Rôle :** orchestrateur. Tout le reste est câblé ici.

#### Structure interne (dans l'ordre du fichier)

```
 Lignes    Section
─────────  ──────────────────────────────────────────────────────────────
    1–15   Imports (Three.js + modules locaux)
   17–56   Constantes physiques, UI, gameplay
   58–72   Fonctions utilitaires (stimpToMu, getGradientAt)
   74–191  Setup Three.js niveau module :
             scene, camera, renderer → DOM
             EXRLoader (environnement IBL)
             Sky atmosphérique (shader Three.js)
             Nuages procéduraux (ShaderMaterial inline)
             Lumières (AmbientLight + DirectionalLight + ombres)
             worldGroup (groupe qui tourne pour la pente)
             OrbitControls
  193–230  Objets d'état global (6 objets const)
  232–237  holeX/holeZ + distToHole()
  239–295  buildGreenMesh() — maillage triangulé du green (SDF-guided)
  297      let greenMesh  ← déclaration (assigné dans init())
  302–408  buildDecor()   — sol rough, bunkers, cart path, arbres, shadow plane
  411–464  buildHole()    — cylindre + rebord + fond du trou
  466      let holeGroup  ← déclaration
  469–475  setHolePosition(x, z)
  478–516  buildBall()    — sphère blanche + rayures rouges + halo glow
  514      let ballMesh   ← déclaration
  516–522  Ombre au sol (shadowGeo + shadowMat + ballShadow)
  523–536  aimWorld, mouseNDC, aimLocked, shotAimPoints
  544–556  GAME_OOB_DIST, GAME_HOLES (9 trous préconfigurés)
  558–608  Trail system (buffers pré-alloués de 5000 points, segments)
  610–700  Fonctions trail (addTrailPoint, newTrailSegment, clearAllTrails…)
  700–900  Visualisations flow (flèches de gradient, lignes de flux, contours)
  900–1100 Hint line (ligne de visée recommandée par solveHintTrajectory)
 1100–1400 Ghost ball + ghost marker (point fantôme post-coup)
 1400–1600 Aim point markers, break markers, normals helper
 1600–1900 Keyboard + dpad UI, setGuide(), clearGuide(), updateHUD()
 1943–2200 Graphiques Canvas 2D (vitesse, énergie, plan de phase)
 2200–2440 Métriques de tir, shot popup, score sheet overlay
 2440–2580 Keyboard listeners (keydown/keyup/keysHeld)
 2580–2640 Sliders (angle, stimp, true roll, distance, position, launch)
 2645–2780 Boutons (shoot, hint, flow, action-btns, GLB position)
 2780–2870 Touch events (tap pour viser, drag cam)
 2875–3070 Mode jeu (startGame, setupHole, scoreShot, endGame, exitGame)
 3072–3147 shoot() — initialise un coup depuis l'état courant
 3149–3207 resetBall(newTerrain) — replace la balle, optionnellement régénère
 3207–3217 updateBallOnCircle() — rotation de la balle sur son orbite initiale
 3217–3510 updatePhysics(dt) — moteur de simulation principale (~300 lignes)
 3510–3568 Raycaster (GLB place-hole), resolveAimPoint(), updateAim()
 3568–3575 Resize listener
 3578–3687 animate() — boucle RAF : physique → rendu → HUD
 3689–3720 init() + init() ← point d'entrée unique
```

---

## 3. Les 6 objets d'état global

Déclarés en tête de `main.js` (lignes 196–230), avant tout code qui les référence.

```js
const ball = {
    pos, vel,            // position [x,y,z] et vitesse [vx,vy,vz]
    moving, onCircle,    // flags d'état de mouvement
    airborne, inHole,    // flags de contact
    angle, circleRadius, // orbite initiale autour du trou
    spin,                // spin au lancement (dérive de la friction)
    travelDist, maxHeight, bounceCount,
    // Métriques post-coup :
    speedAtHole, maxLateralDev, lineErrorAtHole, entryAngle,
    breakPoints, breakLocked,   // points de cassure de la balle
    closestHoleDist, prevHoleDist,
};

const env = {
    angleDeg,       // inclinaison globale du green (°)
    stimpM,         // viteur Stimpmètre (m)
    launchAngleDeg, // angle de lancement vertical (°)
};

const glbCtx = {
    mode,            // true si un GLB est chargé
    sceneRoot,       // THREE.Group racine du GLB
    meshData,        // [{ geometry, baseY }] données de vertex
    baseHeightGrid,  // grille de hauteur extraite du GLB
};

const gameCtx = {
    state,      // null | 'putting' | 'moving' | 'scored'
    holeIndex,  // trou courant (0–8)
    score,      // strokes total
    scores,     // tableau par trou
    crossedHole, startPos,
};

const charts = {
    speedData, energyData, phaseData,  // données brutes des graphiques
    speedSampleCounter, phaseV0,
    showSpeed, showEnergy, showPhase,  // visibilité des panels
};

const viz = {
    flowMode,       // 0=off 1=flux 2=grille 3=gradient 4=contours
    normalsVisible, // affichage des normales terrain
    showHelp,       // panneau d'aide clavier
};
```

---

## 4. Cycle de vie d'un coup

```
[Balle sur cercle → joueur clique → aimWorld mis à jour]
         ↓
    shoot()
      • calcule vel[0,1,2] depuis aimWorld et env.stimpM/launchAngleDeg
      • ball.moving = true, ball.onCircle = false
      • ouvre un nouveau segment de trail
         ↓
    animate() → updatePhysics(dt) chaque frame
      • intégrateur Euler (friction, pente, trueRoll, lipGravity)
      • détection trou → ball.inHole, scoreShot()
      • détection stop → resetBall() ou guide
         ↓
    scoreShot() [mode jeu uniquement]
      • évalue OOB, trop rapide, ou dedans
      • gameCtx.score++, transition vers trou suivant ou fin
```

---

## 5. La boucle `animate()`

```
requestAnimationFrame(animate)
  │
  ├── dt = (now - lastTime) / 1000   (clampé à 1/30 s)
  │
  ├── Touches maintenues → env.angleDeg, trueRollStrength
  │
  ├── Si ball.moving  → updatePhysics(dt)
  │   Sinon           → updateBallOnCircle() + updateAim()
  │
  ├── worldGroup.rotation.x = angleDeg  (tilt visuel de la pente)
  ├── ballMesh.position ← ball.pos
  ├── ballShadow ← position sol + scale selon hauteur
  ├── aimLine / aimDot
  │
  ├── updateTrailParticles()
  ├── updateHUD()
  ├── drawSpeedChart() / drawEnergyChart() / drawPhaseChart()
  ├── updateMetrics()
  │
  └── renderer.render(scene, camera)
```

---

## 6. Mode GLB vs. mode procédural

| | Mode procédural | Mode GLB |
|---|---|---|
| Terrain visuel | `greenMesh` (maillage SDF triangulé) | `glbCtx.sceneRoot` (meshes GLB) |
| Terrain physique | `HEIGHT_GRID` généré par bruit | `HEIGHT_GRID` rasterisé depuis les vertices GLB |
| Forme du green | SDF organique aléatoire | Bounding box du GLB (rectangle de sécurité) |
| Nouveau terrain | `resetBall(true)` → `buildTrueRollGrids + buildGreenMesh` | `applyGLBHeightVariation` (même maillage, hauteurs perturbées) |
| Trou | Centré à (0,0) par défaut | Positionnable via raycaster (bouton "Place Hole") |

---

## 7. Dépendances entre modules

```
main.js
  ↓ lit/écrit  terrain.js (HEIGHT_GRID, trueRoll)
  ↓ lit        greenShape.js (seeds, SDF pour buildGreenMesh)
  ↓ lit        greenShader.js (ShaderMaterial)
  ↓ délègue à  glbLoader.js (chargement + extraction HEIGHT_GRID)
  ↓ délègue à  physics.js (simulations ghost + hint)

glbLoader.js
  ↓ lit/écrit  terrain.js (setHeightGrid, buildTrueRollGrids, bilinearSample…)

physics.js
  ↓ lit        terrain.js (getTerrainHeight, getTerrainNormal, trueRollAccel)
  ↓ lit        greenShape.js (greenSignedDistance — détection sortie de balle)
```

`physics.js` et `glbLoader.js` n'importent pas `main.js` → pas de cycle.

---

## 8. Points d'entrée dans le code

| Je veux comprendre… | Lire… |
|---|---|
| Comment la balle roule | `updatePhysics(dt)` — main.js l. 3217 |
| Comment le coup est initié | `shoot()` — main.js l. 3075 |
| Comment la hint line est calculée | `solveHintTrajectory()` — physics.js l. 205 |
| Comment le terrain est généré | `buildTrueRollGrids()` — terrain.js l. 111 |
| Comment le green est peint | vertex/fragment shaders — greenShader.js l. 6–222 |
| Comment un GLB est chargé | `loadGLBTerrain()` — glbLoader.js l. 98 |
| Comment le mode jeu fonctionne | `startGame / setupHole / scoreShot` — main.js l. 2897 |
| L'ordre de démarrage complet | `init()` — main.js l. 3692 |

---

## 9. Panels et labels de l'interface (index.html)

### HUD principal (`#hud`) — toujours visible
| ID | Type | Contenu / Rôle |
|---|---|---|
| `#stats` | `<div>` | Télémétrie en temps réel : vitesse, hauteur, distance au trou, bearing, spin. Mis à jour chaque frame par `updateHUD()`. |
| `#message` | `<div>` | Message plein-écran animé ("IN THE HOLE!", etc.). |
| `#guide` | `<div>` | Bulle d'aide contextuelle (ex. "Cliquez pour viser"). Contrôlée par `setGuide() / clearGuide()`. |
| `#help` | `<div>` | Liste des raccourcis clavier. Affiché/caché par `viz.showHelp`. Masqué sur écran tactile. |

### Boutons d'action flottants
| ID | Type | Contenu / Rôle |
|---|---|---|
| `#shoot-btn` | `<button>` | Cercle **SHOOT** en bas à droite. Déclenche `shoot()`. |
| `#hint-btn` | `<button>` | **HINT** — visible uniquement en mode jeu. Lance `solveHintTrajectory()` et affiche la hint line. |
| `#flow-btn` | `<button>` | **Flow** — visible uniquement en mode jeu. Cycle les modes de visualisation de flux (`viz.flowMode`). |
| `#game-exit-live` | `<button>` | **Exit Game** — visible en mode jeu. Appelle `exitGame()`. |

### Panel boutons d'action (`#action-btns`) — bas gauche, mode libre
| Bouton | Rôle |
|---|---|
| Reset | `resetBall(false)` — remet la balle sans régénérer le terrain |
| Load GLB | Ouvre le file-picker (`#glb-file-input`) pour charger un `.glb` |
| New Terrain | `resetBall(true)` — régénère un nouveau green procédural |
| Flow | Cycle `viz.flowMode` (flux / grille / gradient / contours) |
| Camera | Réinitialise la caméra à sa position par défaut |
| Velocity Profile | Affiche/cache le canvas `#speed-chart` |
| Energy Budget | Affiche/cache le canvas `#energy-chart` |
| Phase Space | Affiche/cache le canvas `#phase-chart` |
| Normals | Affiche/cache les normales terrain (`viz.normalsVisible`) |
| Play | Lance le mode jeu (`startGame()`) |

### D-pad (`#dpad`) — bas centre
| ID / Bouton | Rôle |
|---|---|
| ▲ slope | Augmente `env.angleDeg` (slope) |
| ▼ slope | Diminue `env.angleDeg` |
| ◄ pos | Déplace la balle vers la gauche (orbite) |
| ► pos | Déplace la balle vers la droite (orbite) |
| − dist | Réduit le rayon de l'orbite (`ball.circleRadius`) |
| + dist | Augmente le rayon de l'orbite |
| `#dpad-dist-label` | Affiche la distance courante en mètres |

### Canvases 2D (graphiques)
| ID | Position | Contenu |
|---|---|---|
| `#speed-chart` | Haut gauche, masqué par défaut | Profil de vitesse en fonction du temps. Dessiné par `drawSpeedChart()`. |
| `#energy-chart` | Haut droit, masqué par défaut | Budget énergétique (cinétique + potentiel). Dessiné par `drawEnergyChart()`. |
| `#phase-chart` | Centre haut, masqué par défaut | Plan de phase vitesse × distance. Dessiné par `drawPhaseChart()`. |

### Panel métriques (`#metrics-panel`) — gauche, repliable
| ID | Label affiché | Valeur |
|---|---|---|
| `#m-to-hole` | To hole | Distance balle→trou au moment du tir |
| `#m-init-speed` | Init speed | Vitesse initiale au tir (m/s) |
| `#m-speed-hole` | Speed @ hole | Vitesse à l'entrée du trou (m/s) |
| `#m-final-dist` | Final dist | Distance finale balle→trou à l'arrêt (cm) |
| `#m-max-break` | Max break | Déviation latérale maximale (cm) |
| `#m-break-apex` | Break apex | Distance parcourue au point de break maximal (m) |
| `#m-line-error` | Line error @ hole | Erreur de ligne au niveau du trou (cm) |
| `#m-entry-angle` | Entry angle | Angle d'entrée dans le trou (°) |
| `#metrics-toggle` | `<button>` | Replie/déplie le panel métriques |

### Panels de réglage (`#panels-container`) — droite, tous repliables

#### Panel GREEN (`#panel-green`)
| ID slider | ID valeur | Label | Plage |
|---|---|---|---|
| `#sl-angle` | `#val-angle` | Slope | –5 ° … +5 ° |
| `#sl-stimp` | `#val-stimp` | Stimp | 4 … 14 |
| `#sl-troll` | `#val-troll` | True Roll | 0 … 1 |
| `#sl-dist` | `#val-dist` | Distance | min … max (m) |
| `#sl-pos` | `#val-pos` | Position | 0 … 360 ° |
| `#sl-launch` | `#val-launch` | Launch | 0 … 30 ° |

#### Panel LIGHT (`#panel-lighting`)
| ID slider | ID valeur | Label |
|---|---|---|
| `#ld-diffuse` | `#ld-v-diffuse` | Diffuse |
| `#ld-ambient` | `#ld-v-ambient` | Ambient |
| `#ld-specular` | `#ld-v-specular` | Specular |
| `#ld-fresnel` | `#ld-v-fresnel` | Fresnel |
| `#ld-slope` | `#ld-v-slope` | Slope |
| `#ld-dirlight` | `#ld-v-dirlight` | DirLight |

#### Panel GLB (`#panel-glb`) — masqué jusqu'au chargement d'un GLB
| ID slider | ID valeur | Label | Rôle |
|---|---|---|---|
| `#glb-x` | `#glb-x-val` | X offset | Décalage horizontal du GLB |
| `#glb-y` | `#glb-y-val` | Y offset | Décalage vertical (hauteur) |
| `#glb-z` | `#glb-z-val` | Z offset | Décalage en profondeur |
| Reset pos | — | — | Remet X/Y/Z à 0 |
| Flip Z | — | — | Retourne le maillage sur l'axe Z |
| Flip X | — | — | Retourne le maillage sur l'axe X |
| Place Hole | — | — | Active le raycaster pour repositionner le trou sur le GLB |
| Calibrer physique | — | `#glb-calibrate` | Lance `calibrateGLB()` depuis la position de l'aimDot |
| `#glb-calib-result` | — | — | Affiche le résultat de calibration (facteur k ou message d'erreur) |

### HUD mode jeu (`#game-hud`) — visible uniquement en mode jeu
| ID | Type | Contenu |
|---|---|---|
| `#game-hole` | `<div>` | "Hole N / 9" — numéro du trou courant |
| `#scorecard` | `<div>` | Scorecard avec le score par trou |

### Popups et overlays
| ID | Condition d'affichage | Contenu |
|---|---|---|
| `#score-popup` | Après chaque trou | Score animé (ex. "+1", "Birdie") |
| `#game-over` | Fin de partie (9 trous) | Score final (`#game-final-score`), note (`#game-grade`), boutons Play Again / Exit |
| `#calib-overlay` | Pendant `calibrateGLB()` | Phase (`#calib-phase`), vitesse (`#calib-speed`), distance (`#calib-dist`), résumé (`#calib-summary`) — mis à jour frame par frame par `updateCalibAnim()` |
