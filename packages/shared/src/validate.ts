import { bfsDistances } from "./bfs";
import { edgeCells, getCell, inBounds, isPassableCell } from "./floor";
import { CellType, EdgeType, type Dungeon, type Floor } from "./types";

export const LIMITS = { minSize: 5, maxSize: 64, maxFloors: 20 } as const;

const CELL_VALUES = new Set<number>(Object.values(CellType));
const EDGE_VALUES = new Set<number>(Object.values(EdgeType));

/** Structural checks for a single floor. Returns human-readable errors (empty = ok). */
export function validateFloor(f: Floor, label = `floor ${f.index}`): string[] {
	const e: string[] = [];
	const { width: w, height: h } = f;
	if (!Number.isInteger(w) || !Number.isInteger(h) || w < LIMITS.minSize || h < LIMITS.minSize || w > LIMITS.maxSize || h > LIMITS.maxSize) {
		return [`${label}: size must be integers ${LIMITS.minSize}..${LIMITS.maxSize} (got ${w}x${h})`];
	}
	if (f.cells.length !== w * h) e.push(`${label}: cells length ${f.cells.length} != ${w * h}`);
	if (f.hEdges.length !== w * (h + 1)) e.push(`${label}: hEdges length ${f.hEdges.length} != ${w * (h + 1)}`);
	if (f.vEdges.length !== (w + 1) * h) e.push(`${label}: vEdges length ${f.vEdges.length} != ${(w + 1) * h}`);
	if (e.length) return e;

	if (f.cells.some((c) => !CELL_VALUES.has(c))) e.push(`${label}: unknown cell value`);
	if (f.hEdges.some((c) => !EDGE_VALUES.has(c)) || f.vEdges.some((c) => !EDGE_VALUES.has(c))) {
		e.push(`${label}: unknown edge value`);
	}
	if (e.length) return e;

	for (const kind of ["h", "v"] as const) {
		const arr = kind === "h" ? f.hEdges : f.vEdges;
		for (let i = 0; i < arr.length; i++) {
			if (arr[i] !== EdgeType.OPEN) continue;
			const [a, b] = edgeCells(f, { kind, index: i });
			if (!inBounds(f, a.x, a.y) || !inBounds(f, b.x, b.y)) {
				e.push(`${label}: perimeter edge ${kind}[${i}] must be WALL`);
			} else if (!isPassableCell(f, a.x, a.y) || !isPassableCell(f, b.x, b.y)) {
				e.push(`${label}: edge ${kind}[${i}] touches a VOID cell and must be WALL`);
			}
		}
	}

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const t = getCell(f, x, y);
			const key = `${x},${y}`;
			if (t === CellType.CHEST && !f.chests[key]) e.push(`${label}: chest cell (${key}) has no chest info`);
			if ((t === CellType.STAIRS_DOWN || t === CellType.STAIRS_UP) && !f.links.some((l) => l.from.x === x && l.from.y === y)) {
				e.push(`${label}: stairs at (${key}) have no link`);
			}
		}
	}
	for (const key of Object.keys(f.chests)) {
		const [x, y] = key.split(",").map(Number);
		if (getCell(f, x!, y!) !== CellType.CHEST) e.push(`${label}: chest info at (${key}) but cell is not a chest`);
	}
	for (const l of f.links) {
		const t = getCell(f, l.from.x, l.from.y);
		if (t !== CellType.STAIRS_DOWN && t !== CellType.STAIRS_UP) {
			e.push(`${label}: link from (${l.from.x},${l.from.y}) is not on a stairs cell`);
		}
	}
	return e;
}

export interface ValidateOptions {
	/** also require every chest/stairs be reachable from the start (across floors) */
	forPublish?: boolean;
}

