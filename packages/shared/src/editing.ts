import { farthestCell, openDirs } from "./bfs";
import { generateFloor } from "./generator";
import {
	DX, DY, canMove, createFloor, edgeCells, edgeRef, getCell, getEdgeByRef, inBounds, isPassableCell,
	normalizeEdges, resizeFloor, setCell, setEdge, setEdgeByRef,
} from "./floor";
import { linkStairs } from "./stairs";
import { CellType, EdgeType, type Dir, type Dungeon, type EdgeRef, type Floor } from "./types";

/* Pure editing operations used by the map editor. All mutate their arguments in place;
 * callers snapshot (structuredClone) before applying if they want undo. */

export type HitTarget =
	| { type: "cell"; x: number; y: number }
	| { type: "edge"; ref: EdgeRef };

/**
 * Map a point in cell units (0..width, 0..height) to the thing under the cursor:
 * near a cell border (within `band`) -> that edge, otherwise the cell.
 */
export function hitTest(f: Floor, px: number, py: number, band = 0.2): HitTarget | null {
	if (px < 0 || py < 0 || px > f.width || py > f.height) return null;
	const x = Math.min(f.width - 1, Math.floor(px));
	const y = Math.min(f.height - 1, Math.floor(py));
	const fx = px - x, fy = py - y;
	const cands: [number, Dir][] = [[fy, 0], [1 - fx, 1], [1 - fy, 2], [fx, 3]];
	const [dist, dir] = cands.reduce((a, b) => (b[0] < a[0] ? b : a));
	if (dist < band) return { type: "edge", ref: edgeRef(f, x, y, dir) };
	return { type: "cell", x, y };
}

/** An edge is editable only between two real (non-VOID, in-bounds) cells. */
export function isEdgeEditable(f: Floor, ref: EdgeRef): boolean {
	const [a, b] = edgeCells(f, ref);
	return isPassableCell(f, a.x, a.y) && isPassableCell(f, b.x, b.y);
}

/** Set an edge if editable. Returns true when the value changed. */
export function setEdgeChecked(f: Floor, ref: EdgeRef, value: EdgeType): boolean {
	if (!isEdgeEditable(f, ref) || getEdgeByRef(f, ref) === value) return false;
	setEdgeByRef(f, ref, value);
	return true;
}

export function toggleEdge(f: Floor, ref: EdgeRef): EdgeType | null {
	if (!isEdgeEditable(f, ref)) return null;
	const next = getEdgeByRef(f, ref) === EdgeType.WALL ? EdgeType.OPEN : EdgeType.WALL;
	setEdgeByRef(f, ref, next);
	return next;
}

const DIRS: Dir[] = [0, 1, 2, 3];

/** Wall in/out edges of a newly created cell: OPEN toward existing cells, WALL toward VOID/outside. */
function connectNewCell(f: Floor, x: number, y: number) {
	for (const d of DIRS) {
		const nx = x + DX[d], ny = y + DY[d];
		setEdge(f, x, y, d, isPassableCell(f, nx, ny) ? EdgeType.OPEN : EdgeType.WALL);
	}
}

const chestId = (fi: number, x: number, y: number) => `f${fi}-${x}-${y}`;
const key = (x: number, y: number) => `${x},${y}`;

/** Make (x,y) a non-stairs, non-chest, non-VOID cell first (helper). */
function ensureCell(f: Floor, x: number, y: number, autoWalls: boolean) {
	if (getCell(f, x, y) === CellType.VOID) {
		setCell(f, x, y, CellType.FLOOR);
		if (autoWalls) connectNewCell(f, x, y);
	}
}

/**
 * Paint a cell as VOID / FLOOR / CHEST. Handles chests and stairs bookkeeping:
 * overwriting stairs removes both ends of the link.
 */
