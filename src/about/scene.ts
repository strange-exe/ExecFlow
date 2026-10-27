// The About page's hero scene (three.js, WebGLRenderer): a flowchart in matte 3D tiles, the shapes
// the Flowchart tab draws (Start and End, a step, a decision with a loop back, an output), with a
// light travelling along its edges and a slight tilt toward the pointer. Loaded after the first paint
// by page.ts; the poster (/media/about-scene.webp, rendered from this same code by renderStill)
// stays where WebGL is missing or motion isn't welcome. One light direction, one material family,
// one camera (DESIGN-REFERENCE 2). The canvas is decorative (aria-hidden): the text beside it says
// what it shows.
import {
  AmbientLight,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Shape,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";

/** Fixed colours that read on the light and the dark ground alike (the poster serves both). */
const INK = { tile: "#eef1f6", decision: "#2f5bea", output: "#c6d3fb", edge: "#8994a8", beam: "#7f9cff" } as const;

type Kind = "terminal" | "process" | "decision" | "io";

function outline(kind: Kind, w: number, h: number): Shape {
  const s = new Shape();
  const x = w / 2;
  const y = h / 2;
  if (kind === "decision") {
    s.moveTo(0, y).lineTo(x, 0).lineTo(0, -y).lineTo(-x, 0).closePath();
  } else if (kind === "io") {
    const k = 0.28;
    s.moveTo(-x + k, y).lineTo(x + k, y).lineTo(x - k, -y).lineTo(-x - k, -y).closePath();
  } else {
    const r = kind === "terminal" ? y : 0.12;
    s.moveTo(-x + r, y).lineTo(x - r, y).quadraticCurveTo(x, y, x, y - r).lineTo(x, -y + r).quadraticCurveTo(x, -y, x - r, -y);
    s.lineTo(-x + r, -y).quadraticCurveTo(-x, -y, -x, -y + r).lineTo(-x, y - r).quadraticCurveTo(-x, y, -x + r, y);
  }
  return s;
}

/** The chart: boxes (kind, centre, size) and the path the light walks (box centres and corners). */
const BOXES: { kind: Kind; at: [number, number]; size: [number, number]; ink: keyof typeof INK }[] = [
  { kind: "terminal", at: [0, 3.3], size: [2, 0.75], ink: "tile" },
  { kind: "process", at: [0, 1.95], size: [2.4, 0.8], ink: "tile" },
  { kind: "decision", at: [0, 0.35], size: [2.3, 1.45], ink: "decision" },
  { kind: "io", at: [0, -1.35], size: [2.3, 0.8], ink: "output" },
  { kind: "terminal", at: [2.75, -2.75], size: [1.8, 0.75], ink: "tile" },
];
const EDGES: [number, number][][] = [
  [[0, 3.3], [0, 1.95]],
  [[0, 1.95], [0, 0.35]],
  [[0, 0.35], [0, -1.35]],
  // The loop: from the output back up to the decision, on the left.
  [[0, -1.35], [-2.15, -1.35], [-2.15, 0.35], [-1.15, 0.35]],
  // No: right, then down to End.
  [[1.15, 0.35], [2.75, 0.35], [2.75, -2.75]],
];
const WALK: [number, number][] = [[0, 3.3], [0, 1.95], [0, 0.35], [0, -1.35], [-2.15, -1.35], [-2.15, 0.35], [0, 0.35], [2.75, 0.35], [2.75, -2.75]];

interface Built {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  chart: Group;
  beam: Mesh;
  dispose(): void;
}

function webglWorks(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

function build(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): Built {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);

  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0xb6bfd0, 1.1));
  scene.add(new AmbientLight(0xffffff, 0.25));
  const sun = new DirectionalLight(0xffffff, 1.7);
  sun.position.set(-4, 7, 9);
  scene.add(sun);

  // Aimed at the chart's centre (x -2.15 to 3.65, y -3.1 to 3.7), a little from the right and above.
  const camera = new PerspectiveCamera(32, width / height, 0.1, 100);
  camera.position.set(2.3, 1.1, 15.5);
  camera.lookAt(0.75, 0.3, 0);

  const chart = new Group();
  const owned: { dispose(): void }[] = [];
  const material = (color: string) => {
    const m = new MeshStandardMaterial({ color, roughness: 0.78, metalness: 0 });
    owned.push(m);
    return m;
  };
  for (const b of BOXES) {
    const geo = new ExtrudeGeometry(outline(b.kind, b.size[0], b.size[1]), { depth: 0.34, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 4, curveSegments: 18 });
    geo.translate(0, 0, -0.17);
    owned.push(geo);
    const mesh = new Mesh(geo, material(INK[b.ink]));
    mesh.position.set(b.at[0], b.at[1], 0);
    chart.add(mesh);
  }
  const edgeMat = material(INK.edge);
  for (const line of EDGES) {
    for (let i = 1; i < line.length; i++) {
      const a = new Vector3(line[i - 1][0], line[i - 1][1], -0.05);
      const z = new Vector3(line[i][0], line[i][1], -0.05);
      const len = a.distanceTo(z);
      const geo = new CylinderGeometry(0.035, 0.035, len, 10);
      owned.push(geo);
      const rod = new Mesh(geo, edgeMat);
      rod.position.copy(a).add(z).multiplyScalar(0.5);
      // A cylinder stands on y; a horizontal run lies on x.
      if (a.y === z.y) rod.rotation.z = Math.PI / 2;
      chart.add(rod);
    }
  }
  const beamGeo = new SphereGeometry(0.11, 20, 14);
  owned.push(beamGeo);
  const beamMat = new MeshStandardMaterial({ color: INK.beam, emissive: INK.beam, emissiveIntensity: 0.9, roughness: 0.4 });
  owned.push(beamMat);
  const beam = new Mesh(beamGeo, beamMat);
  beam.position.set(0, 3.3, 0.3);
  chart.add(beam);
  chart.rotation.set(-0.12, -0.32, 0);
  scene.add(chart);

  return {
    renderer,
    scene,
    camera,
    chart,
    beam,
    dispose() {
      for (const o of owned) o.dispose();
      renderer.dispose();
    },
  };
}

