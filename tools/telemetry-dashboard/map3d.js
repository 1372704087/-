/**
 * 3D battlefield overview (three.js).
 *
 * The target is the approved mockup, so its projection and shading model are
 * reproduced rather than approximated:
 *
 *  - **Parallel projection, 2:1 diamond.** The mockup maps cell (gx, gy) to
 *    screen ((gx-gy)*25, (gx+gy)*12.5). That ratio is `sin(elevation) = 0.5`, so
 *    the camera sits at 30° and an orthographic frustum — a perspective cone
 *    cannot hold parallel edges and the diamond goes crooked at the far corner.
 *  - **Real terrain relief.** The plate is the map's own elevation grid,
 *    displaced per cell and lit by one fixed sun, so hills read as hills instead
 *    of a flat diamond. The grid, its every-fourth emphasis and its boundary are
 *    baked once into a canvas texture applied to that displaced surface, so the
 *    glowing cell lines follow the terrain.
 *  - **Unlit, per-category solids.** Entities are flat three-tone solids, not
 *    shaded geometry, so their boxes carry baked per-face vertex colours and an
 *    unlit material. Each category gets its own silhouette (post, hull+turret,
 *    wing, plinth+tower) so a glance can tell infantry from armour from air from
 *    buildings. The house colour still multiplies in through `instanceColor`.
 *
 * The callout layer is a DOM overlay, not sprites: it has to carry the panel's
 * own text and stay crisp when the map is dragged. Every chip is anchored to a
 * cell the engine already reports — a selected unit, a house's base centre — so
 * nothing here invents a position. Hover and click are DOM + raycast: hovering
 * an entity outlines it and shows a chip, clicking re-centres the camera on it.
 *
 * Orientation note: azimuth `pi/4` is 45° off the radar axes, which is what makes
 * the diamond. It is not the in-game minimap reading (that is azimuth `pi/2`,
 * where +rx runs right and +ry runs down); drag-rotate is live, so the check
 * against the game is one drag away. Right-drag pans, wheel zooms, click focuses.
 *
 * Schema mirror of `src/sim/telemetry.rs`; keep both in step.
 */
import * as THREE from "./vendor/three.module.js";
import { t } from "./i18n.js";
/** InstancedMesh capacity per category: the project's 20k-unit target, so a
 *  single-category world can still field the whole capped spot list. */
const MAX_SPOTS = 20000;
/** One elevation level's visual offset, in world units. Shared by the terrain
 *  surface and the entity boxes, so a unit stands exactly on its cell. */
const LEVEL_STEP = 0.5;
/** Per-category box scale (world units, one cell = 1). Height is not here: the
 *  geometry's own base offset sets where the solid meets the ground. */
const CATEGORY_SCALE = {
    Infantry: 0.3,
    Unit: 0.42,
    Aircraft: 0.36,
    Structure: 2.2,
};
/** Distance from a geometry's origin to its base, so the solid sits on the
 *  plate instead of half-sinking into it. */
const CATEGORY_HEIGHT = {
    Infantry: 0.45,
    Unit: 0.45,
    Aircraft: 0.175,
    Structure: 0.5,
};
/** Structures are washed toward white to read as buildings; units keep the full
 *  team colour so ownership stays legible. */
const STRUCTURE_WASH = 0.55;
/** Chips are capped: a 20k-unit selection would bury the map. */
const MAX_CALLOUTS = 8;
/** Camera elevation, from the mockup's 2:1 ground ratio. */
const ISO_ELEVATION = Math.asin(0.5);
/** 45° off the radar axes: the diamond. */
const ISO_AZIMUTH = Math.PI / 4;
/** Fixed stand-off. An orthographic frustum ignores distance for size, so this
 *  only has to clear the map for the near and far planes. */
