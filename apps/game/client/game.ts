import {
	hasAnyVisited, markVisited, moveForward, packVisited, reconcileSave, resolveArrival,
	takeStairs, turnAround, turnLeft, turnRight,
	type DungeonManifest, type Floor, type PlayerState,
} from "@dungeon/shared";
import * as api from "./api";
import { drawMap } from "./mapview";
import { FloorRenderer } from "./renderer";

type Action = "forward" | "left" | "right" | "back";

const MOVE_MS = 250;
const TURN_MS = 180;
const TURN_BACK_MS = 300;
const SAVE_DEBOUNCE_MS = 1500;

const ease = (t: number) => t * t * (3 - 2 * t);

interface Anim {
	t0: number;
	ms: number;
	from: { x: number; y: number; yaw: number };
	to: { x: number; y: number; yaw: number };
	next: PlayerState;
	action: Action;
}

export class Game {
	private floors: Floor[] = [];
	private player!: PlayerState;
	private visited = new Map<number, Uint8Array>();
	private opened = new Set<string>();
	private inventory: string[] = [];
	/** Continuous camera state; yaw accumulates so turns always go the way the key says. */
	private cam = { x: 0, y: 0, yaw: 0 };
	private anim: Anim | null = null;
	private queued: Action | null = null;
	private mode: "explore" | "map" = "explore";
	private mapFloor = 0;
	private saveTimer: number | undefined;
	private locked = false; // during floor transitions

	private renderer: FloorRenderer;
	private $ = (id: string) => document.getElementById(id)!;

	constructor(private manifest: DungeonManifest, private view: HTMLCanvasElement, private mapCanvas: HTMLCanvasElement) {
		this.renderer = new FloorRenderer(view);
	}

	async start() {
		const m = this.manifest;
		const [floors, save] = await Promise.all([
			Promise.all(m.floors.map((f) => api.getFloor(m.id, f.index, m.revision))),
			api.getSave(m.id).catch(() => null),
		]);
		this.floors = floors;
		const p = reconcileSave(save, { startPoint: m.startPoint, floors });
		this.player = p.position;
		this.visited = p.visited;
		this.opened = p.openedChests;
		this.inventory = p.inventory;
		this.enterFloor(this.player.floor);
		this.cam = { x: this.player.x, y: this.player.y, yaw: -this.player.dir * (Math.PI / 2) };
		this.markHere();

		window.addEventListener("keydown", (e) => this.onKey(e));
		window.addEventListener("resize", () => this.mode === "map" && this.drawMapView());
		window.addEventListener("pagehide", () => this.flushSave(true));
		document.addEventListener("visibilitychange", () => document.hidden && this.flushSave(true));
		this.$("hud").hidden = false;
		requestAnimationFrame((t) => this.frame(t));
	}

