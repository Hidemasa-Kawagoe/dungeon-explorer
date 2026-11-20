import { canMove, DX, DY } from "./floor";
import type { Dir, Floor, Pos } from "./types";

/** Step distances from (sx,sy) following open edges; -1 = unreachable. Row-major like cells. */
export function bfsDistances(f: Floor, sx: number, sy: number): Int32Array {
	const dist = new Int32Array(f.width * f.height).fill(-1);
	if (sx < 0 || sy < 0 || sx >= f.width || sy >= f.height) return dist;
	const queue: number[] = [sy * f.width + sx];
	dist[queue[0]!] = 0;
	for (let head = 0; head < queue.length; head++) {
		const i = queue[head]!;
		const x = i % f.width;
		const y = (i - x) / f.width;
		for (let d = 0; d < 4; d++) {
			const dir = d as Dir;
			if (!canMove(f, x, y, dir)) continue;
			const j = (y + DY[dir]) * f.width + (x + DX[dir]);
			if (dist[j] === -1) {
				dist[j] = dist[i]! + 1;
				queue.push(j);
			}
		}
	}
	return dist;
}

/** Reachable cell furthest from the start (ties: first in row-major order). */
export function farthestCell(f: Floor, sx: number, sy: number): Pos {
	const dist = bfsDistances(f, sx, sy);
	let best = 0;
	for (let i = 1; i < dist.length; i++) if (dist[i]! > dist[best]!) best = i;
	return { x: best % f.width, y: Math.floor(best / f.width) };
}

/** Directions from which (x,y) can be left; useful for choosing an arrival direction. */
export function openDirs(f: Floor, x: number, y: number): Dir[] {
	return ([0, 1, 2, 3] as Dir[]).filter((d) => canMove(f, x, y, d));
}
