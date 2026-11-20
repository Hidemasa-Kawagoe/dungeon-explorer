import { CellType, type Floor, type PlayerSave, type PlayerState } from "./types";
import { getCell, isPassableCell } from "./floor";
import { unpackVisited } from "./visited";

export interface GameProgress {
	position: PlayerState;
	visited: Map<number, Uint8Array>;
	openedChests: Set<string>;
	inventory: string[];
}

/**
 * Bring a (possibly older-revision) save in line with the current dungeon:
 * - position on a VOID/missing cell -> start point
 * - bitmaps recorded for a different floor size are dropped
 * - opened-chest keys that no longer point at a chest are dropped
 */
export function reconcileSave(
	save: PlayerSave | null,
	dungeon: { startPoint: PlayerState; floors: Floor[] },
): GameProgress {
	const visited = new Map<number, Uint8Array>();
	const opened = new Set<string>();
	let position = { ...dungeon.startPoint };
	let inventory: string[] = [];

	if (save) {
		const f = dungeon.floors[save.position.floor];
		if (f && isPassableCell(f, save.position.x, save.position.y)) position = { ...save.position };
		inventory = [...save.inventory];
		for (const key of save.openedChests) {
			const m = /^(\d+):(\d+),(\d+)$/.exec(key);
			const cf = m ? dungeon.floors[Number(m[1])] : undefined;
			if (m && cf && getCell(cf, Number(m[2]), Number(m[3])) === CellType.CHEST) opened.add(key);
		}
	}
	for (const f of dungeon.floors) {
		visited.set(f.index, unpackVisited(save?.visited[f.index], f.width, f.height));
	}
	return { position, visited, openedChests: opened, inventory };
}