	// ---- input -------------------------------------------------------------
	private onKey(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.code === "KeyM") {
			e.preventDefault();
			if (!e.repeat) this.toggleMap();
			return;
		}
		if (this.mode === "map") {
			if (e.code === "Escape") this.toggleMap();
			else if (e.code === "BracketLeft" || e.code === "PageUp") this.shiftMapFloor(-1);
			else if (e.code === "BracketRight" || e.code === "PageDown") this.shiftMapFloor(1);
			if (e.code.startsWith("Arrow") || e.code.startsWith("Page")) e.preventDefault();
			return;
		}
		const action: Action | null =
			e.code === "ArrowUp" ? "forward" : e.code === "ArrowDown" ? "back"
			: e.code === "ArrowLeft" ? "left" : e.code === "ArrowRight" ? "right" : null;
		if (!action) return;
		e.preventDefault();
		if (this.locked) return;
		if (this.anim) this.queued = action;
		else this.begin(action);
	}

	// ---- movement ----------------------------------------------------------
	private begin(action: Action) {
		const f = this.floors[this.player.floor]!;
		const p = this.player;
		let next: PlayerState | null;
		let ms = TURN_MS;
		let dyaw = 0;
		switch (action) {
			case "forward": next = moveForward(f, p); ms = MOVE_MS; break;
			case "left": next = turnLeft(p); dyaw = Math.PI / 2; break;
			case "right": next = turnRight(p); dyaw = -Math.PI / 2; break;
			case "back": next = turnAround(p); dyaw = -Math.PI; ms = TURN_BACK_MS; break; // always clockwise
		}
		if (!next) return; // blocked by a wall
		this.anim = {
			t0: performance.now(), ms, action, next,
			from: { ...this.cam },
			to: { x: next.x, y: next.y, yaw: this.cam.yaw + dyaw },
		};
	}

	private frame(now: number) {
		const a = this.anim;
		if (a) {
			const t = Math.min(1, (now - a.t0) / a.ms);
			const k = ease(t);
			this.cam = {
				x: a.from.x + (a.to.x - a.from.x) * k,
				y: a.from.y + (a.to.y - a.from.y) * k,
				yaw: a.from.yaw + (a.to.yaw - a.from.yaw) * k,
			};
			if (t >= 1) this.finish(a);
		}
		if (this.mode === "explore") {
			this.renderer.setCamera(this.cam.x, this.cam.y, this.cam.yaw);
			this.renderer.render();
		}
		requestAnimationFrame((t) => this.frame(t));
	}

	private finish(a: Anim) {
		this.anim = null;
		this.player = a.next;
		this.cam = { ...a.to };
		if (a.action === "forward") this.onArrive();
		const q = this.queued;
		this.queued = null;
		if (q && !this.locked) this.begin(q);
	}

	private markHere() {
		const f = this.floors[this.player.floor]!;
		markVisited(this.visited.get(f.index)!, f.width, this.player.x, this.player.y);
	}

	private onArrive() {
		this.markHere();
		const f = this.floors[this.player.floor]!;
		const r = resolveArrival(f, this.player, this.opened);
		if (r.openChest) {
			this.opened.add(r.openChest);
			this.renderer.setChestOpened(r.openChest);
			this.toast("宝箱を回収した!");
			this.saveNow();
		} else if (r.stairs) {
			void this.changeFloor(r.stairs);
		} else {
			this.saveSoon();
		}
	}

	private async changeFloor(to: NonNullable<ReturnType<typeof resolveArrival>["stairs"]>) {
		this.locked = true;
		this.queued = null;
		this.$("fade").classList.add("on");
		await new Promise((r) => setTimeout(r, 260));
		this.player = takeStairs(to); // arrival does not re-trigger the stairs; walk off and back to use them again
		this.enterFloor(this.player.floor);
		this.cam = { x: this.player.x, y: this.player.y, yaw: -this.player.dir * (Math.PI / 2) };
		this.markHere();
		this.saveNow();
		this.$("fade").classList.remove("on");
		this.locked = false;
	}

	private enterFloor(index: number) {
		this.renderer.setFloor(this.floors[index]!, this.opened);
		this.$("floor-label").textContent = `${index + 1}F`;
	}

	// ---- map screen --------------------------------------------------------
	private toggleMap() {
		if (this.mode === "explore") {
			this.mode = "map";
			this.mapFloor = this.player.floor;
			this.view.hidden = true;
			this.mapCanvas.hidden = false;
			this.$("hud").hidden = true;
			this.drawMapView();
		} else {
			this.mode = "explore";
			this.mapCanvas.hidden = true;
			this.view.hidden = false;
			this.$("hud").hidden = false;
			this.queued = null;
		}
	}

	private shiftMapFloor(delta: number) {
		const known = this.floors.filter((f) => hasAnyVisited(this.visited.get(f.index)!)).map((f) => f.index);
		const i = known.indexOf(this.mapFloor);
		const next = known[Math.max(0, Math.min(known.length - 1, i + delta))];
		if (next !== undefined) this.mapFloor = next;
		this.drawMapView();
	}

	private drawMapView() {
		const f = this.floors[this.mapFloor]!;
		drawMap(this.mapCanvas, { floor: f, visited: this.visited.get(f.index)! }, this.opened, this.player, `${f.index + 1}F`);
	}

	// ---- UI + persistence --------------------------------------------------
	private toastTimer: number | undefined;
	private toast(msg: string) {
		const el = this.$("toast");
		el.textContent = msg;
		el.hidden = false;
		clearTimeout(this.toastTimer);
		this.toastTimer = window.setTimeout(() => (el.hidden = true), 1800);
	}

	private body(): api.SaveBody {
		const visited: Record<number, string> = {};
		for (const f of this.floors) {
			const bits = this.visited.get(f.index)!;
			if (hasAnyVisited(bits)) visited[f.index] = packVisited(bits, f.width, f.height);
		}
		return {
			dungeonRevision: this.manifest.revision,
			position: this.player,
			visited,
			openedChests: [...this.opened],
			inventory: this.inventory,
		};
	}

	private saveSoon() {
		clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
	}
	private saveNow() {
		this.flushSave();
	}
	private flushSave(keepalive = false) {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		void api.putSave(this.manifest.id, this.body(), keepalive);
	}
}