const CAMERA_DISTANCE = 600;
/** Fraction of the stage the diamond may fill; the rest is breathing room. */
const FIT = 0.88;
/** Fallback palette for houses the engine gave no colour (neutral, orphan). */
const HOUSE_PALETTE = ["#8a94a3", "#b04aff", "#e8c34a", "#37e0b8", "#ff5555", "#4a9eff"];
/** Entities with no house row (owner_index sentinel). */
const ORPHAN_COLOR = "#6b7a8c";
/** Every category, in a stable order for the per-category meshes. */
const CATEGORIES = ["Infantry", "Unit", "Aircraft", "Structure"];
/** `[r, g, b]` (0-255) -> a CSS colour three.js converts from sRGB. */
function houseColor(house, index) {
    if (house?.color) {
        const [r, g, b] = house.color;
        return `rgb(${r},${g},${b})`;
    }
    return HOUSE_PALETTE[index % HOUSE_PALETTE.length];
}
/** Mix an `rgb(...)`/`#rrggbb` colour toward white, for the structure wash. */
function wash(color, amount) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color) ||
        /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
    if (!m)
        return color;
    const [r, g, b] = [1, 2, 3].map((group) => {
        const raw = m[group].length === 2 ? parseInt(m[group], 16) : Number(m[group]);
        return Math.round(raw + (255 - raw) * amount);
    });
    return `rgb(${r},${g},${b})`;
}
function clampInt(value, low, high) {
    return Math.min(Math.max(Math.floor(value), low), high);
}
/** Bake a flat tone per vertex from its normal, for the unlit material: a top
 *  face reads bright, a bottom face dark, the sides in between. This is the
 *  same three-tone cue the original box carried, now for any silhouette. */
