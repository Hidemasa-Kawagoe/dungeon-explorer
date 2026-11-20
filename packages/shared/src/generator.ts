import { bfsDistances } from "./bfs";
import { chestKey, createFloor, DX, DY, getCell, inBounds, setCell, setEdge } from "./floor";
import { createRng } from "./rng";
import { CellType, EdgeType, type Dir, type Floor, type Pos } from "./types";

export interface GenerateOptions {
	index?: number;
	width?: number; // default 10
	height?: number; // default 10
	seed?: number;
	/** probability of opening each remaining interior wall (adds loops). default 0.05 */
	loopRate?: number;
	/** chests ~= cells * chestRate (placed in dead ends). default 0.03 */
	chestRate?: number;
	/** put STAIRS_UP on the generation start cell */
	upStairs?: boolean;
	/** put STAIRS_DOWN on the cell furthest from the start */
	downStairs?: boolean;
}

export interface GeneratedFloor {
	floor: Floor;
	/** maze start cell (STAIRS_UP lives here when upStairs) */
	start: Pos;
}

const DIRS: Dir[] = [0, 1, 2, 3];

/**
 * Edge-model maze: every cell FLOOR, every edge WALL, then recursive
 * backtracker carves OPEN edges between cells. Works for any N x M.
 */
export function generateFloor(opts: GenerateOptions = {}): GeneratedFloor {
	const width = opts.width ?? 10;
	const height = opts.height ?? 10;
	const rng = createRng(opts.seed ?? 1);
	const f = createFloor(opts.index ?? 0, width, height, CellType.FLOOR);

	const start: Pos = { x: Math.floor(rng() * width), y: Math.floor(rng() * height) };
	const seen = new Uint8Array(width * height);
	const stack: Pos[] = [start];
	seen[start.y * width + start.x] = 1;
	while (stack.length) {
		const cur = stack[stack.length - 1]!;
		const options = DIRS.filter((d) => {
			const nx = cur.x + DX[d];
			const ny = cur.y + DY[d];
			return inBounds(f, nx, ny) && !seen[ny * width + nx];
		});
		if (options.length === 0) {
			stack.pop();
			continue;
		}
		const d = options[Math.floor(rng() * options.length)]!;
		setEdge(f, cur.x, cur.y, d, EdgeType.OPEN);
		const next = { x: cur.x + DX[d], y: cur.y + DY[d] };
		seen[next.y * width + next.x] = 1;
		stack.push(next);
	}

	// Loops: open some remaining interior walls (south/east of each cell, once each).
	const loopRate = opts.loopRate ?? 0.05;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (const d of [1, 2] as Dir[]) {
				if (!inBounds(f, x + DX[d], y + DY[d])) continue;
				if (rng() < loopRate) setEdge(f, x, y, d, EdgeType.OPEN);
			}
		}
	}

	if (opts.upStairs) setCell(f, start.x, start.y, CellType.STAIRS_UP);
	if (opts.downStairs) {
		const dist = bfsDistances(f, start.x, start.y);
		let best = -1;
		for (let i = 0; i < dist.length; i++) {
			const x = i % width;
			const y = Math.floor(i / width);
			if (x === start.x && y === start.y) continue;
			if (best === -1 || dist[i]! > dist[best]!) best = i;
		}
		if (best !== -1) setCell(f, best % width, Math.floor(best / width), CellType.STAIRS_DOWN);
	}

	// Chests in dead ends (exactly one open edge), not on stairs / start.
	const want = Math.round(width * height * (opts.chestRate ?? 0.03));
	const deadEnds: Pos[] = [];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (getCell(f, x, y) !== CellType.FLOOR) continue;
			if (x === start.x && y === start.y) continue;
			const open = DIRS.filter((d) => isOpen(f, x, y, d)).length;
			if (open === 1) deadEnds.push({ x, y });
		}
	}
	for (let i = deadEnds.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[deadEnds[i], deadEnds[j]] = [deadEnds[j]!, deadEnds[i]!];
	}
	let n = 0;
	for (const c of deadEnds.slice(0, want)) {
		setCell(f, c.x, c.y, CellType.CHEST);
		f.chests[chestKey(c.x, c.y)] = { id: `f${f.index}-c${n++}` };
	}

	return { floor: f, start };
}

function isOpen(f: Floor, x: number, y: number, d: Dir): boolean {
	const ref =
		d === 0 ? f.hEdges[y * f.width + x]
		: d === 2 ? f.hEdges[(y + 1) * f.width + x]
		: d === 3 ? f.vEdges[y * (f.width + 1) + x]
		: f.vEdges[y * (f.width + 1) + x + 1];
	return ref === EdgeType.OPEN;
}
