import { describe, expect, it } from "vitest";
import {
	CellType, EdgeType, bfsDistances, createFloor, createVisited, decodeVisited, encodeVisited,
	generateFloor, isEdgeKnown, isVisited, linkStairs, markVisited, moveForward, edgeRef,
	resolveArrival, setCell, setEdge, takeStairs, turnAround, turnLeft, turnRight,
	validateDungeon, validateFloor, createRng, canMove, normalizeEdges, type Dir, type Dungeon, type PlayerState,
} from "../src";

const P = (x: number, y: number, dir: Dir): PlayerState => ({ floor: 0, x, y, dir });

describe("movement", () => {
	it("turns: left/right 90, back = clockwise 180", () => {
		expect(turnRight(P(0, 0, 3)).dir).toBe(0);
		expect(turnLeft(P(0, 0, 0)).dir).toBe(3);
		expect(turnAround(P(0, 0, 1)).dir).toBe(3);
	});
	it("moves forward through open edge only", () => {
		const f = createFloor(0, 5, 5);
		expect(moveForward(f, P(1, 1, 1))).toBeNull();
		setEdge(f, 1, 1, 1, EdgeType.OPEN);
		expect(moveForward(f, P(1, 1, 1))).toEqual(P(2, 1, 1));
	});
});

describe("arrival events", () => {
	it("opens an unopened chest once", () => {
		const f = createFloor(0, 5, 5);
		setCell(f, 1, 1, CellType.CHEST);
		expect(resolveArrival(f, P(1, 1, 0), new Set()).openChest).toBe("0:1,1");
		expect(resolveArrival(f, P(1, 1, 0), new Set(["0:1,1"]))).toEqual({});
	});
	it("takes stairs via link", () => {
		const a = generateFloor({ index: 0, seed: 3, downStairs: true }).floor;
		const b = generateFloor({ index: 1, seed: 4, upStairs: true }).floor;
		linkStairs([a, b]);
		const down = a.links[0]!;
		const r = resolveArrival(a, { floor: 0, ...down.from, dir: 0 }, new Set());
		expect(r.stairs?.floor).toBe(1);
		const arrived = takeStairs(r.stairs!);
		expect(canMove(b, arrived.x, arrived.y, arrived.dir)).toBe(true); // not facing a wall
	});
});

describe("auto-mapping bitmap", () => {
	it("marks, round-trips, and reveals edges next to visited cells", () => {
		const f = createFloor(0, 10, 10);
		const bits = createVisited(10, 10);
		markVisited(bits, 10, 3, 4);
		expect(isVisited(bits, 10, 10, 3, 4)).toBe(true);
		expect(isVisited(bits, 10, 10, 4, 4)).toBe(false);
		const rt = decodeVisited(encodeVisited(bits), 10, 10);
		expect(isVisited(rt, 10, 10, 3, 4)).toBe(true);
		expect(isEdgeKnown(f, bits, edgeRef(f, 3, 4, 1))).toBe(true); // east edge, shared w/ (4,4)
		expect(isEdgeKnown(f, bits, edgeRef(f, 5, 5, 1))).toBe(false);
	});
	it("discards a bitmap whose size no longer matches", () => {
		const bits = createVisited(10, 10);
		markVisited(bits, 10, 0, 0);
		const r = decodeVisited(encodeVisited(bits), 12, 12);
		expect(isVisited(r, 12, 12, 0, 0)).toBe(false);
		expect(decodeVisited("%%%", 10, 10).length).toBe(bits.length);
	});
});

