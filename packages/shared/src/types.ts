/** Cell kinds. Walls are NOT cell kinds: they live on edges (see EdgeType). */
export const CellType = {
	VOID: 0, // unused, impassable, not rendered
	FLOOR: 1,
	CHEST: 2,
	STAIRS_DOWN: 3,
	STAIRS_UP: 4,
} as const;
export type CellType = (typeof CellType)[keyof typeof CellType];

/** Edge kinds. 2 (DOOR) and 3 (SECRET) are reserved for later phases. */
export const EdgeType = {
	OPEN: 0,
	WALL: 1,
} as const;
export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];

/** 0=north(y-1) 1=east(x+1) 2=south(y+1) 3=west(x-1) */
export type Dir = 0 | 1 | 2 | 3;

export interface Pos {
	x: number;
	y: number;
}

export interface PlayerState {
	floor: number;
	x: number;
	y: number;
	dir: Dir;
}

export interface StairLink {
	from: Pos;
	to: { floor: number; x: number; y: number; dir: Dir };
}

export interface ChestInfo {
	id: string;
	contents?: string;
}

export interface Floor {
	index: number;
	width: number;
	height: number;
	/** length width*height, row-major (y*width + x), CellType */
	cells: number[];
	/** length width*(height+1); index y*width+x = north edge of cell (x,y) */
	hEdges: number[];
	/** length (width+1)*height; index y*(width+1)+x = west edge of cell (x,y) */
	vEdges: number[];
	links: StairLink[];
	/** key "x,y" */
	chests: Record<string, ChestInfo>;
}

export interface Dungeon {
	id: string;
	name: string;
	revision: number;
	startPoint: PlayerState;
	floors: Floor[];
	updatedAt: string;
}

export interface PlayerSave {
	playerId: string;
	dungeonId: string;
	dungeonRevision: number;
	position: PlayerState;
	/** floor index -> base64 bitmap (1 bit per cell) */
	visited: Record<number, string>;
	/** "floor:x,y" */
	openedChests: string[];
	inventory: string[];
	updatedAt: string;
}

export type EdgeKind = "h" | "v";
export interface EdgeRef {
	kind: EdgeKind;
	index: number;
}
