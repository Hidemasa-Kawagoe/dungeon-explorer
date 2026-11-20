import { canMove, DX, DY, getCell, openedChestKey } from "./floor";
import { CellType, type Dir, type Floor, type PlayerState, type StairLink } from "./types";

export const turnRight = (p: PlayerState): PlayerState => ({ ...p, dir: ((p.dir + 1) % 4) as Dir });
export const turnLeft = (p: PlayerState): PlayerState => ({ ...p, dir: ((p.dir + 3) % 4) as Dir });
/** "Down" key: turn clockwise 180 degrees. */
export const turnAround = (p: PlayerState): PlayerState => ({ ...p, dir: ((p.dir + 2) % 4) as Dir });

/** Next player state after stepping forward, or null if blocked. */
export function moveForward(f: Floor, p: PlayerState): PlayerState | null {
	if (!canMove(f, p.x, p.y, p.dir)) return null;
	return { ...p, x: p.x + DX[p.dir], y: p.y + DY[p.dir] };
}

export interface ArrivalResult {
	/** Chest to open now (key "floor:x,y"), if the cell is an unopened chest. */
	openChest?: string;
	/** Stair link to take, if the cell is stairs with a link. */
	stairs?: StairLink["to"];
}

/** Events triggered by standing on the player's current cell. */
export function resolveArrival(
	f: Floor,
	p: PlayerState,
	openedChests: ReadonlySet<string>,
): ArrivalResult {
	const type = getCell(f, p.x, p.y);
	if (type === CellType.CHEST) {
		const key = openedChestKey(p.floor, p.x, p.y);
		return openedChests.has(key) ? {} : { openChest: key };
	}
	if (type === CellType.STAIRS_DOWN || type === CellType.STAIRS_UP) {
		const link = f.links.find((l) => l.from.x === p.x && l.from.y === p.y);
		if (link) return { stairs: link.to };
	}
	return {};
}

/** Apply a stair transition. */
export function takeStairs(to: NonNullable<ArrivalResult["stairs"]>): PlayerState {
	return { floor: to.floor, x: to.x, y: to.y, dir: to.dir };
}
