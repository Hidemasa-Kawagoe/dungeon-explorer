import { edgeCells } from "./floor";
import type { EdgeRef, Floor } from "./types";

// btoa/atob exist in browsers, Workers and Node 16+; avoid depending on the DOM lib.
const b64 = globalThis as unknown as { btoa(s: string): string; atob(s: string): string };

/** 1 bit per cell, row-major. */
export function createVisited(width: number, height: number): Uint8Array {
	return new Uint8Array(Math.ceil((width * height) / 8));
}

export function markVisited(bits: Uint8Array, width: number, x: number, y: number): void {
	const i = y * width + x;
	bits[i >> 3]! |= 1 << (i & 7);
}

export function isVisited(bits: Uint8Array, width: number, height: number, x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= width || y >= height) return false;
	const i = y * width + x;
	return ((bits[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
}

/** An edge is known when either adjacent cell has been visited. */
export function isEdgeKnown(f: Floor, bits: Uint8Array, ref: EdgeRef): boolean {
	const [a, b] = edgeCells(f, ref);
	return isVisited(bits, f.width, f.height, a.x, a.y) || isVisited(bits, f.width, f.height, b.x, b.y);
}

export function encodeVisited(bits: Uint8Array): string {
	let s = "";
	for (const b of bits) s += String.fromCharCode(b);
	return b64.btoa(s);
}

/**
 * Decode; returns a fresh empty bitmap if the data is missing/invalid or the
 * size doesn't match the floor (map was resized since the save).
 */
export function decodeVisited(data: string | undefined, width: number, height: number): Uint8Array {
	const out = createVisited(width, height);
	if (!data) return out;
	try {
		const s = b64.atob(data);
		if (s.length !== out.length) return out;
		for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	} catch {
		/* invalid base64 -> empty */
	}
	return out;
}

/**
 * Save format for one floor's bitmap: "WxH:base64". Carrying the dimensions lets a
 * later map revision detect a resized floor instead of misreading the bits.
 */
export function packVisited(bits: Uint8Array, width: number, height: number): string {
	return `${width}x${height}:${encodeVisited(bits)}`;
}

/** Empty bitmap when missing, malformed, or recorded for a different floor size. */
export function unpackVisited(data: string | undefined, width: number, height: number): Uint8Array {
	const m = data ? /^(\d{1,2})x(\d{1,2}):(.*)$/.exec(data) : null;
	if (!m || Number(m[1]) !== width || Number(m[2]) !== height) return createVisited(width, height);
	return decodeVisited(m[3], width, height);
}

export function hasAnyVisited(bits: Uint8Array): boolean {
	return bits.some((b) => b !== 0);
}