function toneByNormal(source, tone) {
    const geo = source.index ? source.toNonIndexed() : source;
    const normal = geo.getAttribute("normal");
    const count = normal.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const ny = normal.getY(i);
        const shade = ny > 0.5 ? Math.min(1, tone + 0.22) : ny < -0.5 ? Math.max(0.12, tone - 0.34) : tone;
        colors[i * 3] = shade;
        colors[i * 3 + 1] = shade;
        colors[i * 3 + 2] = shade;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
}
/** One translated unit box for a composite silhouette. */
function boxPart(w, h, d, y, tone) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, y, 0);
    return toneByNormal(geo, tone);
}
/** Concatenate toned parts into one non-indexed geometry for a category. */
function mergeParts(parts) {
    const position = [];
    const normal = [];
    const color = [];
    for (const part of parts) {
        const p = part.getAttribute("position");
        const n = part.getAttribute("normal");
        const c = part.getAttribute("color");
        for (let i = 0; i < p.count; i++) {
            position.push(p.getX(i), p.getY(i), p.getZ(i));
            normal.push(n.getX(i), n.getY(i), n.getZ(i));
            color.push(c.getX(i), c.getY(i), c.getZ(i));
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
    return geo;
}
/** One distinct silhouette per category, each centred on the origin and sized so
 *  its base sits at `-CATEGORY_HEIGHT` — a unit box scaled and placed by the
 *  same rule still stands on its cell. */
function categoryGeometry(category) {
    switch (category) {
        case "Infantry":
            // A tapered post: reads as a person, not a crate.
            return toneByNormal(new THREE.CylinderGeometry(0.28, 0.32, 0.9, 6), 0.9);
        case "Unit":
            // Hull + turret.
            return mergeParts([
                boxPart(1.0, 0.6, 1.3, -0.15, 0.85),
                boxPart(0.6, 0.5, 0.7, 0.25, 0.95),
            ]);
        case "Aircraft":
            // Fuselage + wing: flat, so air targets stand apart from ground armour.
            return mergeParts([
                boxPart(0.4, 0.35, 1.5, 0, 0.95),
                boxPart(1.5, 0.14, 0.55, 0, 0.8),
            ]);
        case "Structure":
            // Plinth + tower: a building mass, washed toward white by the instance
            // colour so structures read differently from units.
            return mergeParts([
                boxPart(1.0, 0.5, 1.0, -0.25, 0.7),
                boxPart(0.55, 0.5, 0.55, 0.25, 0.95),
            ]);
    }
}
export function createMap3D(canvas, calloutLayer) {
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    }
    catch {
        // No WebGL (headless preview, blocklisted GPU): the data panels still work.
        return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Transparent: the panel's CSS gradient is the sky.
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 4000);
    const orbit = { azimuth: ISO_AZIMUTH, elevation: ISO_ELEVATION, zoom: 1 };
    const orbitTarget = new THREE.Vector3();
    let extent = { w: 64, h: 64 };
    let aspect = 1;
    // Terrain: the decoded elevation grid and the lit surface built from it. The
    // grid arrives once per map, so it is cached and the surface is rebuilt only
    // when it changes.
    let terrain = null;
    let minLevel = 0;
    // Lights only affect the terrain's Lambert material; the entity boxes stay
    // unlit so their baked tones are exact.
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const sun = new THREE.DirectionalLight(0xffffff, 1.35);
    sun.position.set(0.5, 1.0, 0.35);
    scene.add(sun);
    /** Elevation level at a cell, 0 when no terrain has arrived. */
    function levelAt(rx, ry) {
        if (!terrain)
            return 0;
        const cx = clampInt(rx, 0, terrain.width - 1);
        const cy = clampInt(ry, 0, terrain.height - 1);
        return terrain.levels[cy * terrain.width + cx];
    }
    /** Decode the wire hex into one level byte per cell. */
    function decodeTerrain(grid) {
        const levels = new Uint8Array(grid.width * grid.height);
        for (let i = 0; i < levels.length; i++) {
            levels[i] = parseInt(grid.levels.slice(i * 2, i * 2 + 2), 16) || 0;
        }
        return levels;
    }
    // --- ground: the displaced elevation surface, carrying the glowing grid ---
    let plate = null;
    /** The map's grid, boundary and every-fourth emphasis, baked with a glow.
     *  WebGL lines are a fixed one pixel and cannot bloom, which is what makes the
     *  mockup's grid read as lit rather than drawn. */
    function makeGridTexture(w, h) {
        const px = Math.max(2, Math.min(16, Math.floor(2048 / Math.max(w, h))));
        const sprite = document.createElement("canvas");
        sprite.width = Math.max(1, w * px);
        sprite.height = Math.max(1, h * px);
        const g = sprite.getContext("2d");
        if (g) {
            // The base has to stay very dark: the plate is seen at 30°, so minification
            // averages a cell down to roughly its mean colour, and a lighter fill turns
            // the whole grid into a flat pale wash.
            g.fillStyle = "#040a1c";
            g.fillRect(0, 0, sprite.width, sprite.height);
            g.lineWidth = 1;
            for (let i = 0; i <= w; i++) {
                const major = i % 4 === 0;
                g.strokeStyle = major ? "rgba(150,210,255,0.46)" : "rgba(110,170,255,0.11)";
                g.shadowColor = major ? "rgba(120,190,255,0.9)" : "transparent";
                g.shadowBlur = major ? px * 0.5 : 0;
                g.beginPath();
                g.moveTo(i * px + 0.5, 0);
                g.lineTo(i * px + 0.5, sprite.height);
                g.stroke();
            }
            for (let j = 0; j <= h; j++) {
                const major = j % 4 === 0;
                g.strokeStyle = major ? "rgba(150,210,255,0.46)" : "rgba(110,170,255,0.11)";
                g.shadowColor = major ? "rgba(120,190,255,0.9)" : "transparent";
                g.shadowBlur = major ? px * 0.5 : 0;
                g.beginPath();
                g.moveTo(0, j * px + 0.5);
                g.lineTo(sprite.width, j * px + 0.5);
                g.stroke();
            }
            g.shadowColor = "rgba(160,225,255,1)";
            g.shadowBlur = px;
            g.strokeStyle = "rgba(190,235,255,0.85)";
            g.lineWidth = Math.max(1.5, px * 0.25);
            g.strokeRect(0, 0, sprite.width, sprite.height);
        }
        return new THREE.CanvasTexture(sprite);
    }
    function buildGround(w, h) {
        if (plate) {
            scene.remove(plate);
            plate.geometry.dispose();
            plate.material.map?.dispose();
            plate.material.dispose();
        }
        const texture = makeGridTexture(w, h);
        texture.colorSpace = THREE.SRGBColorSpace;
        // The plate is seen at a grazing angle: without anisotropic filtering the mip
        // chain jumps to a level far coarser than a cell and the grid averages away.
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        // One vertex per grid corner: `w` and `h` segments give `(w+1)*(h+1)` corners.
        // A 500x500 map is ~251k vertices, uploaded once per map load.
        const geometry = new THREE.PlaneGeometry(w, h, w, h);
        let covered = false;
        if (terrain && terrain.width === w && terrain.height === h) {
            const position = geometry.getAttribute("position");
            minLevel = 255;
            for (let i = 0; i < position.count; i++) {
                // Local plane coords -> world cell coords, matching the mesh transform
                // (rotated -90° about X, translated to the map centre).
                const worldX = position.getX(i) + w / 2;
                const worldZ = h / 2 - position.getY(i);
                const level = levelAt(worldX, worldZ);
                position.setZ(i, level * LEVEL_STEP);
                if (level < minLevel)
                    minLevel = level;
            }
            position.needsUpdate = true;
            geometry.computeVertexNormals();
            covered = true;
        }
        if (!covered) {
            minLevel = 0;
        }
        plate = new THREE.Mesh(geometry, 
        // Lit so the displaced relief shades; flat facets keep the terraces crisp.
        new THREE.MeshLambertMaterial({ map: texture, flatShading: true }));
        plate.rotation.x = -Math.PI / 2;
        plate.position.set(w / 2, 0, h / 2);
        scene.add(plate);
    }
    // --- entities: unlit, per-category toned solids --------------------------
    const entityMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    const entities = new Map();
    const meshCategory = new Map();
    for (const category of CATEGORIES) {
        const mesh = new THREE.InstancedMesh(categoryGeometry(category), entityMaterial, MAX_SPOTS);
        mesh.count = 0;
        mesh.frustumCulled = false;
        scene.add(mesh);
        entities.set(category, mesh);
        meshCategory.set(mesh, category);
    }
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    // Instance id -> the spot it came from, per category, for hover/click lookups.
    const entityLookup = {
        Infantry: [],
        Unit: [],
        Aircraft: [],
        Structure: [],
    };
    let lastHouses = [];
    // --- cursor marker (the Terrain Debug panel's cell) ----------------------
    const cursorMarker = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.12, 1.02), new THREE.MeshBasicMaterial({ color: 0xff7cc9, transparent: true, opacity: 0.95 }));
    cursorMarker.visible = false;
    scene.add(cursorMarker);
    // A flat halo: at 30° elevation a thin box is a few pixels tall, and the
    // cursor cell is the one thing that always has to be findable.
    const cursorHalo = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({ color: 0xff7cc9, transparent: true, opacity: 0.22 }));
    cursorHalo.rotation.x = -Math.PI / 2;
    cursorHalo.visible = false;
    scene.add(cursorHalo);
    // --- bloom ---------------------------------------------------------------
    /** One soft radial sprite reused for every glow: the diamond's halo and each
     *  base's ground bloom are the same gradient, tinted and scaled. */
    function makeGlowTexture() {
        const side = 128;
        const sprite = document.createElement("canvas");
        sprite.width = side;
        sprite.height = side;
        const g = sprite.getContext("2d");
        if (g) {
            const grad = g.createRadialGradient(side / 2, side / 2, 0, side / 2, side / 2, side / 2);
            grad.addColorStop(0, "rgba(255,255,255,1)");
            grad.addColorStop(0.35, "rgba(255,255,255,0.42)");
            grad.addColorStop(1, "rgba(255,255,255,0)");
            g.fillStyle = grad;
            g.fillRect(0, 0, side, side);
        }
        return new THREE.CanvasTexture(sprite);
    }
    const glowTexture = makeGlowTexture();
    function makeGlow(hex, opacity) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
            map: glowTexture,
            color: hex,
            transparent: true,
            opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        }));
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        scene.add(mesh);
        return mesh;
    }
    const plateGlow = makeGlow(0x63b3ff, 0.5);
    const baseGlows = [makeGlow(0xffffff, 0.55), makeGlow(0xffffff, 0.55), makeGlow(0xffffff, 0.55), makeGlow(0xffffff, 0.55)];
    const scratchColor = new THREE.Color();
    // --- path preview --------------------------------------------------------
    const MAX_PATH_POINTS = 128;
    const pathLines = [];
    for (let i = 0; i < baseGlows.length; i++) {
        const positions = new THREE.BufferAttribute(new Float32Array(MAX_PATH_POINTS * 3), 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", positions);
        const material = new THREE.LineDashedMaterial({
            color: 0x41ecff,
            dashSize: 2.4,
            gapSize: 1.4,
            transparent: true,
            opacity: 1,
        });
        const line = new THREE.Line(geometry, material);
        line.visible = false;
        line.frustumCulled = false;
        scene.add(line);
        pathLines.push({ line, material, positions });
    }
    // --- hover highlight -----------------------------------------------------
    const highlight = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xaee8ff, transparent: true, opacity: 0.95 }));
    highlight.visible = false;
    highlight.frustumCulled = false;
    scene.add(highlight);
    // The hover chip is a DOM element outside the callout host, which `updateCallouts`
    // clears each snapshot. It shares the stage box so its offsets are in pixels.
    const stage = (canvas.parentElement ?? document.body);
    const tip = document.createElement("div");
    tip.className = "map-tip";
    tip.style.display = "none";
    stage.append(tip);
    /** Camera position and frustum. The diamond's screen extents follow from the
     *  azimuth and elevation, so the fit is solved against the stage rather than
     *  tuned by eye: at 45° it is `(w + h) * cos45` wide and that times
     *  `sin(elevation)` tall, and either edge can bind depending on the panel. */
    function applyCamera() {
        camera.position.set(orbitTarget.x + CAMERA_DISTANCE * Math.cos(orbit.azimuth) * Math.cos(orbit.elevation), orbitTarget.y + CAMERA_DISTANCE * Math.sin(orbit.elevation), orbitTarget.z + CAMERA_DISTANCE * Math.sin(orbit.azimuth) * Math.cos(orbit.elevation));
        camera.lookAt(orbitTarget);
        const spread = (extent.w + extent.h) * Math.SQRT1_2;
        const halfFromHeight = (spread * Math.sin(orbit.elevation)) / 2;
        const halfFromWidth = spread / 2 / Math.max(0.2, aspect);
        const halfHeight = (Math.max(halfFromHeight, halfFromWidth) * 2) / FIT / 2;
        camera.top = halfHeight * orbit.zoom;
        camera.bottom = -camera.top;
        camera.right = camera.top * aspect;
        camera.left = -camera.right;
        camera.updateProjectionMatrix();
    }
    /** Back to the map centre: the framing a size change and Reset both want. */
    function recenter() {
        orbitTarget.set(extent.w / 2, 0, extent.h / 2);
        applyCamera();
    }
    /** Centre the camera on a map cell, keeping the current orientation and zoom. */
    function focusOn(gx, gz) {
        orbitTarget.set(gx, levelAt(gx, gz) * LEVEL_STEP, gz);
        applyCamera();
    }
    function updateSpots(snapshot) {
        const spots = snapshot.spots;
        lastHouses = snapshot.houses;
        for (const category of CATEGORIES) {
            entities.get(category).count = 0;
            entityLookup[category].length = 0;
        }
        // One colour per house row, from the engine's own [Colors] scheme.
        const houseColors = snapshot.houses.map((house, index) => houseColor(house, index));
        for (const spot of spots) {
            const mesh = entities.get(spot.category);
            if (!mesh || mesh.count >= MAX_SPOTS)
                continue;
            const index = mesh.count;
            mesh.count = index + 1;
            entityLookup[spot.category].push(spot);
            const scale = CATEGORY_SCALE[spot.category] ?? 0.6;
            // Map (rx, ry) -> world (X, Z); elevation -> Y.
            dummy.position.set(spot.x, spot.z * LEVEL_STEP + CATEGORY_HEIGHT[spot.category] * scale, spot.y);
            dummy.scale.set(scale, scale, scale);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            mesh.setMatrixAt(index, dummy.matrix);
            const owner = spot.owner_index;
            const base = owner === 0xffff ? ORPHAN_COLOR : (houseColors[owner] ?? ORPHAN_COLOR);
            color.setStyle(spot.category === "Structure" ? wash(base, STRUCTURE_WASH) : base);
            mesh.setColorAt(index, color);
        }
        for (const category of CATEGORIES) {
            const mesh = entities.get(category);
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor)
                mesh.instanceColor.needsUpdate = true;
        }
    }
    function updateCursor(debug) {
        const cell = debug?.cursor_cell;
        if (!cell) {
            cursorMarker.visible = false;
            cursorHalo.visible = false;
            return;
        }
        const ground = levelAt(cell[0], cell[1]) * LEVEL_STEP;
        cursorMarker.visible = true;
        cursorHalo.visible = true;
        cursorMarker.position.set(cell[0] + 0.5, ground + 0.06, cell[1] + 0.5);
        cursorHalo.position.set(cell[0] + 0.5, ground + 0.02, cell[1] + 0.5);
    }
    function updateGlows(snapshot) {
        const reach = Math.max(extent.w, extent.h) * 1.6;
        plateGlow.visible = true;
        plateGlow.position.set(extent.w / 2, minLevel * LEVEL_STEP - 0.15, extent.h / 2);
        plateGlow.scale.set(reach, reach, 1);
        const bases = snapshot.houses.filter((house) => !house.passive && !house.defeated && house.base_center);
        const size = Math.max(extent.w, extent.h) * 0.36;
        for (let i = 0; i < baseGlows.length; i++) {
            const glow = baseGlows[i];
            const house = bases[i];
            if (!house?.base_center) {
                glow.visible = false;
                continue;
            }
            scratchColor.setStyle(houseColor(house, snapshot.houses.indexOf(house)));
            glow.material.color.copy(scratchColor);
            glow.visible = true;
            const [bx, bz] = house.base_center;
            glow.position.set(bx, levelAt(bx, bz) * LEVEL_STEP + 0.03, bz);
            glow.scale.set(size, size, 1);
        }
    }
    /** The engine already sends the plan for every inspected unit, so the dashed
     *  line is the sim's own path, not a guess. A step it marks unwalkable turns
     *  the whole line amber — the same reading as the chip's "path blocked". */
    function updatePaths(debug) {
        const selected = debug?.selected ?? [];
        for (let i = 0; i < pathLines.length; i++) {
            const entry = pathLines[i];
            const steps = selected[i]?.path_preview ?? [];
            if (steps.length < 2) {
                entry.line.visible = false;
                continue;
            }
            const count = Math.min(steps.length, MAX_PATH_POINTS);
            const array = entry.positions.array;
            let blocked = false;
            for (let s = 0; s < count; s++) {
                const [cx, cy] = steps[s].cell;
                array[s * 3] = cx + 0.5;
                array[s * 3 + 1] = levelAt(cx, cy) * LEVEL_STEP + 0.7;
                array[s * 3 + 2] = cy + 0.5;
                blocked = blocked || !steps[s].walkable;
            }
            entry.positions.needsUpdate = true;
            entry.line.geometry.setDrawRange(0, count);
            entry.material.color.set(blocked ? 0xffca74 : 0x41ecff);
            // Dashes are measured along the polyline, so they only come out right
            // once the positions are final.
            entry.line.computeLineDistances();
            entry.line.visible = true;
        }
    }
    // --- callouts: world-anchored DOM chips over the canvas ------------------
    const projected = new THREE.Vector3();
    const calloutHost = calloutLayer ?? null;
    function chip(stem, title, sub, tint) {
        const wrap = document.createElement("div");
        wrap.className = "map-callout";
        wrap.style.setProperty("--stem", `${stem}px`);
        if (tint)
            wrap.style.setProperty("--tint", tint);
        const box = document.createElement("div");
        box.className = "map-callout-box";
        const head = document.createElement("b");
        head.textContent = title;
        box.append(head);
        if (sub) {
            const detail = document.createElement("em");
            detail.textContent = sub;
            box.append(detail);
        }
        const line = document.createElement("i");
        line.className = "map-callout-stem";
        const foot = document.createElement("s");
        foot.className = "map-callout-foot";
        wrap.append(box, line, foot);
        return wrap;
    }
    /** Place one chip above the world point its cell names; false when it is
     *  behind the camera or off the visible canvas. */
    function place(el, gx, gy) {
        projected.set(gx, levelAt(gx, gy) * LEVEL_STEP, gy).project(camera);
        if (projected.z > 1)
            return false;
        const left = (projected.x * 0.5 + 0.5) * canvas.clientWidth;
        const top = (-projected.y * 0.5 + 0.5) * canvas.clientHeight;
        if (left < 0 || top < 0 || left > canvas.clientWidth || top > canvas.clientHeight)
            return false;
        el.style.left = `${left.toFixed(1)}px`;
        el.style.top = `${top.toFixed(1)}px`;
        return true;
    }
    function updateCallouts(snapshot) {
        if (!calloutHost)
            return;
        calloutHost.textContent = "";
        const debug = snapshot.debug;
        const built = [];
        // Selected units first: they are what the inspector panel is about, so they
        // keep the slots if there are more than fit.
        for (const unit of debug?.selected.slice(0, MAX_CALLOUTS) ?? []) {
            const state = unit.path_blocked
                ? t("map.pathBlocked")
                : unit.moving
                    ? `${t("map.moving")} · ${t("map.steps", { n: unit.path_steps_left })}`
                    : t("map.standby");
            built.push({
                el: chip(34 + built.length * 15, unit.type_name, `${state} · #${unit.stable_id}`, null),
                gx: unit.cell[0] + unit.sub[0],
                gy: unit.cell[1] + unit.sub[1],
            });
        }
        // Then each contending house's base, the only other place on the map the
        // engine reports a named position for a player.
        const room = MAX_CALLOUTS - built.length;
        if (room > 0) {
            const bases = snapshot.houses.filter((house) => !house.passive && !house.defeated && house.base_center);
            for (const house of bases.slice(0, room)) {
                const index = snapshot.houses.indexOf(house);
                built.push({
                    el: chip(34 + built.length * 15, house.name, t("map.base"), houseColor(house, index)),
                    gx: house.base_center[0],
                    gy: house.base_center[1],
                });
            }
        }
        for (const item of built) {
            calloutHost.append(item.el);
            if (!place(item.el, item.gx, item.gy))
                item.el.remove();
        }
    }
    // --- interaction: hover, click-to-focus, drag rotate/pan, wheel zoom ------
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hoverMatrix = new THREE.Matrix4();
    const hoverPos = new THREE.Vector3();
    const hoverQuat = new THREE.Quaternion();
    const hoverScale = new THREE.Vector3();
    let pointerX = 0;
    let pointerY = 0;
    let pointerInside = false;
    /** Owner name for a spot, or the orphan label when it has no house row. */
    function ownerName(spot) {
        if (spot.owner_index === 0xffff)
            return t("map.orphan");
        return lastHouses[spot.owner_index]?.name ?? t("map.orphan");
    }
    /** Once per frame: outline the entity under the pointer and show its chip.
     *  Bounded to a frame so a 20k-instance world does not raycast per mousemove. */
    function updateHover() {
        if (!pointerInside || drag.mode) {
            highlight.visible = false;
            tip.style.display = "none";
            return;
        }
        const rect = canvas.getBoundingClientRect();
        ndc.set(((pointerX - rect.left) / rect.width) * 2 - 1, -(((pointerY - rect.top) / rect.height) * 2 - 1));
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects([...entities.values()], false);
        const hit = hits[0];
        const id = hit?.instanceId;
        const mesh = hit?.object;
        const category = mesh ? meshCategory.get(mesh) : undefined;
        if (!mesh || category === undefined || id === undefined) {
            highlight.visible = false;
            tip.style.display = "none";
            return;
        }
        mesh.getMatrixAt(id, hoverMatrix);
        hoverMatrix.decompose(hoverPos, hoverQuat, hoverScale);
        const scale = CATEGORY_SCALE[category] * 1.5;
        highlight.position.copy(hoverPos);
        highlight.scale.set(scale, scale, scale);
        highlight.visible = true;
        const spot = entityLookup[category][id];
        tip.textContent = spot ? `${spot.category} · ${ownerName(spot)}` : "";
        tip.style.display = spot ? "block" : "none";
        const stageRect = stage.getBoundingClientRect();
        tip.style.left = `${pointerX - stageRect.left + 14}px`;
        tip.style.top = `${pointerY - stageRect.top + 14}px`;
    }
    /** The entity or terrain point under a screen position, as a focus target. */
    function pick(gx, gy) {
        const rect = canvas.getBoundingClientRect();
        ndc.set(((gx - rect.left) / rect.width) * 2 - 1, -(((gy - rect.top) / rect.height) * 2 - 1));
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects([...entities.values()], false);
        if (hits.length > 0) {
            const hit = hits[0];
            const category = meshCategory.get(hit.object);
            const spot = category !== undefined && hit.instanceId !== undefined
                ? entityLookup[category][hit.instanceId]
                : undefined;
            if (spot)
                return { gx: spot.x, gz: spot.y };
        }
        // Nothing solid hit: fall back to the ground plane so a click anywhere
        // re-centres the view rather than doing nothing.
        if (plate) {
            const ground = raycaster.intersectObject(plate, false);
            const point = ground[0]?.point;
            if (point)
                return { gx: point.x, gz: point.z };
        }
        return null;
    }
    const drag = {
        mode: null,
        x: 0,
        y: 0,
        moved: false,
    };
    function bindInteractions() {
        canvas.addEventListener("pointerdown", (event) => {
            drag.mode = event.button === 2 || event.shiftKey ? "pan" : "rotate";
            drag.x = event.clientX;
            drag.y = event.clientY;
            drag.moved = false;
            canvas.setPointerCapture(event.pointerId);
        });
        canvas.addEventListener("pointerup", (event) => {
            const wasClick = drag.mode === "rotate" && !drag.moved;
            drag.mode = null;
            canvas.releasePointerCapture(event.pointerId);
            // A click (not a drag) re-centres on what is under it.
            if (wasClick) {
                const target = pick(event.clientX, event.clientY);
                if (target)
                    focusOn(target.gx, target.gz);
            }
        });
        canvas.addEventListener("pointermove", (event) => {
            pointerX = event.clientX;
            pointerY = event.clientY;
            pointerInside = true;
            if (!drag.mode)
                return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 2)
                drag.moved = true;
            if (drag.mode === "rotate") {
                orbit.azimuth -= dx * 0.008;
                orbit.elevation = Math.min(1.45, Math.max(0.12, orbit.elevation + dy * 0.006));
            }
            else {
                // Pan: move the view target opposite the drag, one world unit per the
                // pixels the frustum covers, along the camera's own screen axes.
                const worldPerPixel = (camera.top - camera.bottom) / canvas.clientHeight;
                const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
                const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
                orbitTarget.addScaledVector(right, -dx * worldPerPixel);
                orbitTarget.addScaledVector(up, dy * worldPerPixel);
            }
            drag.x = event.clientX;
            drag.y = event.clientY;
            applyCamera();
        });
        canvas.addEventListener("pointerleave", () => {
            pointerInside = false;
        });
        canvas.addEventListener("contextmenu", (event) => event.preventDefault());
        canvas.addEventListener("wheel", (event) => {
            event.preventDefault();
            zoom(1 / (1 + Math.sign(event.deltaY) * 0.12));
        }, { passive: false });
    }
    function zoom(factor) {
        orbit.zoom = Math.min(3, Math.max(0.35, orbit.zoom / factor));
        applyCamera();
    }
    function resize() {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (width === 0 || height === 0)
            return;
        renderer.setSize(width, height, false);
        aspect = width / height;
        // The frustum depends on the aspect, so a resize changes the framing too.
        applyCamera();
    }
    function render() {
        requestAnimationFrame(render);
        updateHover();
        renderer.render(scene, camera);
    }
    buildGround(extent.w, extent.h);
    recenter();
    bindInteractions();
    new ResizeObserver(resize).observe(canvas.parentElement);
    resize();
    render();
    return {
        draw(snapshot) {
            const w = snapshot.map_width || 64;
            const h = snapshot.map_height || 64;
            // The elevation grid arrives once per map; cache it and rebuild the
            // surface only when the grid or the map size changes.
            if (snapshot.terrain) {
                terrain = {
                    width: snapshot.terrain.width,
                    height: snapshot.terrain.height,
                    levels: decodeTerrain(snapshot.terrain),
                };
            }
            if (w !== extent.w || h !== extent.h) {
                extent = { w, h };
                buildGround(w, h);
                recenter();
            }
            else if (terrain && snapshot.terrain) {
                buildGround(w, h);
            }
            updateSpots(snapshot);
            updateCursor(snapshot.debug);
            updateGlows(snapshot);
            updatePaths(snapshot.debug);
            // Last: the chips are positioned against the camera this snapshot left the
            // scene in, so they must be projected after every move.
            updateCallouts(snapshot);
        },
        zoomBy(factor) {
            zoom(factor);
        },
        resetView() {
            orbit.azimuth = ISO_AZIMUTH;
            orbit.elevation = ISO_ELEVATION;
            orbit.zoom = 1;
            recenter();
        },
        dispose() {
            glowTexture.dispose();
            for (const entry of pathLines) {
                entry.line.geometry.dispose();
                entry.material.dispose();
            }
            for (const glow of [plateGlow, ...baseGlows]) {
                glow.geometry.dispose();
                glow.material.dispose();
            }
            if (plate) {
                plate.material.map?.dispose();
                plate.material.dispose();
                plate.geometry.dispose();
            }
            for (const category of CATEGORIES) {
                entities.get(category).geometry.dispose();
            }
            entityMaterial.dispose();
            highlight.geometry.dispose();
            highlight.material.dispose();
            cursorMarker.geometry.dispose();
            cursorMarker.material.dispose();
            cursorHalo.geometry.dispose();
            cursorHalo.material.dispose();
            tip.remove();
            renderer.dispose();
        },
    };
}
