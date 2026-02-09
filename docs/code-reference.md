# STIMP Putting Simulator — Code Reference

## terrain.js

### Constants

| Name | Value | Description |
|------|-------|-------------|
| `TR_GRID_SIZE` | `50` | Grid resolution for terrain noise generation |
| `TR_WORLD_SIZE` | `12.0` | World coordinate size in meters for terrain sampling |
| `TR_BASE_AMP` | `0.5` | Base amplitude for initial noise grid |
| `TR_TARGET_AMP` | `0.1` | Target amplitude after normalization |
| `TR_SMOOTH_PASSES` | `8` | Number of smoothing iterations applied to terrain |
| `HEIGHT_SCALE` | `0.02` | Scale factor converting grid values to world height |
| `TR_MIN_SPEED` | `0.8` | Ball speed below which true roll effect increases |

### Functions

| Name | Parameters | Description |
|------|-----------|-------------|
| `mulberry32` | `seed` | Seeded PRNG (mulberry32 algorithm) for reproducible terrain |
| `makeRng` | `seed` | Factory returning an RNG object with `.uniform(lo, hi)` method |
| `makeNoiseGrid` | `size, amplitude, rng` | Generates a random noise grid in range [-amplitude, +amplitude] |
| `smoothGrid` | `grid, passes` | Applies 3x3 neighborhood averaging for the specified number of passes |
| `normalizeGrid` | `grid, targetAmp` | Scales grid so the maximum absolute value equals `targetAmp` |
| `bilinearSample` | `grid, x, z, worldSize` | Bilinear interpolation to sample a value at world coordinates (x, z) |
| `setTrueRollStrength` | `s` | Sets the true roll strength multiplier |
| `getTrueRollStrength` | — | Returns the current true roll strength value |
| `buildTrueRollGrids` | `seed` | Generates all terrain grids: height, true roll X, true roll Y |
| `getTerrainHeight` | `x, z` | Returns terrain height at world position (x, z) |
| `getTerrainNormal` | `x, z` | Returns surface normal vector at (x, z) using finite differences |
| `trueRollAccel` | `x, z, vx, vz` | Returns `{ax, az}` true roll acceleration based on speed and position |

---

## main.js

### Constants

| Name | Value | Description |
|------|-------|-------------|
| `GREEN_SIZE` | `10.0` | Putting green size in meters |
| `GREEN_COLOR` | `Color(0.08, 0.55, 0.24)` | Green surface color |
| `BG_COLOR` | `Color(0.08, 0.09, 0.11)` | Scene background color |
| `BALL_RADIUS_M` | `0.0215` | Golf ball radius in meters |
| `HOLE_RADIUS_M` | `2 × BALL_RADIUS_M` | Hole radius (0.043 m) |
| `CAMERA_HEIGHT` | `5.0` | Default camera Y position |
| `TR_COLOR_CONTRAST` | `5.0` | Terrain color variation contrast multiplier |
| `BALL_CIRCLE_RADIUS_DEFAULT` | `3.0` | Default ball spawn distance from hole |
| `BALL_CIRCLE_MIN` | `1.0` | Minimum spawn distance |
| `BALL_CIRCLE_MAX` | `5.5` | Maximum spawn distance |
| `BALL_CIRCLE_STEP` | `0.5` | Spawn distance adjustment step |
| `STIMP_V0` | `1.83` | Standard stimpmeter launch speed (m/s) |
| `GRAVITY` | `9.81` | Gravitational acceleration (m/s²) |
| `ROLLING_FACTOR` | `5/7` | Fraction of gravity affecting a rolling ball (moment of inertia) |
| `BOUNCE_DAMPING` | `0.3` | Vertical velocity retained after bounce |
| `BOUNCE_FRICTION` | `0.8` | Horizontal velocity retained after bounce |
| `MIN_BOUNCE_VEL` | `0.05` | Minimum vertical velocity to trigger a bounce |
| `LANDING_THRESHOLD` | `0.001` | Height threshold to determine if ball is airborne |
| `STIMP_DEFAULT` | `3.0` | Default stimp meter value |
| `MAX_GHOST_DIST` | `0.35` | Max ghost rest distance from hole for a valid aim point (m) |
| `ANGLE_STEP_DEG` | `0.1` | Slope angle change per frame when arrow keys held |
| `ANGLE_MAX_DEG` | `5.0` | Maximum slope angle magnitude (degrees) |
| `LAUNCH_ANGLE_DEFAULT` | `5` | Default ball launch angle (degrees) |
| `LAUNCH_ANGLE_MIN` | `-4` | Minimum launch angle (degrees) |
| `LAUNCH_ANGLE_MAX` | `15` | Maximum launch angle (degrees) |
| `LAUNCH_ANGLE_STEP` | `1` | Launch angle adjustment step (degrees) |
| `SPIN_EFFECT_STRENGTH` | `0.15` | Spin effect multiplier on friction |
| `SPIN_DECAY_RATE` | `2.0` | Exponential decay rate for ball spin |
| `ZOOM_DEFAULT` | `45.0` | Default camera field of view (degrees) |
| `ZOOM_MIN` | `1.0` | Minimum camera FOV |
| `ZOOM_MAX` | `90.0` | Maximum camera FOV |
| `ZOOM_STEP` | `5.0` | FOV adjustment step |
| `MAX_TRAIL_PTS` | `5000` | Maximum points per trail segment |
| `GRID_FLOW_SPACING` | `0.5` | Grid segment size for flow visualization (m) |