export function validateDungeon(d: Dungeon, opts: ValidateOptions = {}): string[] {
	const e: string[] = [];
	if (d.floors.length < 1) return ["dungeon must have at least one floor"];
	if (d.floors.length > LIMITS.maxFloors) e.push(`too many floors (max ${LIMITS.maxFloors})`);
	d.floors.forEach((f, i) => {
		if (f.index !== i) e.push(`floor at position ${i} has index ${f.index}`);
		e.push(...validateFloor(f, `floor ${i}`));
	});
	if (e.length) return e;

	const sp = d.startPoint;
	const sf = d.floors[sp.floor];
	if (!sf) return [...e, "startPoint: floor does not exist"];
	if (!isPassableCell(sf, sp.x, sp.y)) e.push("startPoint: not on a non-VOID cell");

	for (const f of d.floors) {
		for (const l of f.links) {
			const tf = d.floors[l.to.floor];
			if (!tf) e.push(`floor ${f.index}: link target floor ${l.to.floor} does not exist`);
			else if (!isPassableCell(tf, l.to.x, l.to.y)) {
				e.push(`floor ${f.index}: link target (${l.to.x},${l.to.y}) on floor ${l.to.floor} is not a non-VOID cell`);
			}
		}
	}
	if (e.length || !opts.forPublish) return e;

	// Reachability across floors: BFS per floor from entry points, expanded via links.
	const pending: { floor: number; x: number; y: number }[] = [{ floor: sp.floor, x: sp.x, y: sp.y }];
	const reached = d.floors.map((f) => new Uint8Array(f.width * f.height));
	const seenEntry = new Set<string>();
	while (pending.length) {
		const p = pending.pop()!;
		const ek = `${p.floor}:${p.x},${p.y}`;
		if (seenEntry.has(ek)) continue;
		seenEntry.add(ek);
		const f = d.floors[p.floor]!;
		const dist = bfsDistances(f, p.x, p.y);
		for (let i = 0; i < dist.length; i++) {
			if (dist[i]! < 0) continue;
			reached[p.floor]![i] = 1;
			const x = i % f.width;
			const y = Math.floor(i / f.width);
			for (const l of f.links) {
				if (l.from.x === x && l.from.y === y) pending.push({ floor: l.to.floor, x: l.to.x, y: l.to.y });
			}
		}
	}
	for (const f of d.floors) {
		for (let y = 0; y < f.height; y++) {
			for (let x = 0; x < f.width; x++) {
				const t = getCell(f, x, y);
				if (t === CellType.CHEST || t === CellType.STAIRS_DOWN || t === CellType.STAIRS_UP) {
					if (!reached[f.index]![y * f.width + x]) e.push(`floor ${f.index}: (${x},${y}) is unreachable from the start`);
				}
			}
		}
	}
	return e;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isIntArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);

/**
 * Shape check for untrusted JSON (types only, no game rules). Run this before
 * validateDungeon, which assumes well-typed input.
 */
export function validateDungeonShape(x: unknown): string[] {
	if (typeof x !== "object" || x === null || Array.isArray(x)) return ["dungeon must be an object"];
	const d = x as Record<string, unknown>;
	const e: string[] = [];
	if (typeof d.id !== "string") e.push("id must be a string");
	if (typeof d.name !== "string") e.push("name must be a string");
	const sp = d.startPoint as Record<string, unknown> | undefined;
	if (!sp || !isInt(sp.floor) || !isInt(sp.x) || !isInt(sp.y) || !isInt(sp.dir) || sp.dir < 0 || sp.dir > 3) {
		e.push("startPoint must be {floor,x,y,dir}");
	}
	if (!Array.isArray(d.floors)) return [...e, "floors must be an array"];
	d.floors.forEach((f: unknown, i: number) => {
		const g = f as Record<string, unknown> | null;
		if (typeof g !== "object" || g === null) return e.push(`floor ${i}: must be an object`);
		if (!isInt(g.index) || !isInt(g.width) || !isInt(g.height)) e.push(`floor ${i}: index/width/height must be integers`);
		if (!isIntArray(g.cells) || !isIntArray(g.hEdges) || !isIntArray(g.vEdges)) e.push(`floor ${i}: cells/hEdges/vEdges must be integer arrays`);
		if (!Array.isArray(g.links)) e.push(`floor ${i}: links must be an array`);
		else
			for (const l of g.links as Record<string, any>[]) {
				const to = l?.to, from = l?.from;
				if (!from || !to || !isInt(from.x) || !isInt(from.y) || !isInt(to.floor) || !isInt(to.x) || !isInt(to.y) || !isInt(to.dir) || to.dir < 0 || to.dir > 3) {
					e.push(`floor ${i}: malformed link`);
					break;
				}
			}
		const ch = g.chests;
		if (typeof ch !== "object" || ch === null || Array.isArray(ch)) e.push(`floor ${i}: chests must be an object`);
		else if (Object.values(ch).some((c) => typeof (c as any)?.id !== "string")) e.push(`floor ${i}: chest without id`);
	});
	return e;
}
