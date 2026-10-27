// The parts of three.js 0.186.1 the About page's scene uses (src/about/scene.ts). three ships no types,
// and @types/three would add six packages (a physics engine among them) for these few lines.
// https://threejs.org/docs/
declare module "three" {
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    multiplyScalar(s: number): this;
    distanceTo(v: Vector3): number;
  }
  export class Euler {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }
  export class Object3D {
    position: Vector3;
    rotation: Euler;
    add(...objects: Object3D[]): this;
  }
  export class Group extends Object3D {}
  export class Scene extends Object3D {}
  export class PerspectiveCamera extends Object3D {
    aspect: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    lookAt(x: number, y: number, z: number): void;
    updateProjectionMatrix(): void;
  }
  export class Light extends Object3D {}
  export class AmbientLight extends Light {
    constructor(color?: number | string, intensity?: number);
  }
  export class HemisphereLight extends Light {
    constructor(sky?: number | string, ground?: number | string, intensity?: number);
  }
  export class DirectionalLight extends Light {
    constructor(color?: number | string, intensity?: number);
  }
  export class BufferGeometry {
    translate(x: number, y: number, z: number): this;
    dispose(): void;
  }
  export class Path {
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): this;
    closePath(): this;
  }
  export class Shape extends Path {}
  export class ExtrudeGeometry extends BufferGeometry {
    constructor(
      shape: Shape,
      options?: { depth?: number; bevelEnabled?: boolean; bevelThickness?: number; bevelSize?: number; bevelSegments?: number; curveSegments?: number },
    );
  }
  export class CylinderGeometry extends BufferGeometry {
    constructor(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number);
  }
  export class SphereGeometry extends BufferGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number);
  }
  export class Material {
    dispose(): void;
  }
  export class MeshStandardMaterial extends Material {
    constructor(parameters?: { color?: number | string; emissive?: number | string; emissiveIntensity?: number; roughness?: number; metalness?: number });
  }
  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
  }
  export class WebGLRenderer {
    constructor(parameters?: { canvas?: HTMLCanvasElement; antialias?: boolean; alpha?: boolean; powerPreference?: "default" | "high-performance" | "low-power" });
    setClearColor(color: number | string, alpha?: number): void;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: Object3D, camera: PerspectiveCamera): void;
    setAnimationLoop(callback: (() => void) | null): void;
    dispose(): void;
  }
}