### Functions

| Name | Parameters | Description |
|------|-----------|-------------|
| `stimpToMu` | `s` | Converts stimp value to rolling friction coefficient μ |
| `getGradientAt` | `x, z, curAngleDeg` | Returns gradient `{gx, gz}` combining global slope, terrain normal, and true roll |
| `buildGreenMesh` | — | Creates the putting green mesh with terrain-colored vertices |
| `buildHole` | — | Creates hole geometry: collar, inner walls, rim, and bottom |
| `buildBall` | — | Creates ball mesh with stripe texture |
| `newTrailSegment` | — | Allocates a new trail line segment with dynamic vertex buffer |
| `addTrailPoint` | `x, y, z` | Appends a point to the current trail line |
| `clearAllTrails` | — | Removes and disposes all trail segments |
| `startNewTrailSegment` | — | Begins a fresh trail segment (e.g. after landing) |
| `addAimPointMarker` | `pt` | Creates a red sphere at an aim point |
| `colorLastAimPoint` | `madeIt` | Colors the last aim marker blue (valid) or leaves red (miss) |
| `clearAimPointMarkers` | — | Removes all aim point markers and clears arrays |
| `clearGhostMarker` | — | Removes the ghost rest position cross |
| `placeGhostCross` | `x, z` | Draws a yellow cross at the ghost rest position |
| `simulateGhostRest` | `startPos, startVel, startSpin` | Runs a 20,000-step physics simulation ignoring the hole to find where the ball would stop |
| `convexHull` | `points` | Computes 2D convex hull using Andrew's monotone chain algorithm |
| `boundingEllipse` | `hull` | Calculates bounding ellipse via PCA (principal component analysis) |
| `rebuildGoodAimZone` | — | Draws the convex hull, bounding ellipse, aim line, perpendicular, and label |
| `rebuildBreakMarkers` | — | Creates orange spheres at detected break points |
| `buildGradientArrows` | — | Generates the gradient vector field visualization |
| `traceStreamline` | `startX, startZ` | Traces a flow path following gradient descent (max 2000 steps) |
| `rebuildFlowVisuals` | — | Creates streamline curves and initializes the particle system |
| `updateFlowParticles` | `dt` | Animates particles along streamlines |
| `pickGridTarget` | `x, z, sp, edge` | Selects the next grid intersection in the dominant gradient direction |
| `rebuildGridFlow` | — | Creates grid lines and particles for grid flow mode |
| `updateGridFlowParticles` | `dt` | Animates grid particles between intersections |
| `rebuildSlopeIndicator` | — | Creates the slope direction arrow |
| `rebuildScaleBar` | — | Creates a 4-meter scale bar with tick marks |
| `updateHUD` | — | Updates the on-screen stats display (angle, stimp, speed, etc.) |
| `highlightHelp` | `action` | Highlights the matching help menu line for 2 seconds |
| `shoot` | — | Launches the ball toward the aim point using stimp and launch angle |
| `resetBall` | `newTerrain` | Resets ball to spawn circle; if `newTerrain` is true, regenerates terrain |
| `updateBallOnCircle` | — | Positions ball on the spawn circle at the current `ballAngle` |
| `updatePhysics` | `dt` | Main physics step: gravity, slope, friction, rolling, bouncing, hole capture |
| `updateAim` | — | Raycasts mouse position to terrain to compute aim world position |
| `animate` | — | Main render loop: input, physics, aim, rendering, HUD |

