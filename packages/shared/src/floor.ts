import {
	CellType,
	EdgeType,
	type Dir,
	type EdgeRef,
	type Floor,
	type Pos,
} from "./types";

export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export function opposite(dir: Dir): Dir {
	return ((dir + 2) % 4) as Dir;
}

/** Create a floor: all cells `fill`, all edges WALL. */
export function createFloor(
	index: number,
	width: number,
	height: number,
	fill: CellType = CellType.FLOOR,
): Floor {
	return {
		index,
		width,
		height,
		cells: new Array<number>(width * height).fill(fill),
		hEdges: new Array<number>(width * (height + 1)).fill(EdgeType.WALL),
		vEdges: new Array<number>((width + 1) * height).fill(EdgeType.WALL),
		links: [],
		chests: {},
	};
}

export function inBounds(f: Floor, x: number, y: number): boolean {
	return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < f.width && y < f.height;
}

export function cellIndex(f: Floor, x: number, y: number): number {
	return y * f.width + x;
}

/** Cell type, or VOID when out of bounds. */
export function getCell(f: Floor, x: number, y: number): number {
	return inBounds(f, x, y) ? (f.cells[cellIndex(f, x, y)] ?? CellType.VOID) : CellType.VOID;
}

export function setCell(f: Floor, x: number, y: number, type: CellType): void {
	if (inBounds(f, x, y)) f.cells[cellIndex(f, x, y)] = type;
}

/** The edge on side `dir` of cell (x,y). */
export function edgeRef(f: Floor, x: number, y: number, dir: Dir): EdgeRef {
	switch (dir) {
		case 0:
			return { kind: "h", index: y * f.width + x };
		case 2:
			return { kind: "h", index: (y + 1) * f.width + x };
		case 3:
			return { kind: "v", index: y * (f.width + 1) + x };
		case 1:
			return { kind: "v", index: y * (f.width + 1) + x + 1 };
	}
}

export function getEdgeByRef(f: Floor, ref: EdgeRef): number {
	const arr = ref.kind === "h" ? f.hEdges : f.vEdges;
	return arr[ref.index] ?? EdgeType.WALL;
}

export function setEdgeByRef(f: Floor, ref: EdgeRef, value: EdgeType): void {
	const arr = ref.kind === "h" ? f.hEdges : f.vEdges;
	if (ref.index >= 0 && ref.index < arr.length) arr[ref.index] = value;
}

export function getEdge(f: Floor, x: number, y: number, dir: Dir): number {
	return getEdgeByRef(f, edgeRef(f, x, y, dir));
}

export function setEdge(f: Floor, x: number, y: number, dir: Dir, value: EdgeType): void {
	setEdgeByRef(f, edgeRef(f, x, y, dir), value);
}

/** The (up to two) cells an edge separates. Positions may be out of bounds. */
export function edgeCells(f: Floor, ref: EdgeRef): [Pos, Pos] {
	if (ref.kind === "h") {
		const x = ref.index % f.width;
		const y = Math.floor(ref.index / f.width);
		return [
			{ x, y: y - 1 },
			{ x, y },
		];
	}
	const x = ref.index % (f.width + 1);
	const y = Math.floor(ref.index / (f.width + 1));
	return [
		{ x: x - 1, y },
		{ x, y },
	];
}

export function isPassableCell(f: Floor, x: number, y: number): boolean {
	return inBounds(f, x, y) && getCell(f, x, y) !== CellType.VOID;
}

/** Movement rule: edge is OPEN and both cells are in bounds and non-VOID. */
export function canMove(f: Floor, x: number, y: number, dir: Dir): boolean {
	if (!isPassableCell(f, x, y)) return false;
	const nx = x + DX[dir];
	const ny = y + DY[dir];
	if (!isPassableCell(f, nx, ny)) return false;
	return getEdge(f, x, y, dir) === EdgeType.OPEN;
}

/**
 * Enforce edge invariants: perimeter edges are WALL; any edge touching a
 * VOID cell (or the outside) is WALL. Mutates and returns the floor.
 */
export function normalizeEdges(f: Floor): Floor {
	const fix = (kind: "h" | "v", arr: number[]) => {
		for (let i = 0; i < arr.length; i++) {
			const [a, b] = edgeCells(f, { kind, index: i });
			if (!isPassableCell(f, a.x, a.y) || !isPassableCell(f, b.x, b.y)) {
				arr[i] = EdgeType.WALL;
			}
		}
	};
	fix("h", f.hEdges);
	fix("v", f.vEdges);
	return f;
}

/** Cell-grid resize: keeps top-left content; new cells VOID; edges rebuilt as WALL where new. */
export function resizeFloor(f: Floor, width: number, height: number): Floor {
	const n = createFloor(f.index, width, height, CellType.VOID);
	for (let y = 0; y < Math.min(height, f.height); y++) {
		for (let x = 0; x < Math.min(width, f.width); x++) {
			n.cells[y * width + x] = f.cells[y * f.width + x] ?? CellType.VOID;
			// north & west edges of the retained cell
			n.hEdges[y * width + x] = f.hEdges[y * f.width + x] ?? EdgeType.WALL;
			n.vEdges[y * (width + 1) + x] = f.vEdges[y * (f.width + 1) + x] ?? EdgeType.WALL;
		}
	}
	// south / east edges of the retained region
	for (let x = 0; x < Math.min(width, f.width); x++) {
		const y = Math.min(height, f.height);
		n.hEdges[y * width + x] = f.hEdges[y * f.width + x] ?? EdgeType.WALL;
	}
	for (let y = 0; y < Math.min(height, f.height); y++) {
		const x = Math.min(width, f.width);
		n.vEdges[y * (width + 1) + x] = f.vEdges[y * (f.width + 1) + x] ?? EdgeType.WALL;
	}
	n.links = f.links.filter((l) => l.from.x < width && l.from.y < height);
	for (const [k, v] of Object.entries(f.chests)) {
		const [cx, cy] = k.split(",").map(Number);
		if (cx! < width && cy! < height) n.chests[k] = v;
	}
	return normalizeEdges(n);
}

export function chestKey(x: number, y: number): string {
	return `${x},${y}`;
}

/** Key used in PlayerSave.openedChests */
export function openedChestKey(floor: number, x: number, y: number): string {
	return `${floor}:${x},${y}`;
}