/** Where the light is along the walk at t (0..1 is one walk). */
function walkAt(t: number): [number, number] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < WALK.length; i++) {
    const d = Math.hypot(WALK[i][0] - WALK[i - 1][0], WALK[i][1] - WALK[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let left = (t - Math.floor(t)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i]) {
      const f = left / seg[i];
      return [WALK[i][0] + (WALK[i + 1][0] - WALK[i][0]) * f, WALK[i][1] + (WALK[i + 1][1] - WALK[i][1]) * f];
    }
    left -= seg[i];
  }
  return WALK[WALK.length - 1];
}

/**
 * Mounts the running scene in `host` (an element with data-scene). States: "running" once a frame
 * is drawn, "unavailable" without WebGL; data-frames counts frames drawn (tests read it).
 */
export function mountScene(host: HTMLElement): void {
  if (!webglWorks()) {
    host.dataset.scene = "unavailable";
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "about-canvas";
  const box = () => host.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let built: Built;
  try {
    built = build(canvas, Math.max(1, box().width), Math.max(1, box().height), dpr);
  } catch {
    host.dataset.scene = "unavailable";
    return;
  }
  host.append(canvas);
  const { renderer, scene, camera, chart, beam } = built;
  let frames = 0;
  let tiltX = 0;
  let tiltY = 0;
  let aimX = 0;
  let aimY = 0;
  const onPointer = (e: PointerEvent) => {
    aimY = (e.clientX / innerWidth - 0.5) * 0.5;
    aimX = (e.clientY / innerHeight - 0.5) * 0.25;
  };
  addEventListener("pointermove", onPointer, { passive: true });

  const start = performance.now();
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    tiltX += (aimX - tiltX) * 0.05;
    tiltY += (aimY - tiltY) * 0.05;
    chart.rotation.x = -0.12 + tiltX + Math.sin(t * 0.6) * 0.02;
    chart.rotation.y = -0.32 + tiltY;
    chart.position.y = Math.sin(t * 0.8) * 0.06;
    const [x, y] = walkAt(t / 7);
    beam.position.set(x, y, 0.3);
    renderer.render(scene, camera);
    frames++;
    host.dataset.frames = String(frames);
    if (frames === 1) host.dataset.scene = "running";
  };

  let visible = true;
  let onScreen = true;
  const sync = () => renderer.setAnimationLoop(visible && onScreen ? frame : null);
  const io = new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    sync();
  });
  io.observe(host);
  const onVisibility = () => {
    visible = document.visibilityState === "visible";
    sync();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const ro = new ResizeObserver(() => {
    const r = box();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  });
  ro.observe(host);
  addEventListener(
    "pagehide",
    () => {
      renderer.setAnimationLoop(null);
      io.disconnect();
      ro.disconnect();
      removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      built.dispose();
    },
    { once: true },
  );
  sync();
}

/** One still frame at the resting pose, as WebP (the poster, made by a script in the dev server). */
export function renderStill(size: number): string {
  const canvas = document.createElement("canvas");
  const built = build(canvas, size, size, 1);
  built.beam.position.set(0, 0.35 + 0.95, 0.3);
  built.renderer.render(built.scene, built.camera);
  const url = canvas.toDataURL("image/webp", 0.9);
  built.dispose();
  return url;
}