---

## Glossary

| Term | Definition |
|------|------------|
| **Stimp / Stimpmeter** | A standard measure of green speed. A stimp value of N means a ball launched at 1.83 m/s rolls N meters on a flat surface. Higher stimp = faster green. |
| **True Roll** | Simulated micro-undulations in the green surface that cause unpredictable ball deflection, especially at low speeds. Controlled by strength multiplier (Q/W keys). |
| **Rolling Factor** | The fraction 5/7, derived from the moment of inertia of a solid sphere. Only 5/7 of gravitational force along the slope translates into rolling acceleration. |
| **Ghost Rest** | A simulated "ghost" shot that predicts where the ball would stop if the hole didn't exist. Used to determine if an aim point is valid (within `MAX_GHOST_DIST` of the hole). |
| **Good Aim Zone** | The convex hull of all valid aim points — the region you can aim at and still make the putt. Displayed as a blue filled polygon with a white bounding ellipse. |
| **Bounding Ellipse** | A best-fit ellipse around the good aim zone, computed via PCA. Its center and axes summarize the aim zone's shape and position. |
| **Aim Line** | The yellow line from the ball through the ellipse center — the "perfect" aim direction. |
| **Perpendicular (to Aim Line)** | The red line from the hole to the nearest point on the aim line. Its length indicates how far the hole is from the ideal aim path. |
| **Aim Offset** | Distance from the ellipse center to the perpendicular foot point on the aim line. |
| **Break Point** | A position along the ball's path where the lateral (Z) velocity changes sign — the ball changes its sideways direction. Marked with orange spheres. |
| **Left to Right / Right to Left** | Golf terminology for the direction the ball curves. "Left to Right" means the ball breaks from left to right (aim left of hole, slope pushes ball right). |
| **Uphill / Downhill** | Whether the hole is at a higher or lower effective elevation than the ball, considering both terrain undulations and the global slope. |
| **Flow Visualization** | Three modes (cycled with F key): streamlines showing water flow paths, grid particles showing flow on a lattice, and gradient arrows showing the slope vector field. |
| **Slope Angle (`angleDeg`)** | The global tilt of the green in degrees. Positive = downhill in +Z direction. Clamped to ±5°. |
| **Launch Angle** | The vertical angle at which the ball leaves the surface. 0° = pure roll, positive = lofted shot. Affects bounce behavior. |
| **Spawn Circle** | The circle around the hole where the ball is placed before a shot. Radius adjustable with 1/2 keys. |
| **Convex Hull** | The smallest convex polygon enclosing all valid aim points. Computed using Andrew's monotone chain algorithm. |
| **PCA (Principal Component Analysis)** | Used to find the major and minor axes of the aim point distribution, forming the bounding ellipse. |
| **Bilinear Sampling** | Interpolation method to read smooth height values from the discrete terrain grid. |
| **NDC (Normalized Device Coordinates)** | Mouse coordinates mapped to [-1, 1] range for raycasting against the 3D scene. |
