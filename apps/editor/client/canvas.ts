import {
	CellType, EdgeType, edgeCells, getCell, isPassableCell, type Dungeon, type EdgeKind, type EdgeRef, type Floor,
} from "@dungeon/shared";

export interface View {
	size: number; // px per cell
	ox: number;
	oy: number;
}

export interface Overlay {
	hoverCell?: { x: number; y: number };
	hoverEdge?: EdgeRef;
	rect?: { x0: number; y0: number; x1: number; y1: number };
}

export function computeView(f: Floor, w: number, h: number): View {
	const pad = 28;
	const size = Math.max(8, Math.floor(Math.min((w - pad * 2) / f.width, (h - pad * 2) / f.height)));
	return { size, ox: Math.floor((w - size * f.width) / 2), oy: Math.floor((h - size * f.height) / 2) };
}

const C = {
	void: "#0e0d14", voidGrid: "#1b1a26", floor: "#3a3758", open: "#4d4a72", wall: "#e0dcf5", chest: "#e0a83a",
	up: "#e8a24a", down: "#4ab0e8", start: "#5cc88a", hover: "rgba(122,108,240,.55)",
};

export function draw(canvas: HTMLCanvasElement, d: Dungeon, fi: number, view: View, ov: Overlay) {
	const dpr = Math.min(window.devicePixelRatio, 2);
	const w = canvas.clientWidth, h = canvas.clientHeight;
	if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
		canvas.width = w * dpr;
		canvas.height = h * dpr;
	}
	const g = canvas.getContext("2d")!;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, w, h);
	const f = d.floors[fi]!;
	const { size, ox, oy } = view;

	for (let y = 0; y < f.height; y++)
		for (let x = 0; x < f.width; x++) {
			const px = ox + x * size, py = oy + y * size;
			const passable = isPassableCell(f, x, y);
			g.fillStyle = passable ? C.floor : C.void;
			g.fillRect(px, py, size, size);
			if (!passable) {
				g.strokeStyle = C.voidGrid;
				g.lineWidth = 1;
				g.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
				continue;
			}
			const t = getCell(f, x, y);
			const cx = px + size / 2, cy = py + size / 2;
			if (t === CellType.CHEST) {
				g.fillStyle = C.chest;
				g.fillRect(cx - size * 0.24, cy - size * 0.17, size * 0.48, size * 0.34);
			} else if (t === CellType.STAIRS_DOWN || t === CellType.STAIRS_UP) {
				const down = t === CellType.STAIRS_DOWN;
				const link = f.links.find((l) => l.from.x === x && l.from.y === y);
				g.fillStyle = down ? C.down : C.up;
				g.font = `bold ${Math.floor(size * 0.5)}px system-ui`;
				g.textAlign = "center";
				g.textBaseline = "middle";
				g.fillText(down ? "▼" : "▲", cx, cy - (link ? size * 0.1 : 0));
				if (link) {
					g.font = `${Math.max(8, Math.floor(size * 0.22))}px system-ui`;
					g.fillText(`${link.to.floor + 1}F`, cx, cy + size * 0.26);
				}
			}
		}

	// open edges between passable cells: faint divider; walls: bold line
	const strokeEdges = (kind: EdgeKind, arr: number[]) => {
		const stride = kind === "h" ? f.width : f.width + 1;
		for (let i = 0; i < arr.length; i++) {
			const [a, b] = edgeCells(f, { kind, index: i });
			const pa = isPassableCell(f, a.x, a.y), pb = isPassableCell(f, b.x, b.y);
			if (!pa && !pb) continue;
			const x = i % stride, y = Math.floor(i / stride);
			const x0 = ox + x * size, y0 = oy + y * size;
			const [x1, y1] = kind === "h" ? [x0 + size, y0] : [x0, y0 + size];
			g.beginPath();
			g.moveTo(x0, y0);
			g.lineTo(x1, y1);
			if (arr[i] === EdgeType.WALL) {
				g.strokeStyle = C.wall;
				g.lineWidth = Math.max(2, size * 0.09);
				g.lineCap = "square";
			} else {
				g.strokeStyle = C.open;
				g.lineWidth = 1;
				g.lineCap = "butt";
			}
			g.stroke();
		}
	};
	strokeEdges("h", f.hEdges);
	strokeEdges("v", f.vEdges);

	if (d.startPoint.floor === fi) {
		const s = d.startPoint;
		g.save();
		g.translate(ox + s.x * size + size / 2, oy + s.y * size + size / 2);
		g.rotate((s.dir * Math.PI) / 2);
		g.fillStyle = C.start;
		g.beginPath();
		g.moveTo(0, -size * 0.36);
		g.lineTo(size * 0.22, size * 0.14);
		g.lineTo(-size * 0.22, size * 0.14);
		g.closePath();
		g.fill();
		g.restore();
	}

	if (ov.rect) {
		const x0 = Math.min(ov.rect.x0, ov.rect.x1), x1 = Math.max(ov.rect.x0, ov.rect.x1);
		const y0 = Math.min(ov.rect.y0, ov.rect.y1), y1 = Math.max(ov.rect.y0, ov.rect.y1);
		g.fillStyle = "rgba(122,108,240,.25)";
		g.strokeStyle = C.hover;
		g.lineWidth = 2;
		g.fillRect(ox + x0 * size, oy + y0 * size, (x1 - x0 + 1) * size, (y1 - y0 + 1) * size);
		g.strokeRect(ox + x0 * size, oy + y0 * size, (x1 - x0 + 1) * size, (y1 - y0 + 1) * size);
	}
	if (ov.hoverCell) {
		g.fillStyle = "rgba(122,108,240,.3)";
		g.fillRect(ox + ov.hoverCell.x * size, oy + ov.hoverCell.y * size, size, size);
	}
	if (ov.hoverEdge) {
		const { kind, index } = ov.hoverEdge;
		const stride = kind === "h" ? f.width : f.width + 1;
		const x = index % stride, y = Math.floor(index / stride);
		g.strokeStyle = C.hover;
		g.lineWidth = Math.max(4, size * 0.16);
		g.beginPath();
		g.moveTo(ox + x * size, oy + y * size);
		g.lineTo(ox + (x + (kind === "h" ? 1 : 0)) * size, oy + (y + (kind === "h" ? 0 : 1)) * size);
		g.stroke();
	}
}