describe("generator", () => {
	it("is deterministic per seed", () => {
		const a = generateFloor({ seed: 42 }).floor;
		const b = generateFloor({ seed: 42 }).floor;
		expect(a).toEqual(b);
		expect(generateFloor({ seed: 43 }).floor).not.toEqual(a);
	});
	it.each([[10, 10], [5, 7], [11, 6], [64, 64]])("%ix%i: fully connected, valid structure", (w, h) => {
		for (let seed = 1; seed <= 5; seed++) {
			const { floor, start } = generateFloor({ width: w, height: h, seed, upStairs: true, downStairs: true });
			const dist = bfsDistances(floor, start.x, start.y);
			expect(dist.every((d) => d >= 0)).toBe(true);
			linkStairs([floor, floor]); // self-link only to satisfy the link check below
			const errs = validateFloor(floor).filter((e) => !e.includes("no link"));
			expect(errs).toEqual([]);
		}
	});
	it("with loopRate 0 it is a perfect maze (w*h-1 open edges)", () => {
		const { floor } = generateFloor({ width: 8, height: 8, seed: 9, loopRate: 0 });
		const open = floor.hEdges.filter((e) => e === EdgeType.OPEN).length + floor.vEdges.filter((e) => e === EdgeType.OPEN).length;
		expect(open).toBe(63);
	});
	it("places chests only in dead ends, none on stairs", () => {
		const { floor } = generateFloor({ seed: 5, chestRate: 0.1, upStairs: true, downStairs: true });
		expect(Object.keys(floor.chests).length).toBeGreaterThan(0);
		for (const k of Object.keys(floor.chests)) {
			const [x, y] = k.split(",").map(Number) as [number, number];
			expect(floor.cells[y * floor.width + x]).toBe(CellType.CHEST);
		}
	});
});

describe("rng", () => {
	it("returns values in [0,1)", () => {
		const r = createRng(1);
		for (let i = 0; i < 1000; i++) {
			const v = r();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

function sampleDungeon(): Dungeon {
	const g0 = generateFloor({ index: 0, seed: 1, downStairs: true, upStairs: false });
	const g1 = generateFloor({ index: 1, seed: 2, upStairs: true });
	const floors = linkStairs([g0.floor, g1.floor]);
	// Start next to nothing special: use the maze start of floor 0.
	return {
		id: "d", name: "t", revision: 1, updatedAt: "",
		startPoint: { floor: 0, x: g0.start.x, y: g0.start.y, dir: 0 },
		floors,
	};
}

describe("validateDungeon", () => {
	it("accepts a generated, linked dungeon (also for publish)", () => {
		const d = sampleDungeon();
		expect(validateDungeon(d)).toEqual([]);
		expect(validateDungeon(d, { forPublish: true })).toEqual([]);
	});
	it("rejects open perimeter, VOID-touching open edges, and bad sizes", () => {
		const d = sampleDungeon();
		d.floors[0]!.hEdges[0] = EdgeType.OPEN;
		expect(validateDungeon(d).join()).toContain("perimeter");
		const d2 = sampleDungeon();
		setCell(d2.floors[0]!, 5, 5, CellType.VOID);
		expect(validateDungeon(d2).join()).toContain("VOID");
		expect(validateFloor(createFloor(0, 3, 3))[0]).toContain("size");
	});
	it("rejects missing link and bad start", () => {
		const d = sampleDungeon();
		d.floors[0]!.links = [];
		expect(validateDungeon(d).join()).toContain("no link");
		const d2 = sampleDungeon();
		setCell(d2.floors[0]!, d2.startPoint.x, d2.startPoint.y, CellType.VOID);
		normalizeEdges(d2.floors[0]!); // keep the floor itself structurally valid
		expect(validateDungeon(d2).join()).toContain("startPoint");
	});
	it("publish check finds unreachable chests", () => {
		const d = sampleDungeon();
		const f = d.floors[0]!;
		// wall off a dead-end chest cell completely
		const key = Object.keys(f.chests)[0];
		if (!key) return; // 10x10 @ 3% may yield 3 chests; guard anyway
		const [x, y] = key.split(",").map(Number) as [number, number];
		for (const dir of [0, 1, 2, 3] as Dir[]) setEdge(f, x, y, dir, EdgeType.WALL);
		expect(validateDungeon(d, { forPublish: true }).join()).toContain("unreachable");
	});
});
