import { openDirs } from "./bfs";
import { getCell } from "./floor";
import { CellType, type Dir, type Floor } from "./types";

function findCells(f: Floor, type: CellType) {
	const out: { x: number; y: number }[] = [];
	for (let y = 0; y < f.height; y++)
		for (let x = 0; x < f.width; x++) if (getCell(f, x, y) === type) out.push({ x, y });
	return out;
}

/** Direction to face on arrival: toward an open edge, so the player isn't staring at a wall. */
function arrivalDir(f: Floor, x: number, y: number): Dir {
	return openDirs(f, x, y)[0] ?? 0;
}

/**
 * Link STAIRS_DOWN on each floor to the first STAIRS_UP on the next floor (and back).
 * Replaces existing links between those cells. Returns the floors (mutated).
 */
export function linkStairs(floors: Floor[]): Floor[] {
	for (let i = 0; i + 1 < floors.length; i++) {
		const a = floors[i]!;
		const b = floors[i + 1]!;
		const down = findCells(a, CellType.STAIRS_DOWN)[0];
		const up = findCells(b, CellType.STAIRS_UP)[0];
		if (!down || !up) continue;
		a.links = a.links.filter((l) => !(l.from.x === down.x && l.from.y === down.y));
		b.links = b.links.filter((l) => !(l.from.x === up.x && l.from.y === up.y));
		a.links.push({ from: down, to: { floor: b.index, x: up.x, y: up.y, dir: arrivalDir(b, up.x, up.y) } });
		b.links.push({ from: up, to: { floor: a.index, x: down.x, y: down.y, dir: arrivalDir(a, down.x, down.y) } });
	}
	return floors;
}