export function paintCell(d: Dungeon, fi: number, x: number, y: number, type: 0 | 1 | 2, autoWalls = true): void {
	const f = d.floors[fi];
	if (!f || !inBounds(f, x, y)) return;
	const cur = getCell(f, x, y);
	if (cur === CellType.STAIRS_DOWN || cur === CellType.STAIRS_UP) removeStairs(d, fi, x, y);
	if (getCell(f, x, y) === CellType.CHEST && type !== CellType.CHEST) delete f.chests[key(x, y)];

	if (type === CellType.VOID) {
		setCell(f, x, y, CellType.VOID);
		normalizeEdges(f);
		return;
	}
	ensureCell(f, x, y, autoWalls);
	setCell(f, x, y, type);
	if (type === CellType.CHEST) f.chests[key(x, y)] = f.chests[key(x, y)] ?? { id: chestId(fi, x, y) };
}

/** Preferred arrival direction for a stairs cell: keep `prefer` if usable, else the first open side. */
function arrivalDir(f: Floor, x: number, y: number, prefer?: Dir): Dir {
	if (prefer !== undefined && canMove(f, x, y, prefer)) return prefer;
	return openDirs(f, x, y)[0] ?? prefer ?? 0;
}

/**
 * Place stairs at (x,y) on floor `fi` and create the paired stairs on the adjacent floor
 * (down -> fi+1 gets STAIRS_UP, up -> fi-1 gets STAIRS_DOWN) at the same coordinates
 * (clamped if that floor is smaller). Returns an error message, or null on success.
 */
export function placeStairs(d: Dungeon, fi: number, x: number, y: number, kind: "down" | "up"): string | null {
	const f = d.floors[fi];
	const ti = kind === "down" ? fi + 1 : fi - 1;
	const tf = d.floors[ti];
	if (!f || !inBounds(f, x, y)) return "out of bounds";
	if (!tf) return kind === "down" ? "下の階がありません" : "上の階がありません";

	const tx = Math.min(x, tf.width - 1), ty = Math.min(y, tf.height - 1);
	for (const [g, gi, gx, gy] of [[f, fi, x, y], [tf, ti, tx, ty]] as const) {
		const t = getCell(g, gx, gy);
		if (t === CellType.STAIRS_DOWN || t === CellType.STAIRS_UP) removeStairs(d, gi, gx, gy);
		if (getCell(g, gx, gy) === CellType.CHEST) delete g.chests[key(gx, gy)];
		ensureCell(g, gx, gy, true);
	}
	setCell(f, x, y, kind === "down" ? CellType.STAIRS_DOWN : CellType.STAIRS_UP);
	setCell(tf, tx, ty, kind === "down" ? CellType.STAIRS_UP : CellType.STAIRS_DOWN);
	f.links.push({ from: { x, y }, to: { floor: ti, x: tx, y: ty, dir: arrivalDir(tf, tx, ty) } });
	tf.links.push({ from: { x: tx, y: ty }, to: { floor: fi, x, y, dir: arrivalDir(f, x, y) } });
	return null;
}

/** Remove the stairs at (x,y) and its paired stairs; both cells become FLOOR. */
export function removeStairs(d: Dungeon, fi: number, x: number, y: number): void {
	const f = d.floors[fi];
	if (!f) return;
	const link = f.links.find((l) => l.from.x === x && l.from.y === y);
	f.links = f.links.filter((l) => l !== link);
	const t = getCell(f, x, y);
	if (t === CellType.STAIRS_DOWN || t === CellType.STAIRS_UP) setCell(f, x, y, CellType.FLOOR);
	if (!link) return;
	const tf = d.floors[link.to.floor];
	if (!tf) return;
	const back = tf.links.find((l) => l.from.x === link.to.x && l.from.y === link.to.y);
	if (back && back.to.floor === fi && back.to.x === x && back.to.y === y) {
		tf.links = tf.links.filter((l) => l !== back);
		const tt = getCell(tf, link.to.x, link.to.y);
		if (tt === CellType.STAIRS_DOWN || tt === CellType.STAIRS_UP) setCell(tf, link.to.x, link.to.y, CellType.FLOOR);
	}
}

/**
 * Rectangle tool: cells in the rectangle that are VOID become FLOOR, every edge inside becomes
 * OPEN, and the rectangle's outline becomes WALL.
 */
