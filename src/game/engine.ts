import * as THREE from "three";
import { GameAudio } from "./audio";
import { INITIAL_SNAP, type RunState, type Snapshot } from "./types";

export type { RunState, Snapshot };
export { INITIAL_SNAP };

const SEG_LEN = 18;
const SEG_COUNT = 12;
const LANES = [-2.25, 0, 2.25] as const;
const BASE_SPEED = 16;
const MAX_SPEED = 34;
const SPEED_RAMP = 0.24;
const FIXED = 1 / 60;
const JUMP_V = 8.8;
const GRAVITY = 24;
const LANE_TIME = 0.16;
const STORAGE_KEY = "rift-run-v1";
const RECYCLE_Z = 22;

const _world = new THREE.Vector3();

type Lane = -1 | 0 | 1;

type HazardKind = "crate" | "wall";

type DynItem = {
  mesh: THREE.Object3D;
  kind: HazardKind | "orb";
  lane: Lane;
  localZ: number;
  baseY: number;
  phase: number;
  alive: boolean;
};

type Segment = {
  group: THREE.Group;
  cliffs: THREE.Object3D[];
  shards: THREE.Object3D[];
  dyn: DynItem[];
};

type Particle = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
};

function easeOutCubic(t: number) {
  const u = 1 - t;
  return 1 - u * u * u;
}

function expDamp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function randLane(): Lane {
  return (Math.floor(Math.random() * 3) - 1) as Lane;
}

function otherLanes(open: Lane): Lane[] {
  return ([-1, 0, 1] as Lane[]).filter((l) => l !== open);
}

function readBest(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { v?: number; best?: number };
    return typeof parsed.best === "number" ? parsed.best : 0;
  } catch {
    return 0;
  }
}

function writeBest(best: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, best }));
  } catch {
    /* ignore quota */
  }
}

function makeRenderer(canvas: HTMLCanvasElement, mobile: boolean): THREE.WebGLRenderer | null {
  const attempts: THREE.WebGLRendererParameters[] = [
    {
      canvas,
      antialias: !mobile,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: "default",
      failIfMajorPerformanceCaveat: false,
    },
    {
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: false,
    },
  ];
  for (const params of attempts) {
    try {
      const renderer = new THREE.WebGLRenderer(params);
      if (renderer.getContext()) return renderer;
      renderer.dispose();
    } catch {
      /* try next */
    }
  }
  return null;
}

function mat(
  color: number,
  extras: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.08,
    ...extras,
  });
}

export class RunnerGame {
  private canvas: HTMLCanvasElement;
  private onChange: (s: Snapshot) => void;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private audio = new GameAudio();
  private ro: ResizeObserver | null = null;
  private running = false;
  private failed = false;
  private reduceMotion = false;
  private mobile = false;

  private state: RunState = "start";
  private speed = 0;
  private distance = 0;
  private coins = 0;
  private combo = 0;
  private comboTimer = 0;
  private score = 0;
  best = 0;
  private muted = false;

  private playerRoot = new THREE.Group();
  private courier = new THREE.Group();
  private shadowBlob: THREE.Mesh | null = null;
  private parts: {
    leftLeg: THREE.Object3D;
    rightLeg: THREE.Object3D;
    leftArm: THREE.Object3D;
    rightArm: THREE.Object3D;
  } | null = null;

  private lane: Lane = 0;
  private fromLane: Lane = 0;
  private toLane: Lane = 0;
  private laneT = 1;
  private queued: 0 | -1 | 1 = 0;
  private hop = 0;
  private vy = 0;
  private grounded = true;
  private coyote = 0;
  private jumpBuf = 0;
  private runPhase = 0;
  private playerX = 0;

  private keys = new Set<string>();
  private injected = new Set<string>();
  private prevHeld = new Set<string>();
  private steerInject = 0;
  private prevSteer = 0;
  private pointers = new Map<number, { x: number; y: number }>();

  private segments: Segment[] = [];
  private lastHazard = false;
  private cratePool: THREE.Object3D[] = [];
  private wallPool: THREE.Object3D[] = [];
  private orbPool: THREE.Object3D[] = [];
  private particles: Particle[] = [];
  private iceSpark!: THREE.MeshBasicMaterial;
  private rustSpark!: THREE.MeshBasicMaterial;

