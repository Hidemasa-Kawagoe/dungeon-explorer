import { describe, expect, it } from "vitest";
import {
	CellType, EdgeType, addFloor, canMove, createDungeon, createRoomFloor, fillRoom, getCell, getEdge,
	hitTest, paintCell, placeStairs, regenerateFloor, removeFloor, removeStairs, resizeDungeonFloor,
	sanitizeDungeon, setEdgeChecked, setStart, toggleEdge, validateDungeon, edgeRef, createFloor, type Dir,
} from "../src";

const mk = (floors = 2, generate = false) => createDungeon({ id: "d", name: "t", width: 8, height: 8, floors, generate, seed: 7 });

describe("hitTest", () => {
	const f = createFloor(0, 5, 5);
	it("cell centre vs. border bands", () => {
		expect(hitTest(f, 2.5, 2.5)).toEqual({ type: "cell", x: 2, y: 2 });
		expect(hitTest(f, 2.5, 2.05)).toEqual({ type: "edge", ref: edgeRef(f, 2, 2, 0) });
		expect(hitTest(f, 2.5, 2.95)).toEqual({ type: "edge", ref: edgeRef(f, 2, 2, 2) });
		expect(hitTest(f, 2.04, 2.5)).toEqual({ type: "edge", ref: edgeRef(f, 2, 2, 3) });
		expect(hitTest(f, 2.97, 2.5)).toEqual({ type: "edge", ref: edgeRef(f, 2, 2, 1) });
	});
	it("the same edge is hit from either neighbouring cell", () => {
		expect(hitTest(f, 2.97, 2.5)).toEqual(hitTest(f, 3.03, 2.5));
	});
	it("handles map boundary and outside", () => {
		expect(hitTest(f, 5, 2.5)).toEqual({ type: "edge", ref: edgeRef(f, 4, 2, 1) });
		expect(hitTest(f, -0.1, 1)).toBeNull();
		expect(hitTest(f, 5.1, 1)).toBeNull();
	});
});

describe("edge editing", () => {
	it("toggles interior edges only between real cells", () => {
		const d = mk(1);
		const f = d.floors[0]!;
		const inner = edgeRef(f, 3, 3, 1);
		expect(getEdge(f, 3, 3, 1)).toBe(EdgeType.OPEN);
		expect(toggleEdge(f, inner)).toBe(EdgeType.WALL);
		expect(canMove(f, 3, 3, 1)).toBe(false);
		expect(toggleEdge(f, inner)).toBe(EdgeType.OPEN);
		const perimeter = edgeRef(f, 0, 0, 0);
		expect(toggleEdge(f, perimeter)).toBeNull();
		expect(setEdgeChecked(f, perimeter, EdgeType.OPEN)).toBe(false);
		expect(validateDungeon(d)).toEqual([]);
	});
});

describe("paintCell", () => {
	it("VOID makes edges walls; re-painting FLOOR with autoWalls reconnects to neighbours", () => {
		const d = mk(1);
		const f = d.floors[0]!;
		paintCell(d, 0, 4, 4, CellType.VOID);
		expect(canMove(f, 3, 4, 1)).toBe(false);
		expect(getEdge(f, 3, 4, 1)).toBe(EdgeType.WALL);
		paintCell(d, 0, 4, 4, CellType.FLOOR);
		expect(canMove(f, 3, 4, 1)).toBe(true);
		expect(validateDungeon(d)).toEqual([]);
	});
	it("autoWalls on a fresh cell next to the map edge/VOID keeps invariants", () => {
		const d = mk(1);
		paintCell(d, 0, 4, 4, CellType.VOID);
		paintCell(d, 0, 5, 4, CellType.VOID);
		paintCell(d, 0, 4, 4, CellType.FLOOR);
		expect(canMove(d.floors[0]!, 4, 4, 1)).toBe(false); // (5,4) is VOID
		expect(validateDungeon(d)).toEqual([]);
	});
	it("chests are registered and removed with the cell", () => {
		const d = mk(1);
		const f = d.floors[0]!;
		paintCell(d, 0, 2, 2, CellType.CHEST);
		expect(f.chests["2,2"]).toBeDefined();
		expect(validateDungeon(d)).toEqual([]);
		paintCell(d, 0, 2, 2, CellType.FLOOR);
		expect(f.chests["2,2"]).toBeUndefined();
	});
	it("painting over stairs removes the paired stairs", () => {
		const d = mk(2);
		const down = d.floors[0]!.links[0]!;
		paintCell(d, 0, down.from.x, down.from.y, CellType.FLOOR);
		expect(d.floors[0]!.links).toHaveLength(0);
		expect(d.floors[1]!.links).toHaveLength(0);
		expect(validateDungeon(d)).toEqual([]);
	});
});