export function fillRoom(f: Floor, x0: number, y0: number, x1: number, y1: number): void {
	const ax = Math.max(0, Math.min(x0, x1)), bx = Math.min(f.width - 1, Math.max(x0, x1));
	const ay = Math.max(0, Math.min(y0, y1)), by = Math.min(f.height - 1, Math.max(y0, y1));
	for (let y = ay; y <= by; y++)
		for (let x = ax; x <= bx; x++) {
			if (getCell(f, x, y) === CellType.VOID) setCell(f, x, y, CellType.FLOOR);
			if (x < bx) setEdge(f, x, y, 1, EdgeType.OPEN);
			if (y < by) setEdge(f, x, y, 2, EdgeType.OPEN);
		}
	for (let x = ax; x <= bx; x++) {
		setEdge(f, x, ay, 0, EdgeType.WALL);
		setEdge(f, x, by, 2, EdgeType.WALL);
	}
	for (let y = ay; y <= by; y++) {
		setEdge(f, ax, y, 3, EdgeType.WALL);
		setEdge(f, bx, y, 1, EdgeType.WALL);
	}
	normalizeEdges(f);
}

/** A closed room: all cells FLOOR, interior edges OPEN, perimeter WALL. */
export function createRoomFloor(index: number, width: number, height: number): Floor {
	const f = createFloor(index, width, height, CellType.FLOOR);
	fillRoom(f, 0, 0, width - 1, height - 1);
	return f;
}

export function setStart(d: Dungeon, fi: number, x: number, y: number, dir: Dir): boolean {
	const f = d.floors[fi];
	if (!f || !isPassableCell(f, x, y)) return false;
	d.startPoint = { floor: fi, x, y, dir };
	return true;
}

export function addFloor(d: Dungeon, width: number, height: number): Floor {
	const f = createRoomFloor(d.floors.length, width, height);
	d.floors.push(f);
	return f;
}

/** Remove a floor (at least one must remain). Paired stairs on other floors are removed. */
export function removeFloor(d: Dungeon, idx: number): boolean {
	if (d.floors.length <= 1 || !d.floors[idx]) return false;
	for (const f of d.floors) {
		for (const l of [...f.links]) if (l.to.floor === idx) removeStairs(d, f.index, l.from.x, l.from.y);
	}
	d.floors.splice(idx, 1);
	d.floors.forEach((f, i) => {
		f.index = i;
		for (const l of f.links) if (l.to.floor > idx) l.to.floor -= 1;
	});
	if (d.startPoint.floor === idx) d.startPoint = { ...d.startPoint, floor: 0 };
	else if (d.startPoint.floor > idx) d.startPoint = { ...d.startPoint, floor: d.startPoint.floor - 1 };
	sanitizeDungeon(d);
	return true;
}

/** Resize one floor (top-left anchored) and repair anything that pointed into the removed area. */
export function resizeDungeonFloor(d: Dungeon, idx: number, width: number, height: number): void {
	const f = d.floors[idx];
	if (!f) return;
	d.floors[idx] = resizeFloor(f, width, height);
	sanitizeDungeon(d);
}

/** Replace a floor's content with a generated maze (same size). Stairs are re-created if asked. */
export function regenerateFloor(d: Dungeon, idx: number, seed: number, withStairs: boolean): void {
	const old = d.floors[idx];
	if (!old) return;
	// drop old stairs (and their partners) first so no dangling links remain
	for (const l of [...old.links]) removeStairs(d, idx, l.from.x, l.from.y);
	const g = generateFloor({ index: idx, width: old.width, height: old.height, seed });
	d.floors[idx] = g.floor;
	if (withStairs) {
		const last = d.floors.length - 1;
		if (idx > 0) placeStairs(d, idx, g.start.x, g.start.y, "up");
		if (idx < last) {
			const far = farthestCell(g.floor, g.start.x, g.start.y);
			placeStairs(d, idx, far.x, far.y, "down");
		}
	}
	sanitizeDungeon(d);
}

/**
 * Bring a dungeon back to a consistent state after structural edits:
 * edge invariants, chest table, stairs<->links reciprocity, arrival directions, start point.
 */