  private sun: THREE.DirectionalLight | null = null;
  private acc = 0;
  private time = 0;
  private trauma = 0;
  private hitstop = 0;
  private lastEmit = "";
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  private onKeyDown = (e: KeyboardEvent) => this.handleKey(e, true);
  private onKeyUp = (e: KeyboardEvent) => this.handleKey(e, false);
  private onBlur = () => {
    this.keys.clear();
  };
  private onVis = () => {
    if (document.hidden) this.keys.clear();
    this.audio.resume();
  };
  private onPointerDown = (e: PointerEvent) => this.ptrDown(e);
  private onPointerUp = (e: PointerEvent) => this.ptrUp(e);
  private onPointerCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };
  private onResize = () => this.resize();

  constructor(canvas: HTMLCanvasElement, onChange: (s: Snapshot) => void) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.best = readBest();
    this.mobile = window.matchMedia("(pointer: coarse)").matches;
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 240);
    this.camera.position.set(0, 3.7, 8.2);

    try {
      this.renderer = makeRenderer(canvas, this.mobile);
    } catch {
      this.failed = true;
      this.emit();
      return;
    }

    if (!this.renderer) {
      this.failed = true;
      this.emit();
      return;
    }

    try {
      const renderer = this.renderer;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.setClearColor(0x0a0c12, 1);
      renderer.shadowMap.enabled = !this.mobile;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.25 : 2));

      this.buildWorld();
      this.buildPlayer();
      this.buildParticles();
      this.layoutSegments(false);
      this.resize();
      this.bind();
      this.hookControlsTest();
      this.running = true;
      this.emit();
      renderer.setAnimationLoop((t) => this.frame(t));
      requestAnimationFrame(() => this.resize());
    } catch {
      this.failed = true;
      this.renderer?.dispose();
      this.renderer = null;
      this.emit();
    }
  }

  start() {
    if (this.failed || this.state === "playing") return;
    try {
      this.audio.unlock();
    } catch {
      /* gesture / iframe may block audio; still run */
    }
    this.resetRun(true);
    this.state = "playing";
    try {
      this.audio.startDrone();
    } catch {
      /* ignore */
    }
    this.emit();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.audio.setMuted(muted);
    this.emit();
  }

  toggleMuted() {
    this.setMuted(!this.muted);
  }

  queueLane(dir: -1 | 1) {
    this.trySwitch(dir);
  }

  queueJump() {
    this.jumpBuf = 0.14;
  }

  dispose() {
    this.running = false;
    this.renderer?.setAnimationLoop(null);
    this.unbind();
    this.audio.dispose();
    this.ro?.disconnect();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry = mesh.geometry;
      }
    });
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.renderer?.dispose();
    if (window.__controlsTest) delete window.__controlsTest;
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }

  private trackMat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  private buildWorld() {
    this.scene.fog = new THREE.FogExp2(0x0d1218, 0.011);
    this.scene.background = new THREE.Color(0x0a0c12);

    const hemi = new THREE.HemisphereLight(0x8ea0b4, 0x1a1816, 0.72);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1dc, 1.15);
    sun.position.set(10, 22, 8);
    sun.castShadow = !this.mobile;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 70;
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -12;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.scene.add(sun.target);
    sun.target.position.set(0, 0, -12);
    this.sun = sun;

    const rim = new THREE.DirectionalLight(0x9eb4c8, 0.4);
    rim.position.set(-4, 6, 12);
    this.scene.add(rim);

    this.scene.add(this.makeSky());
    this.scene.add(this.makeStars());
    this.scene.add(this.makeMoon());

    const abyssGeo = this.trackGeo(new THREE.PlaneGeometry(400, 400));
    const abyssMat = this.trackMat(new THREE.MeshBasicMaterial({ color: 0x07080b, fog: true }));
    const abyss = new THREE.Mesh(abyssGeo, abyssMat);
    abyss.rotation.x = -Math.PI / 2;
    abyss.position.y = -0.35;
    this.scene.add(abyss);

    const floorGeo = this.trackGeo(new THREE.BoxGeometry(7.4, 0.38, SEG_LEN + 0.08));
    const floorMat = this.trackMat(mat(0x2b2f36, { roughness: 0.82, metalness: 0.04 }));
    const edgeGeo = this.trackGeo(new THREE.BoxGeometry(1.5, 0.55, SEG_LEN + 0.08));
    const edgeMat = this.trackMat(mat(0x1c2026, { roughness: 0.86 }));
    const grooveGeo = this.trackGeo(new THREE.BoxGeometry(0.16, 0.05, SEG_LEN + 0.04));
    const grooveMat = this.trackMat(
      mat(0x6ec4c8, { emissive: 0x2a8f96, emissiveIntensity: 1.1, roughness: 0.35 }),
    );
    const grooveMidMat = this.trackMat(
      mat(0x9fe0e2, { emissive: 0x4eb8bc, emissiveIntensity: 1.6, roughness: 0.3 }),
    );
    const cliffGeo = this.trackGeo(new THREE.BoxGeometry(3.4, 10, 7.2));
    const cliffMatA = this.trackMat(mat(0x1a1e25, { roughness: 0.9 }));
    const cliffMatB = this.trackMat(mat(0x232830, { roughness: 0.88 }));
    const shardGeo = this.trackGeo(new THREE.OctahedronGeometry(0.55, 0));
    const shardMat = this.trackMat(
      mat(0x7ec8c4, { emissive: 0x1f6e72, emissiveIntensity: 0.55, roughness: 0.28, metalness: 0.2 }),
    );

    for (let i = 0; i < SEG_COUNT; i++) {
      const group = new THREE.Group();
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.y = -0.19;
      floor.receiveShadow = true;
      group.add(floor);

      const leftEdge = new THREE.Mesh(edgeGeo, edgeMat);
      leftEdge.position.set(-4.35, -0.08, 0);
      leftEdge.receiveShadow = true;
      const rightEdge = new THREE.Mesh(edgeGeo, edgeMat);
      rightEdge.position.set(4.35, -0.08, 0);
      rightEdge.receiveShadow = true;
      group.add(leftEdge, rightEdge);

      for (let li = 0; li < 3; li++) {
        const g = new THREE.Mesh(grooveGeo, li === 1 ? grooveMidMat : grooveMat);
        g.position.set(LANES[li], 0.03, 0);
        group.add(g);
      }

      const cliffs: THREE.Object3D[] = [];
      for (const side of [-1, 1]) {
        for (let c = 0; c < 2; c++) {
          const cliff = new THREE.Mesh(cliffGeo, c % 2 === 0 ? cliffMatA : cliffMatB);
          cliff.position.set(side * 7.1, 4.4, (c - 0.5) * 6.2);
          cliff.castShadow = !this.mobile;
          cliff.receiveShadow = true;
          group.add(cliff);
          cliffs.push(cliff);
        }
      }

      const shards: THREE.Object3D[] = [];
      if (i % 2 === 0) {
        const shard = new THREE.Mesh(shardGeo, shardMat);
        shard.position.set((i % 4 === 0 ? -1 : 1) * (9 + Math.random() * 2), 6 + Math.random() * 3, 0);
        shard.userData.spin = 0.15 + Math.random() * 0.25;
        group.add(shard);
        shards.push(shard);
      }

      this.scene.add(group);
      this.segments.push({ group, cliffs, shards, dyn: [] });
    }

    this.prepPools();
  }

  private makeSky(): THREE.Mesh {
    const geo = this.trackGeo(new THREE.SphereGeometry(200, 20, 14));
    const colors: number[] = [];
    const pos = geo.attributes.position;
    const top = new THREE.Color(0x2a3848);
    const bot = new THREE.Color(0x0a0c12);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 200;
      const t = Math.max(0, Math.min(1, y * 0.65 + 0.38));
      c.copy(bot).lerp(top, t);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const skyMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    return new THREE.Mesh(geo, skyMat);
  }

  private makeStars(): THREE.Points {
    const geo = this.trackGeo(new THREE.BufferGeometry());
    const n = 280;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(0.15 + Math.random() * 0.85);
      const r = 90 + Math.random() * 70;
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.cos(phi);
      arr[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 40;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const matPts = this.trackMat(
      new THREE.PointsMaterial({
        color: 0xd5dde4,
        size: 0.55,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        fog: false,
      }),
    );
    return new THREE.Points(geo, matPts);
  }

  private makeMoon(): THREE.Mesh {
    const geo = this.trackGeo(new THREE.SphereGeometry(5.5, 16, 12));
    const moonMat = this.trackMat(new THREE.MeshBasicMaterial({ color: 0xe7e2d4, fog: false }));
    const moon = new THREE.Mesh(geo, moonMat);
    moon.position.set(-48, 38, -90);
    return moon;
  }

  private prepPools() {
    const crateBody = this.trackGeo(new THREE.BoxGeometry(1.45, 1.15, 1.45));
    const crateLid = this.trackGeo(new THREE.BoxGeometry(1.52, 0.12, 1.52));
    const crateMat = this.trackMat(mat(0x9a5346, { roughness: 0.7 }));
    const crateDark = this.trackMat(mat(0x6e3a32, { roughness: 0.75 }));

    const wallGeo = this.trackGeo(new THREE.BoxGeometry(1.7, 2.7, 0.62));
    const wallMat = this.trackMat(mat(0x2a3038, { roughness: 0.78 }));
    const crackGeo = this.trackGeo(new THREE.BoxGeometry(0.1, 2.2, 0.14));
    const crackMat = this.trackMat(
      mat(0x7ec8c4, { emissive: 0x3aa8a8, emissiveIntensity: 1.4, roughness: 0.3 }),
    );

    const orbGeo = this.trackGeo(new THREE.OctahedronGeometry(0.32, 0));
    const orbMat = this.trackMat(
      mat(0xb8f0ec, { emissive: 0x5ec8c0, emissiveIntensity: 2.1, roughness: 0.22, metalness: 0.15 }),
    );
    const haloGeo = this.trackGeo(new THREE.SphereGeometry(0.55, 10, 8));
    const haloMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x7ec8c4,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );

    const makeCrate = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(crateBody, crateMat);
      body.position.y = 0.58;
      body.castShadow = !this.mobile;
      body.receiveShadow = true;
      const lid = new THREE.Mesh(crateLid, crateDark);
      lid.position.y = 1.2;
      g.add(body, lid);
      g.visible = false;
      this.scene.add(g);
      return g;
    };
    const makeWall = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(wallGeo, wallMat);
      body.position.y = 1.35;
      body.castShadow = !this.mobile;
      const crack = new THREE.Mesh(crackGeo, crackMat);
      crack.position.set(0, 1.35, -0.34);
      g.add(body, crack);
      g.visible = false;
      this.scene.add(g);
      return g;
    };
    const makeOrb = () => {
      const g = new THREE.Group();
      const core = new THREE.Mesh(orbGeo, orbMat);
      const halo = new THREE.Mesh(haloGeo, haloMat);
      g.add(core, halo);
      g.visible = false;
      this.scene.add(g);
      return g;
    };

    for (let i = 0; i < 18; i++) this.cratePool.push(makeCrate());
    for (let i = 0; i < 16; i++) this.wallPool.push(makeWall());
    for (let i = 0; i < 24; i++) this.orbPool.push(makeOrb());
  }

  private buildPlayer() {
    const bone = this.trackMat(mat(0xe4e0d8, { roughness: 0.48, metalness: 0.12 }));
    const ink = this.trackMat(mat(0x2a2d33, { roughness: 0.55 }));
    const visor = this.trackMat(
      mat(0x7ec8c4, { emissive: 0x3aa8b0, emissiveIntensity: 1.3, roughness: 0.25 }),
    );

    const courier = new THREE.Group();
    const torsoGeo = this.trackGeo(new THREE.BoxGeometry(0.56, 0.68, 0.36));
    const torso = new THREE.Mesh(torsoGeo, bone);
    torso.position.y = 0.98;
    torso.castShadow = !this.mobile;
    courier.add(torso);

    const packGeo = this.trackGeo(new THREE.BoxGeometry(0.48, 0.5, 0.22));
    const pack = new THREE.Mesh(packGeo, ink);
    pack.position.set(0, 1.02, 0.26);
    pack.castShadow = !this.mobile;
    courier.add(pack);

    const stripGeo = this.trackGeo(new THREE.BoxGeometry(0.18, 0.42, 0.04));
    const strip = new THREE.Mesh(stripGeo, visor);
    strip.position.set(0, 1.02, 0.38);
    courier.add(strip);

    const headGeo = this.trackGeo(new THREE.SphereGeometry(0.22, 12, 10));
    const head = new THREE.Mesh(headGeo, bone);
    head.position.y = 1.5;
    head.castShadow = !this.mobile;
    courier.add(head);

    const visorGeo = this.trackGeo(new THREE.BoxGeometry(0.34, 0.1, 0.08));
    const visorMesh = new THREE.Mesh(visorGeo, visor);
    visorMesh.position.set(0, 1.5, -0.18);
    courier.add(visorMesh);

    const limbGeo = this.trackGeo(new THREE.BoxGeometry(0.16, 0.58, 0.16));
    const armGeo = this.trackGeo(new THREE.BoxGeometry(0.13, 0.5, 0.13));

    const leftLeg = new THREE.Group();
    leftLeg.position.set(-0.16, 0.62, 0);
    const ll = new THREE.Mesh(limbGeo, ink);
    ll.position.y = -0.28;
    ll.castShadow = !this.mobile;
    leftLeg.add(ll);

    const rightLeg = new THREE.Group();
    rightLeg.position.set(0.16, 0.62, 0);
    const rl = new THREE.Mesh(limbGeo, ink);
    rl.position.y = -0.28;
    rl.castShadow = !this.mobile;
    rightLeg.add(rl);

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.38, 1.18, 0);
    const la = new THREE.Mesh(armGeo, bone);
    la.position.y = -0.22;
    leftArm.add(la);

    const rightArm = new THREE.Group();
    rightArm.position.set(0.38, 1.18, 0);
    const ra = new THREE.Mesh(armGeo, bone);
    ra.position.y = -0.22;
    rightArm.add(ra);

    courier.add(leftLeg, rightLeg, leftArm, rightArm);
    this.parts = { leftLeg, rightLeg, leftArm, rightArm };
    this.courier = courier;

    const lamp = new THREE.PointLight(0x7ec8c4, 0.9, 8, 2);
    lamp.position.set(0, 1.4, -0.4);
    courier.add(lamp);

    this.playerRoot.add(courier);
    this.playerRoot.position.set(0, 0, 0);
    this.scene.add(this.playerRoot);

    const blobGeo = this.trackGeo(new THREE.CircleGeometry(0.42, 16));
    const blobMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      }),
    );
    const blob = new THREE.Mesh(blobGeo, blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.04;
    this.shadowBlob = blob;
    this.scene.add(blob);
  }

  private buildParticles() {
    const geo = this.trackGeo(new THREE.BoxGeometry(0.12, 0.12, 0.12));
    const ice = this.trackMat(new THREE.MeshBasicMaterial({ color: 0x9fe8e4 }));
    const rust = this.trackMat(new THREE.MeshBasicMaterial({ color: 0xc45c4a }));
    this.iceSpark = ice;
    this.rustSpark = rust;
    for (let i = 0; i < 40; i++) {
      const mesh = new THREE.Mesh(geo, i < 24 ? ice : rust);
      mesh.visible = false;
      this.scene.add(mesh);
      this.particles.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    }
  }

  private takePool(kind: HazardKind | "orb"): THREE.Object3D | null {
    const pool = kind === "crate" ? this.cratePool : kind === "wall" ? this.wallPool : this.orbPool;
    const m = pool.pop();
    if (!m) return null;
    m.visible = true;
    return m;
  }

  private givePool(kind: HazardKind | "orb", mesh: THREE.Object3D) {
    mesh.visible = false;
    mesh.position.set(0, -20, 0);
    const pool = kind === "crate" ? this.cratePool : kind === "wall" ? this.wallPool : this.orbPool;
    pool.push(mesh);
  }

  private layoutSegments(hazards: boolean) {
    this.lastHazard = false;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]!;
      this.clearDyn(seg);
      seg.group.position.set(0, 0, -i * SEG_LEN);
      this.jitterCliffs(seg);
      const allow = hazards && i >= 2;
      this.populate(seg, allow);
    }
  }

  private jitterCliffs(seg: Segment) {
    for (const cliff of seg.cliffs) {
      const s = 0.72 + Math.random() * 0.55;
      cliff.scale.set(0.9 + Math.random() * 0.25, s, 0.85 + Math.random() * 0.3);
      cliff.position.y = 5 * s * 0.5 + 0.2;
    }
  }

  private clearDyn(seg: Segment) {
    for (const d of seg.dyn) {
      d.alive = false;
      this.givePool(d.kind, d.mesh);
    }
    seg.dyn.length = 0;
  }

  private addDyn(seg: Segment, kind: HazardKind | "orb", lane: Lane, localZ: number, baseY: number) {
    const mesh = this.takePool(kind);
    if (!mesh) return;
    mesh.position.set(LANES[lane + 1], kind === "orb" ? 0 : 0, 0);
    mesh.position.z = 0;
    const item: DynItem = {
      mesh,
      kind,
      lane,
      localZ,
      baseY,
      phase: Math.random() * Math.PI * 2,
      alive: true,
    };
    seg.dyn.push(item);
    this.placeDyn(seg, item, 0);
  }

  private placeDyn(seg: Segment, item: DynItem, time: number) {
    const x = LANES[item.lane + 1];
    const z = seg.group.position.z + item.localZ;
    let y = item.baseY;
    if (item.kind === "orb") {
      y = item.baseY + Math.sin(time * 5 + item.phase) * 0.12;
      item.mesh.rotation.y = time * 2.2 + item.phase;
      item.mesh.rotation.x = time * 0.8;
    }
    item.mesh.position.set(x, y, z);
  }

  private populate(seg: Segment, hazards: boolean) {
    this.clearDyn(seg);
    if (!hazards) {
      if (Math.random() < 0.45) {
        const lane = randLane();
        for (let i = 0; i < 4; i++) this.addDyn(seg, "orb", lane, -6 + i * 2.2, 1.05);
      }
      return;
    }

    if (this.lastHazard) {
      this.lastHazard = false;
      if (Math.random() < 0.55) {
        const lane = randLane();
        for (let i = 0; i < 3; i++) this.addDyn(seg, "orb", lane, -5 + i * 2.4, 1.05);
      }
      return;
    }

    const r = Math.random();
    const z = (Math.random() - 0.5) * 4;
    if (r < 0.16) {
      const lane = randLane();
      for (let i = 0; i < 4; i++) this.addDyn(seg, "orb", lane, -6 + i * 2.2, 1.05);
      return;
    }
    if (r < 0.4) {
      const lane = randLane();
      this.addDyn(seg, "crate", lane, z, 0);
      if (Math.random() < 0.65) this.addDyn(seg, "orb", lane, z, 2.15);
      this.lastHazard = true;
      return;
    }
    if (r < 0.58) {
      this.addDyn(seg, "wall", randLane(), z, 0);
      this.lastHazard = true;
      return;
    }
    if (r < 0.78) {
      const open = randLane();
      for (const lane of otherLanes(open)) this.addDyn(seg, "wall", lane, z, 0);
      if (Math.random() < 0.5) this.addDyn(seg, "orb", open, z, 1.05);
      this.lastHazard = true;
      return;
    }
    if (r < 0.9) {
      for (const lane of [-1, 0, 1] as Lane[]) {
        this.addDyn(seg, "crate", lane, z, 0);
        if (Math.random() < 0.4) this.addDyn(seg, "orb", lane, z, 2.15);
      }
      this.lastHazard = true;
      return;
    }
    const lane = randLane();
    this.addDyn(seg, "crate", lane, z, 0);
    this.addDyn(seg, "wall", (lane === 0 ? 1 : 0) as Lane, z - 0.2, 0);
    this.lastHazard = true;
  }

  private resetRun(hazards: boolean) {
    this.speed = BASE_SPEED;
    this.distance = 0;
    this.coins = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.score = 0;
    this.lane = 0;
    this.fromLane = 0;
    this.toLane = 0;
    this.laneT = 1;
    this.queued = 0;
    this.hop = 0;
    this.vy = 0;
    this.grounded = true;
    this.coyote = 0;
    this.jumpBuf = 0;
    this.playerX = 0;
    this.playerRoot.position.set(0, 0, 0);
    this.acc = 0;
    this.trauma = 0;
    this.hitstop = 0;
    this.layoutSegments(hazards);
  }

  private bind() {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVis);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    this.ro = new ResizeObserver(() => this.resize());
    const parent = this.canvas.parentElement ?? this.canvas;
    this.ro.observe(parent);
  }

  private unbind() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVis);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("orientationchange", this.onResize);
  }

  private handleKey(e: KeyboardEvent, down: boolean) {
    const code = e.code;
    const gameKey =
      code === "Space" ||
      code === "ArrowLeft" ||
      code === "ArrowRight" ||
      code === "ArrowUp" ||
      code === "KeyA" ||
      code === "KeyD" ||
      code === "KeyW" ||
      code === "Enter";
    if (gameKey) e.preventDefault();
    if (down) this.keys.add(code);
    else this.keys.delete(code);

    if (down && (code === "Space" || code === "Enter") && this.state !== "playing") {
      this.start();
      this.prevHeld.add(code);
      return;
    }
  }

  private ptrDown(e: PointerEvent) {
    if ((e.target as HTMLElement | null)?.closest?.("[data-ui]")) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private ptrUp(e: PointerEvent) {
    const start = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!start) return;
    if ((e.target as HTMLElement | null)?.closest?.("[data-ui]")) return;
    if (this.state !== "playing") {
      this.start();
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) < 28) {
      this.jumpBuf = 0.14;
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      this.trySwitch(dx < 0 ? -1 : 1);
    } else if (dy < 0) {
      this.jumpBuf = 0.14;
    }
  }

  private held(): Set<string> {
    if (this.injected.size === 0) return this.keys;
    const s = new Set(this.keys);
    for (const c of this.injected) s.add(c);
    return s;
  }

  private trySwitch(dir: -1 | 1) {
    if (this.state === "start") return;
    const next = (this.laneT < 1 ? this.toLane : this.lane) + dir;
    if (next < -1 || next > 1) return;
    if (this.laneT < 1) {
      this.queued = dir;
      return;
    }
    this.fromLane = this.lane;
    this.toLane = next as Lane;
    this.laneT = 0;
    this.audio.unlock();
    this.audio.lane();
  }

  private consumeInput() {
    const held = this.held();
    const just = (code: string) => held.has(code) && !this.prevHeld.has(code);

    if (just("KeyA") || just("ArrowLeft")) this.trySwitch(-1);
    if (just("KeyD") || just("ArrowRight")) this.trySwitch(1);
    if (just("Space") || just("ArrowUp")) this.jumpBuf = 0.14;

    if (this.steerInject > 0.5 && this.prevSteer <= 0.5) this.trySwitch(-1);
    if (this.steerInject < -0.5 && this.prevSteer >= -0.5) this.trySwitch(1);
    this.prevSteer = this.steerInject;

    this.prevHeld = new Set(held);
  }

  private step(dt: number) {
    this.consumeInput();
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      return;
    }
    if (this.state === "over") return;

    const scrolling = this.state === "playing" || this.state === "start";
    const spd = this.state === "playing" ? this.speed : 5.5;
    if (!scrolling) return;

    if (this.state === "playing") {
      this.speed = Math.min(MAX_SPEED, this.speed + SPEED_RAMP * dt);
      this.distance += this.speed * dt;
      this.score = Math.floor(this.distance * 10) + this.coins * 40;
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    for (const seg of this.segments) {
      seg.group.position.z += spd * dt;
      if (seg.group.position.z > RECYCLE_Z) {
        seg.group.position.z -= SEG_COUNT * SEG_LEN;
        this.jitterCliffs(seg);
        this.populate(seg, this.state === "playing");
      }
      for (const d of seg.dyn) {
        if (d.alive) this.placeDyn(seg, d, this.time);
      }
    }

    if (this.laneT < 1) {
      this.laneT = Math.min(1, this.laneT + dt / LANE_TIME);
      const t = easeOutCubic(this.laneT);
      this.playerX = LANES[this.fromLane + 1] + (LANES[this.toLane + 1] - LANES[this.fromLane + 1]) * t;
      if (this.laneT >= 1) {
        this.lane = this.toLane;
        this.playerX = LANES[this.lane + 1];
        if (this.queued) {
          const dir = this.queued;
          this.queued = 0;
          this.trySwitch(dir);
        }
      }
    }

    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.coyote = Math.max(0, this.coyote - dt);
    const canJump = this.grounded || this.coyote > 0;
    if (this.jumpBuf > 0 && canJump && this.state === "playing") {
      this.vy = JUMP_V;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuf = 0;
      this.audio.jump();
    }

    if (!this.grounded || this.vy > 0) {
      this.vy -= GRAVITY * dt;
      this.hop += this.vy * dt;
      if (this.hop <= 0) {
        this.hop = 0;
        if (this.vy < -4) this.burst(this.playerX, 0.2, 0, "land");
        this.vy = 0;
        this.grounded = true;
      }
    }

    if (this.grounded) this.coyote = 0.09;

    this.playerRoot.position.x = this.playerX;
    this.playerRoot.position.y = this.hop;
    this.playerRoot.position.z = 0;

    if (this.state === "playing") this.collide();
  }

  private collide() {
    const px = this.playerX;
    const py = 0.78 + this.hop;
    const pz = 0;
    const phx = 0.3;
    const phy = 0.7;
    const phz = 0.32;

    for (const seg of this.segments) {
      for (const d of seg.dyn) {
        if (!d.alive) continue;
        const ox = LANES[d.lane + 1];
        const oz = seg.group.position.z + d.localZ;
        if (d.kind === "orb") {
          const oy = d.baseY;
          if (Math.abs(px - ox) < 0.7 && Math.abs(pz - oz) < 0.7 && Math.abs(py - oy) < 0.9) {
            d.alive = false;
            this.givePool("orb", d.mesh);
            this.combo += 1;
            this.comboTimer = 1.4;
            this.coins += 1;
            this.score = Math.floor(this.distance * 10) + this.coins * 40 + Math.max(0, this.combo - 1) * 8;
            this.audio.coin(this.combo);
            this.burst(ox, oy, oz, "ice");
          }
          continue;
        }
        const hx = d.kind === "crate" ? 0.72 : 0.82;
        const hy = d.kind === "crate" ? 0.58 : 1.32;
        const hz = d.kind === "crate" ? 0.72 : 0.36;
        const oy = d.kind === "crate" ? 0.58 : 1.35;
        if (Math.abs(px - ox) < phx + hx && Math.abs(py - oy) < phy + hy && Math.abs(pz - oz) < phz + hz) {
          this.crash();
          return;
        }
      }
    }
  }

  private crash() {
    this.state = "over";
    this.trauma = this.reduceMotion ? 0.15 : 1;
    this.hitstop = 0.1;
    this.audio.crash();
    this.audio.stopDrone();
    this.burst(this.playerX, 0.9 + this.hop, 0, "rust");
    if (this.score > this.best) {
      this.best = this.score;
      writeBest(this.best);
    }
    this.emit();
  }

  private burst(x: number, y: number, z: number, kind: "ice" | "rust" | "land") {
    let n = kind === "land" ? 6 : 12;
    for (const p of this.particles) {
      if (p.life > 0) continue;
      const ice = kind === "ice" || kind === "land";
      p.mesh.material = kind === "rust" ? this.rustSpark : this.iceSpark;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, z);
      p.vx = (Math.random() - 0.5) * (kind === "land" ? 2.2 : 5);
      p.vy = Math.random() * (kind === "land" ? 2 : 5) + 1;
      p.vz = (Math.random() - 0.5) * (kind === "land" ? 1.4 : 4);
      p.max = 0.35 + Math.random() * 0.25;
      p.life = p.max;
      n -= 1;
      if (n <= 0) break;
    }
  }

  private animateCourier(dt: number) {
    const parts = this.parts;
    if (!parts) return;
    const spd = this.state === "over" ? 0 : this.state === "playing" ? this.speed : 5.5;
    if (this.hop > 0.04) {
      parts.leftLeg.rotation.x = -0.45;
      parts.rightLeg.rotation.x = 0.25;
      parts.leftArm.rotation.x = 0.35;
      parts.rightArm.rotation.x = -0.45;
      const stretch = this.reduceMotion ? 1 : 1 + Math.min(0.18, this.vy * 0.02);
      this.courier.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
    } else {
      this.runPhase += dt * (8 + spd * 0.22);
      const s = Math.sin(this.runPhase);
      parts.leftLeg.rotation.x = s * 0.7;
      parts.rightLeg.rotation.x = -s * 0.7;
      parts.leftArm.rotation.x = -s * 0.5;
      parts.rightArm.rotation.x = s * 0.5;
      const landSquash = this.reduceMotion ? 1 : 1 - Math.min(0.12, Math.abs(this.vy) * 0.01);
      this.courier.scale.set(1 / landSquash, landSquash, 1 / landSquash);
      this.courier.position.y = Math.abs(Math.sin(this.runPhase * 2)) * 0.035;
    }
    if (this.shadowBlob) {
      this.shadowBlob.position.x = this.playerX;
      this.shadowBlob.position.z = 0;
      const k = Math.max(0.25, 1 - this.hop * 0.45);
      this.shadowBlob.scale.setScalar(k);
      const m = this.shadowBlob.material as THREE.MeshBasicMaterial;
      m.opacity = 0.3 * k;
    }
  }

  private updateCamera(dt: number) {
    const lookAhead = this.state === "playing" ? 8 : 6;
    const desiredX = this.playerX * 0.32;
    const desiredY = 3.55 + this.hop * 0.12;
    const desiredZ = 8.1;
    this.camera.position.x = expDamp(this.camera.position.x, desiredX, 6, dt);
    this.camera.position.y = expDamp(this.camera.position.y, desiredY, 5.5, dt);
    this.camera.position.z = expDamp(this.camera.position.z, desiredZ, 5, dt);

    if (this.trauma > 0 && !this.reduceMotion) {
      this.trauma = Math.max(0, this.trauma - dt * 2.8);
      const mag = this.trauma * this.trauma * 0.45;
      this.camera.position.x += (Math.random() - 0.5) * mag;
      this.camera.position.y += (Math.random() - 0.5) * mag * 0.6;
    }

    _world.set(this.playerX * 0.65, 1.15 + this.hop * 0.25, -lookAhead);
    this.camera.lookAt(_world);
    const roll = THREE.MathUtils.clamp(-this.playerX * 0.012, -0.06, 0.06);
    this.camera.rotateZ(roll);

    if (this.sun) {
      this.sun.position.set(8 + this.playerX * 0.2, 22, 8);
      this.sun.target.position.set(this.playerX, 0, -12);
    }
  }

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      if (p.life <= 0) {
        if (p.mesh.visible) p.mesh.visible = false;
        continue;
      }
      p.life -= dt;
      p.vy -= 14 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const s = Math.max(0.05, p.life / p.max);
      p.mesh.scale.setScalar(s);
      if (p.life <= 0) p.mesh.visible = false;
    }
  }

  private frame = (now: number) => {
    if (!this.running || !this.renderer) return;
    const dtRaw = Math.min(0.1, this._last ? (now - this._last) / 1000 : FIXED);
    this._last = now;
    this.time += dtRaw;

    this.acc += dtRaw;
    let steps = 0;
    while (this.acc >= FIXED && steps < 7) {
      this.step(FIXED);
      this.acc -= FIXED;
      steps += 1;
    }

    this.animateCourier(dtRaw);
    this.updateCamera(dtRaw);
    this.updateParticles(dtRaw);
    for (const seg of this.segments) {
      for (const shard of seg.shards) {
        shard.rotation.y += dtRaw * (shard.userData.spin as number);
        shard.rotation.z += dtRaw * 0.08;
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.emitSoft();
  };

  private _last = 0;

  private resize() {
    if (!this.renderer) return;
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private snapshot(): Snapshot {
    return {
      state: this.state,
      score: this.score,
      distance: this.distance,
      coins: this.coins,
      combo: this.combo,
      best: this.best,
      muted: this.muted,
      webgl: !this.failed,
    };
  }

  private emit() {
    const snap = this.snapshot();
    this.lastEmit = `${snap.state}|${snap.score}|${snap.coins}|${snap.combo}|${snap.muted}|${snap.best}`;
    this.onChange(snap);
  }

  private emitSoft() {
    if (this.state !== "playing") return;
    const key = `${this.state}|${this.score}|${this.coins}|${this.combo}|${this.muted}|${this.best}`;
    if (key === this.lastEmit) return;
    this.lastEmit = key;
    this.onChange(this.snapshot());
  }

  private hookControlsTest() {
    window.__controlsTest = {
      getYaw: () => -this.playerX,
      getSpeed: () => (this.state === "playing" ? this.speed : 0),
      setKeys: (codes: string[]) => {
        this.injected = new Set(codes);
      },
      setSteer: (v: number) => {
        this.steerInject = v;
      },
    };
  }
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
    };
  }
}