describe("stairs", () => {
	it("placeStairs creates a reciprocal pair and a usable arrival direction", () => {
		const d = mk(3);
		expect(placeStairs(d, 1, 3, 3, "down")).toBeNull();
		const l = d.floors[1]!.links.find((x) => x.from.x === 3 && x.from.y === 3)!;
		expect(l.to.floor).toBe(2);
		expect(getCell(d.floors[2]!, l.to.x, l.to.y)).toBe(CellType.STAIRS_UP);
		expect(canMove(d.floors[2]!, l.to.x, l.to.y, l.to.dir)).toBe(true);
		expect(validateDungeon(d, { forPublish: true })).toEqual([]);
	});
	it("refuses when the adjacent floor does not exist", () => {
		const d = mk(1);
		expect(placeStairs(d, 0, 1, 1, "down")).toContain("下");
		expect(placeStairs(d, 0, 1, 1, "up")).toContain("上");
	});
	it("replacing stairs re-pairs cleanly (no stale partners)", () => {
		const d = mk(2);
		placeStairs(d, 0, 2, 2, "down");
		placeStairs(d, 0, 3, 3, "down");
		const ups = d.floors[1]!.cells.filter((c) => c === CellType.STAIRS_UP).length;
		expect(ups).toBeGreaterThanOrEqual(1);
		expect(validateDungeon(d, { forPublish: true })).toEqual([]);
	});
	it("removeStairs removes both ends", () => {
		const d = mk(2);
		const l = d.floors[0]!.links[0]!;
		removeStairs(d, 0, l.from.x, l.from.y);
		expect(d.floors.every((f) => f.links.length === 0)).toBe(true);
		expect(d.floors.every((f) => !f.cells.includes(CellType.STAIRS_DOWN) && !f.cells.includes(CellType.STAIRS_UP))).toBe(true);
	});
});

describe("fillRoom", () => {
	it("carves a walled room inside empty space", () => {
		const d = mk(1);
		const f = d.floors[0]!;
		for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) paintCell(d, 0, x, y, CellType.VOID);
		setStart(d, 0, 0, 0, 0); // fails (VOID) -> start repaired below
		fillRoom(f, 2, 2, 4, 3);
		expect(getCell(f, 3, 3)).toBe(CellType.FLOOR);
		expect(canMove(f, 2, 2, 1)).toBe(true);
		expect(canMove(f, 2, 2, 0)).toBe(false);
		expect(canMove(f, 4, 3, 1)).toBe(false);
		sanitizeDungeon(d);
		expect(validateDungeon(d)).toEqual([]);
	});
});

describe("floors", () => {
	it("add / remove floors keeps links and start consistent", () => {
		const d = mk(3);
		addFloor(d, 8, 8);
		expect(d.floors).toHaveLength(4);
		expect(removeFloor(d, 1)).toBe(true);
		expect(d.floors).toHaveLength(3);
		expect(d.floors.map((f) => f.index)).toEqual([0, 1, 2]);
		expect(validateDungeon(d)).toEqual([]);
		for (const f of d.floors) for (const l of f.links) expect(l.to.floor).toBeLessThan(3);
	});
	it("cannot remove the last floor; start moves when its floor is removed", () => {
		const d = mk(2);
		d.startPoint = { floor: 1, x: 0, y: 0, dir: 1 };
		expect(removeFloor(d, 1)).toBe(true);
		expect(d.startPoint.floor).toBe(0);
		expect(removeFloor(d, 0)).toBe(false);
	});
	it("resize drops what fell outside and repairs links (both directions)", () => {
		const d = mk(2);
		const down = d.floors[0]!.links[0]!;
		resizeDungeonFloor(d, 0, 5, 5); // stairs at (7,7) fall outside
		expect(down.from.x).toBe(7);
		expect(d.floors[1]!.links).toHaveLength(0);
		expect(d.floors[1]!.cells.includes(CellType.STAIRS_UP)).toBe(false);
		expect(validateDungeon(d)).toEqual([]);
		resizeDungeonFloor(d, 0, 12, 9);
		expect(d.floors[0]!.width).toBe(12);
		expect(validateDungeon(d)).toEqual([]);
	});
	it("regenerateFloor produces a connected, valid, linked floor", () => {
		const d = mk(3);
		regenerateFloor(d, 1, 99, true);
		expect(validateDungeon(d)).toEqual([]);
		expect(validateDungeon(d, { forPublish: true })).toEqual([]);
		expect(d.floors[1]!.cells.includes(CellType.STAIRS_UP)).toBe(true);
		expect(d.floors[1]!.cells.includes(CellType.STAIRS_DOWN)).toBe(true);
	});
});

describe("createDungeon", () => {
	it.each([[1, false], [3, false], [1, true], [4, true]])("%i floors, generate=%s is valid for publish", (n, gen) => {
		const d = mk(n, gen);
		expect(d.floors).toHaveLength(n);
		expect(validateDungeon(d, { forPublish: true })).toEqual([]);
	});
	it("a plain 10x10 default is a walled room starting at the corner", () => {
		const d = createDungeon({ id: "x", name: "n" });
		expect(d.floors[0]!.width).toBe(10);
		expect(d.startPoint).toMatchObject({ floor: 0, x: 0, y: 0 });
		expect(canMove(d.floors[0]!, 0, 0, d.startPoint.dir as Dir)).toBe(true);
	});
});

describe("sanitizeDungeon", () => {
	it("demotes stairs whose link is missing or one-sided", () => {
		const d = mk(2);
		d.floors[1]!.links = []; // break reciprocity
		sanitizeDungeon(d);
		expect(d.floors[0]!.links).toHaveLength(0);
		expect(validateDungeon(d)).toEqual([]);
	});
	it("repairs an invalid start point", () => {
		const d = mk(1);
		paintCell(d, 0, 0, 0, CellType.VOID);
		sanitizeDungeon(d);
		expect(validateDungeon(d)).toEqual([]);
	});
});
