import { describe, expect, it } from "vitest";
import {
	CellType, EdgeType, canMove, createFloor, edgeCells, edgeRef, getEdge, normalizeEdges,
	resizeFloor, setCell, setEdge, type Dir, type Floor,
} from "../src";

describe("edge indexing", () => {
	const f = createFloor(0, 4, 3);
	it("shares one edge between neighbouring cells (symmetry)", () => {
		for (let y = 0; y < 3; y++)
			for (let x = 0; x < 4; x++) {
				if (x + 1 < 4) expect(edgeRef(f, x, y, 1)).toEqual(edgeRef(f, x + 1, y, 3));
				if (y + 1 < 3) expect(edgeRef(f, x, y, 2)).toEqual(edgeRef(f, x, y + 1, 0));
			}
	});
	it("every edge index is in range and unique per cell side", () => {
		const seenH = new Set<number>(), seenV = new Set<number>();
		for (let y = 0; y < 3; y++)
			for (let x = 0; x < 4; x++)
				for (const d of [0, 1, 2, 3] as Dir[]) {
					const r = edgeRef(f, x, y, d);
					const max = r.kind === "h" ? f.hEdges.length : f.vEdges.length;
					expect(r.index).toBeGreaterThanOrEqual(0);
					expect(r.index).toBeLessThan(max);
					(r.kind === "h" ? seenH : seenV).add(r.index);
				}
		expect(seenH.size).toBe(f.hEdges.length);
		expect(seenV.size).toBe(f.vEdges.length);
	});
	it("edgeCells is the inverse of edgeRef", () => {
		const ref = edgeRef(f, 2, 1, 1);
		const [a, b] = edgeCells(f, ref);
		expect(a).toEqual({ x: 2, y: 1 });
		expect(b).toEqual({ x: 3, y: 1 });
	});
});

describe("canMove", () => {
	const make = (): Floor => createFloor(0, 5, 5);
	it("blocked by walls, allowed through OPEN edges (both directions)", () => {
		const f = make();
		expect(canMove(f, 1, 1, 1)).toBe(false);
		setEdge(f, 1, 1, 1, EdgeType.OPEN);
		expect(canMove(f, 1, 1, 1)).toBe(true);
		expect(canMove(f, 2, 1, 3)).toBe(true);
	});
	it("never leaves the map even if a perimeter edge were OPEN", () => {
		const f = make();
		setEdge(f, 0, 0, 0, EdgeType.OPEN);
		expect(canMove(f, 0, 0, 0)).toBe(false);
	});
	it("never enters or leaves VOID cells", () => {
		const f = make();
		setEdge(f, 1, 1, 1, EdgeType.OPEN);
		setCell(f, 2, 1, CellType.VOID);
		expect(canMove(f, 1, 1, 1)).toBe(false);
		expect(canMove(f, 2, 1, 3)).toBe(false);
	});
});

describe("normalizeEdges / resizeFloor", () => {
	it("forces perimeter and VOID-adjacent edges to WALL", () => {
		const f = createFloor(0, 5, 5);
		f.hEdges.fill(EdgeType.OPEN);
		f.vEdges.fill(EdgeType.OPEN);
		setCell(f, 2, 2, CellType.VOID);
		normalizeEdges(f);
		expect(getEdge(f, 0, 0, 0)).toBe(EdgeType.WALL);
		expect(getEdge(f, 4, 4, 2)).toBe(EdgeType.WALL);
		expect(getEdge(f, 4, 0, 1)).toBe(EdgeType.WALL);
		expect(getEdge(f, 1, 2, 1)).toBe(EdgeType.WALL); // next to VOID
		expect(getEdge(f, 1, 1, 1)).toBe(EdgeType.OPEN); // interior
	});
	it("grow keeps content, new cells are VOID; shrink drops outside", () => {
		const f = createFloor(0, 5, 5);
		setEdge(f, 1, 1, 1, EdgeType.OPEN);
		const g = resizeFloor(f, 7, 6);
		expect(g.cells.length).toBe(42);
		expect(g.hEdges.length).toBe(7 * 7);
		expect(g.vEdges.length).toBe(8 * 6);
		expect(canMove(g, 1, 1, 1)).toBe(true);
		expect(g.cells[5]).toBe(CellType.VOID); // x=5,y=0 is new
		const h = resizeFloor(g, 5, 5);
		expect(canMove(h, 1, 1, 1)).toBe(true);
		expect(h.cells.length).toBe(25);
	});
});
