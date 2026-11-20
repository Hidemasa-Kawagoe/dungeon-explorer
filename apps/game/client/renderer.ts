import * as THREE from "three";
import { CellType, EdgeType, edgeCells, getCell, isPassableCell, type Floor } from "@dungeon/shared";

function stoneTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = c.height = 128;
	const g = c.getContext("2d")!;
	g.fillStyle = "#6b6259";
	g.fillRect(0, 0, 128, 128);
	for (let row = 0; row < 4; row++) {
		const off = row % 2 ? 16 : 0;
		for (let col = -1; col < 4; col++) {
			const shade = 90 + Math.floor(Math.random() * 40);
			g.fillStyle = `rgb(${shade + 8},${shade},${shade - 10})`;
			g.fillRect(col * 32 + off + 1, row * 32 + 1, 30, 30);
		}
	}
	const t = new THREE.CanvasTexture(c);
	t.colorSpace = THREE.SRGBColorSpace;
	t.magFilter = THREE.NearestFilter;
	return t;
}

function flatTexture(a: string, b: string): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = c.height = 64;
	const g = c.getContext("2d")!;
	for (let y = 0; y < 2; y++)
		for (let x = 0; x < 2; x++) {
			g.fillStyle = (x + y) % 2 ? a : b;
			g.fillRect(x * 32, y * 32, 32, 32);
		}
	const t = new THREE.CanvasTexture(c);
	t.colorSpace = THREE.SRGBColorSpace;
	t.magFilter = THREE.NearestFilter;
	return t;
}

/** Quads (4 verts each) accumulated into one BufferGeometry. */
class QuadBuilder {
	pos: number[] = [];
	uv: number[] = [];
	idx: number[] = [];
	quad(a: number[], b: number[], c: number[], d: number[]) {
		const base = this.pos.length / 3;
		this.pos.push(...a, ...b, ...c, ...d);
		this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
		this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}
	build(): THREE.BufferGeometry {
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
		g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
		g.setIndex(this.idx);
		g.computeVertexNormals();
		return g;
	}
}

export class FloorRenderer {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);
	private light = new THREE.PointLight(0xffd9a0, 1.6, 9, 2);
	private group = new THREE.Group();
	private chests = new Map<string, THREE.Mesh>();
	private wallMat = new THREE.MeshLambertMaterial({ map: stoneTexture(), side: THREE.DoubleSide });
	private floorMat = new THREE.MeshLambertMaterial({ map: flatTexture("#3a352f", "#34302a"), side: THREE.DoubleSide });
	private ceilMat = new THREE.MeshLambertMaterial({ map: flatTexture("#262329", "#222025"), side: THREE.DoubleSide });

	constructor(private canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.scene.background = new THREE.Color(0x000000);
		this.scene.fog = new THREE.FogExp2(0x000000, 0.22);
		this.scene.add(new THREE.AmbientLight(0x404050, 0.6), this.light, this.group);
		this.camera.rotation.order = "YXZ";
		window.addEventListener("resize", () => this.resize());
		this.resize();
	}

	resize() {
		const w = window.innerWidth, h = window.innerHeight;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	/** Rebuild all geometry for a floor. */
	setFloor(f: Floor, opened: ReadonlySet<string>) {
		for (const child of [...this.group.children]) {
			this.group.remove(child);
			(child as THREE.Mesh).geometry?.dispose();
		}
		this.chests.clear();

		const walls = new QuadBuilder(), floors = new QuadBuilder(), ceils = new QuadBuilder();
		for (const kind of ["h", "v"] as const) {
			const arr = kind === "h" ? f.hEdges : f.vEdges;
			for (let i = 0; i < arr.length; i++) {
				if (arr[i] !== EdgeType.WALL) continue;
				const [a, b] = edgeCells(f, { kind, index: i });
				if (!isPassableCell(f, a.x, a.y) && !isPassableCell(f, b.x, b.y)) continue;
				const x = b.x, z = b.y; // edge starts at the corner of the "second" cell
				if (kind === "h") walls.quad([x, 0, z], [x + 1, 0, z], [x + 1, 1, z], [x, 1, z]);
				else walls.quad([x, 0, z], [x, 0, z + 1], [x, 1, z + 1], [x, 1, z]);
			}
		}
		for (let y = 0; y < f.height; y++)
			for (let x = 0; x < f.width; x++) {
				if (!isPassableCell(f, x, y)) continue;
				floors.quad([x, 0, y], [x + 1, 0, y], [x + 1, 0, y + 1], [x, 0, y + 1]);
				ceils.quad([x, 1, y], [x + 1, 1, y], [x + 1, 1, y + 1], [x, 1, y + 1]);
				const t = getCell(f, x, y);
				if (t === CellType.CHEST) this.addChest(f.index, x, y, opened.has(`${f.index}:${x},${y}`));
				else if (t === CellType.STAIRS_DOWN) this.addStairs(x, y, false);
				else if (t === CellType.STAIRS_UP) this.addStairs(x, y, true);
			}
		this.group.add(
			new THREE.Mesh(walls.build(), this.wallMat),
			new THREE.Mesh(floors.build(), this.floorMat),
			new THREE.Mesh(ceils.build(), this.ceilMat),
		);
	}

	private addChest(floor: number, x: number, y: number, opened: boolean) {
		const m = new THREE.Mesh(
			new THREE.BoxGeometry(0.5, 0.32, 0.34),
			new THREE.MeshLambertMaterial({ color: 0xb07a2a }),
		);
		m.position.set(x + 0.5, 0.16, y + 0.5);
		this.group.add(m);
		this.chests.set(`${floor}:${x},${y}`, m);
		if (opened) this.markOpened(m);
	}

	private markOpened(m: THREE.Mesh) {
		(m.material as THREE.MeshLambertMaterial).color.set(0x3a3228);
		m.scale.y = 0.6;
		m.position.y = 0.1;
	}

	setChestOpened(key: string) {
		const m = this.chests.get(key);
		if (m) this.markOpened(m);
	}

	private addStairs(x: number, y: number, up: boolean) {
		const color = up ? 0xe8a24a : 0x4ab0e8;
		const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.35 });
		for (let i = 0; i < 4; i++) {
			const h = up ? 0.12 + i * 0.12 : 0.5 - i * 0.12;
			const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 0.7), mat);
			m.position.set(x + 0.2 + i * 0.2, h / 2, y + 0.5);
			this.group.add(m);
		}
	}

	/** Camera at cell coordinates (continuous). yaw: 0 faces north; each right turn subtracts PI/2. */
	setCamera(cx: number, cy: number, yaw: number) {
		this.camera.position.set(cx + 0.5, 0.5, cy + 0.5);
		this.camera.rotation.y = yaw;
		this.light.position.copy(this.camera.position);
	}

	render() {
		this.renderer.render(this.scene, this.camera);
	}
}