export function sanitizeDungeon(d: Dungeon): void {
	d.floors.forEach((f, i) => {
		f.index = i;
		normalizeEdges(f);
		for (const k of Object.keys(f.chests)) {
			const [x, y] = k.split(",").map(Number) as [number, number];
			if (getCell(f, x, y) !== CellType.CHEST) delete f.chests[k];
		}
		for (let y = 0; y < f.height; y++)
			for (let x = 0; x < f.width; x++)
				if (getCell(f, x, y) === CellType.CHEST && !f.chests[key(x, y)]) f.chests[key(x, y)] = { id: chestId(i, x, y) };
		const seen = new Set<string>();
		f.links = f.links.filter((l) => {
			const k = key(l.from.x, l.from.y);
			const t = getCell(f, l.from.x, l.from.y);
			if (seen.has(k) || (t !== CellType.STAIRS_DOWN && t !== CellType.STAIRS_UP)) return false;
			seen.add(k);
			return true;
		});
	});

	const opposite = (t: number) => (t === CellType.STAIRS_DOWN ? CellType.STAIRS_UP : CellType.STAIRS_DOWN);
	for (let changed = true; changed; ) {
		changed = false;
		for (const f of d.floors) {
			for (let y = 0; y < f.height; y++)
				for (let x = 0; x < f.width; x++) {
					const t = getCell(f, x, y);
					if (t !== CellType.STAIRS_DOWN && t !== CellType.STAIRS_UP) continue;
					const link = f.links.find((l) => l.from.x === x && l.from.y === y);
					const tf = link ? d.floors[link.to.floor] : undefined;
					const back = link && tf ? tf.links.find((l) => l.from.x === link.to.x && l.from.y === link.to.y) : undefined;
					const ok =
						link && tf && getCell(tf, link.to.x, link.to.y) === opposite(t) &&
						back && back.to.floor === f.index && back.to.x === x && back.to.y === y;
					if (!ok) {
						f.links = f.links.filter((l) => l !== link);
						setCell(f, x, y, CellType.FLOOR);
						changed = true;
					}
				}
		}
	}

	for (const f of d.floors)
		for (const l of f.links) {
			const tf = d.floors[l.to.floor];
			if (tf) l.to.dir = arrivalDir(tf, l.to.x, l.to.y, l.to.dir);
		}

	const sp = d.startPoint;
	const sf = d.floors[sp.floor];
	if (!sf || !isPassableCell(sf, sp.x, sp.y)) {
		const f0 = d.floors[0];
		if (f0) {
			for (let y = 0; y < f0.height; y++)
				for (let x = 0; x < f0.width; x++)
					if (isPassableCell(f0, x, y)) {
						d.startPoint = { floor: 0, x, y, dir: arrivalDir(f0, x, y) };
						return;
					}
		}
	}
}

export interface CreateDungeonOptions {
	id: string;
	name: string;
	width?: number; // default 10
	height?: number; // default 10
	floors?: number; // default 1
	generate?: boolean;
	seed?: number;
	now?: string;
}

/** A new dungeon: closed rooms (or generated mazes), stairs linked between floors. */
export function createDungeon(o: CreateDungeonOptions): Dungeon {
	const w = o.width ?? 10, h = o.height ?? 10, n = o.floors ?? 1;
	const seed = o.seed ?? 1;
	let floors: Floor[];
	let start: { x: number; y: number };
	let dir: Dir = 1;
	if (o.generate) {
		const gens = Array.from({ length: n }, (_, i) =>
			generateFloor({ index: i, width: w, height: h, seed: seed + i, upStairs: i > 0, downStairs: i < n - 1 }),
		);
		floors = linkStairs(gens.map((g) => g.floor));
		start = gens[0]!.start;
		dir = arrivalDir(floors[0]!, start.x, start.y);
	} else {
		floors = Array.from({ length: n }, (_, i) => createRoomFloor(i, w, h));
		start = { x: 0, y: 0 };
	}
	const d: Dungeon = {
		id: o.id, name: o.name, revision: 0, updatedAt: o.now ?? new Date(0).toISOString(),
		startPoint: { floor: 0, x: start.x, y: start.y, dir },
		floors,
	};
	if (!o.generate) {
		for (let i = 0; i + 1 < n; i++) placeStairs(d, i, i % 2 === 0 ? w - 1 : 0, h - 1, "down");
		d.startPoint.dir = arrivalDir(floors[0]!, 0, 0, 1);
	}
	sanitizeDungeon(d);
	return d;
}
