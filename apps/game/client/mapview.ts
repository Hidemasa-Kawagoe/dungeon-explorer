import {
	CellType, EdgeType, getCell, isEdgeKnown, isVisited,
	type EdgeKind, type Floor, type PlayerState,
} from "@dungeon/shared";

export interface MapFloorData {
	floor: Floor;
	visited: Uint8Array;
}

/** Draw the known part of one floor: visited cells, their 4 edges, icons, and the player. */
export function drawMap(
	canvas: HTMLCanvasElement,
	data: MapFloorData,
	opened: ReadonlySet<string>,
	player: PlayerState | null,
	label: string,
) {
	const dpr = Math.min(window.devicePixelRatio, 2);
	canvas.width = window.innerWidth * dpr;
	canvas.height = window.innerHeight * dpr;
	const g = canvas.getContext("2d")!;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, window.innerWidth, window.innerHeight);

	const { floor: f, visited } = data;
	const size = Math.floor(Math.min((window.innerWidth - 80) / f.width, (window.innerHeight - 120) / f.height));
	const ox = Math.floor((window.innerWidth - size * f.width) / 2);
	const oy = Math.floor((window.innerHeight - size * f.height) / 2) + 14;

	// faint frame so the player sees how big the floor is
	g.strokeStyle = "#2a2838";
	g.lineWidth = 1;
	g.strokeRect(ox + 0.5, oy + 0.5, size * f.width, size * f.height);

	for (let y = 0; y < f.height; y++)
		for (let x = 0; x < f.width; x++) {
			if (!isVisited(visited, f.width, f.height, x, y)) continue;
			g.fillStyle = "#34314a";
			g.fillRect(ox + x * size, oy + y * size, size, size);
			const t = getCell(f, x, y);
			const cx = ox + x * size + size / 2, cy = oy + y * size + size / 2;
			if (t === CellType.CHEST) {
				g.fillStyle = opened.has(`${f.index}:${x},${y}`) ? "#6b5a3a" : "#e0a83a";
				g.fillRect(cx - size * 0.22, cy - size * 0.16, size * 0.44, size * 0.32);
			} else if (t === CellType.STAIRS_DOWN || t === CellType.STAIRS_UP) {
				g.fillStyle = t === CellType.STAIRS_UP ? "#e8a24a" : "#4ab0e8";
				g.font = `${Math.floor(size * 0.6)}px sans-serif`;
				g.textAlign = "center";
				g.textBaseline = "middle";
				g.fillText(t === CellType.STAIRS_UP ? "▲" : "▼", cx, cy);
			}
		}

	// edges: draw WALLs that border a visited cell
	g.strokeStyle = "#d8d0f0";
	g.lineWidth = Math.max(2, size * 0.1);
	g.lineCap = "square";
	g.beginPath();
	for (const kind of ["h", "v"] as EdgeKind[]) {
		const arr = kind === "h" ? f.hEdges : f.vEdges;
		const stride = kind === "h" ? f.width : f.width + 1;
		for (let i = 0; i < arr.length; i++) {
			if (arr[i] !== EdgeType.WALL || !isEdgeKnown(f, visited, { kind, index: i })) continue;
			const x = i % stride, y = Math.floor(i / stride);
			if (kind === "h") {
				g.moveTo(ox + x * size, oy + y * size);
				g.lineTo(ox + (x + 1) * size, oy + y * size);
			} else {
				g.moveTo(ox + x * size, oy + y * size);
				g.lineTo(ox + x * size, oy + (y + 1) * size);
			}
		}
	}
	g.stroke();

	if (player && player.floor === f.index) {
		const cx = ox + player.x * size + size / 2, cy = oy + player.y * size + size / 2;
		g.save();
		g.translate(cx, cy);
		g.rotate((player.dir * Math.PI) / 2);
		g.fillStyle = "#ff5a5a";
		g.beginPath();
		g.moveTo(0, -size * 0.34);
		g.lineTo(size * 0.26, size * 0.28);
		g.lineTo(-size * 0.26, size * 0.28);
		g.closePath();
		g.fill();
		g.restore();
	}

	g.fillStyle = "#e8e0d0";
	g.font = "bold 20px system-ui, sans-serif";
	g.textAlign = "left";
	g.textBaseline = "top";
	g.fillText(`MAP  ${label}`, 16, 12);
	g.font = "12px system-ui, sans-serif";
	g.globalAlpha = 0.7;
	g.fillText("[ ] 階層切替 / M または ESC で戻る", 16, 40);
	g.globalAlpha = 1;
}
