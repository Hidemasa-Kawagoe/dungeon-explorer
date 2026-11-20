import {
	CellType, addFloor, getCell, hitTest, isEdgeEditable, openDirs, paintCell, placeStairs, regenerateFloor, removeFloor,
	removeStairs, resizeDungeonFloor, sanitizeDungeon, setEdgeChecked, setStart, toggleEdge, validateDungeon, EdgeType,
	fillRoom, isPassableCell, LIMITS, type Dir, type Dungeon,
} from "@dungeon/shared";
import * as api from "./api";
import { draw, computeView, type Overlay, type View } from "./canvas";
import { h } from "./dom";

type Tool = "floor" | "wall" | "room" | "chest" | "down" | "up" | "start" | "erase";
const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
	{ id: "floor", label: "床", key: "1", hint: "セルをクリック/ドラッグして床を作る(周囲の壁は自動)" },
	{ id: "wall", label: "壁", key: "2", hint: "セルの境界をクリックして壁⇄通路を切替。境界に沿ってドラッグで連続設定" },
	{ id: "room", label: "部屋", key: "3", hint: "ドラッグした矩形を、内部が通路・外周が壁の部屋にする" },
	{ id: "chest", label: "宝箱", key: "4", hint: "セルをクリックで宝箱を置く/外す" },
	{ id: "down", label: "階段 ▼ 下り", key: "5", hint: "クリックで置く(次の階に対の上り階段を自動作成)。もう一度クリックで撤去" },
	{ id: "up", label: "階段 ▲ 上り", key: "6", hint: "クリックで置く(前の階に対の下り階段を自動作成)。もう一度クリックで撤去" },
	{ id: "start", label: "スタート", key: "7", hint: "クリックで開始位置。同じセルを再クリックで向きを回転" },
	{ id: "erase", label: "消しゴム", key: "8", hint: "セル → 消去(VOID)、境界 → 壁を取り除く" },
];

const MAX_UNDO = 60;

interface Stroke {
	snapshot: Dungeon;
	changed: boolean;
	edgeVal?: EdgeType;
	roomStart?: { x: number; y: number };
}

export class Editor {
	private d!: Dungeon;
	private revision = 0;
	private published: number | null = null;
	private fi = 0;
	private tool: Tool = "floor";
	private dirty = false;
	private undo: Dungeon[] = [];
	private redo: Dungeon[] = [];
	private stroke: Stroke | null = null;
	private ov: Overlay = {};
	private view: View = { size: 20, ox: 0, oy: 0 };
	private busy = false;
	private raf = 0;

	private root!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private els!: Record<string, HTMLElement>;
	private cleanup: (() => void)[] = [];

	constructor(private id: string, private onExit: () => void) {}

	async mount(root: HTMLElement) {
		this.root = root;
		const res = await api.load(this.id);
		this.d = res.dungeon;
		this.revision = res.dungeon.revision;
		this.published = res.publishedRevision;
		this.build();
		this.refresh();
	}

	unmount() {
		this.cleanup.forEach((f) => f());
		cancelAnimationFrame(this.raf);
	}

	get hasUnsaved() {
		return this.dirty;
	}

	// ---- UI skeleton --------------------------------------------------------
	private build() {
		const on = <T extends EventTarget>(t: T, ev: string, fn: (e: any) => void, opt?: AddEventListenerOptions) => {
			t.addEventListener(ev, fn, opt);
			this.cleanup.push(() => t.removeEventListener(ev, fn, opt));
		};

		const name = h("input", { type: "text", class: "name", maxLength: 100, value: this.d.name, onInput: () => this.markDirty() });
		const status = h("span", { class: "status" });
		const undoBtn = h("button", { onClick: () => this.doUndo() }, "元に戻す");
		const redoBtn = h("button", { onClick: () => this.doRedo() }, "やり直す");
		const saveBtn = h("button", { class: "primary", onClick: () => void this.save() }, "保存");
		const pubBtn = h("button", { onClick: () => void this.publish() }, "公開");
		const unpubBtn = h("button", { class: "danger", onClick: () => void this.unpublish() }, "公開停止");
		const backBtn = h("button", { onClick: () => this.onExit() }, "← 一覧");

		const toolBtns = new Map<Tool, HTMLButtonElement>();
		const left = h("div", { class: "side" }, h("h3", {}, "ツール"));
		for (const t of TOOLS) {
			const b = h("button", { class: "tool", title: t.hint, onClick: () => this.setTool(t.id) }, h("span", {}, t.label), h("kbd", {}, t.key));
			toolBtns.set(t.id, b);
			left.append(b);
		}
		const hint = h("div", { class: "hint" });
		left.append(h("h3", {}, "説明"), hint);

		const tabs = h("div", { class: "tabs" });
		this.canvas = h("canvas", {});
		const center = h("div", { class: "center" }, tabs, h("div", { class: "canvas-wrap" }, this.canvas));

		const wIn = h("input", { type: "number", min: LIMITS.minSize, max: LIMITS.maxSize });
		const hIn = h("input", { type: "number", min: LIMITS.minSize, max: LIMITS.maxSize });
		const seedIn = h("input", { type: "number", min: 0, value: String(Math.floor(Math.random() * 100000)) });
		const stairsChk = h("input", { type: "checkbox", checked: true });
		const msgs = h("div", { class: "msgs" });
		const checks = h("div", { class: "msgs" });
		const right = h(
			"div",
			{ class: "side right" },
			h("h3", {}, "この階のサイズ"),
			h("div", { class: "row" }, wIn, "×", hIn, h("button", { onClick: () => this.resize(Number(wIn.value), Number(hIn.value)) }, "変更")),
			h("div", { class: "hint" }, "左上基準で拡大/縮小します。縮小で外れた部分は失われます。"),
			h("h3", {}, "自動生成"),
			h("div", { class: "row" }, "シード", seedIn, h("button", { onClick: () => this.generate(Number(seedIn.value), stairsChk.checked) }, "この階を生成")),
			h("label", { class: "row" }, stairsChk, "階段も配置"),
			h("div", { class: "hint" }, "この階の内容を迷路で置き換えます(元に戻せます)。"),
			h("h3", {}, "階の操作"),
			h("div", { class: "row" }, h("button", { onClick: () => this.addFloor() }, "階を追加"), h("button", { class: "danger", onClick: () => this.deleteFloor() }, "この階を削除")),
			h("h3", {}, "メッセージ"),
			msgs,
			h("h3", {}, "公開前チェック"),
			checks,
		);

		this.root.replaceChildren(
			h("div", { class: "screen" },
				h("div", { class: "topbar" }, backBtn, name, status, h("span", { class: "grow" }), undoBtn, redoBtn, saveBtn, pubBtn, unpubBtn),
				h("div", { class: "main" }, left, center, right),
			),
		);
		this.els = { name, status, undoBtn, redoBtn, saveBtn, pubBtn, unpubBtn, tabs, wIn, hIn, msgs, checks, hint, ...Object.fromEntries([...toolBtns].map(([k, v]) => [`tool-${k}`, v])) };

		on(this.canvas, "mousedown", (e) => this.onDown(e));
		on(window, "mousemove", (e) => this.onMove(e));
		on(window, "mouseup", () => this.onUp());
		on(this.canvas, "mouseleave", () => { if (!this.stroke) { this.ov = {}; this.schedule(); } });
		on(this.canvas, "contextmenu", (e) => e.preventDefault());
		on(window, "resize", () => this.schedule());
		on(window, "keydown", (e) => this.onKey(e));
		on(window, "beforeunload", (e) => { if (this.dirty) { e.preventDefault(); e.returnValue = ""; } });
	}

	private setTool(t: Tool) {
		this.tool = t;
		this.refresh();
	}

	// ---- rendering ----------------------------------------------------------
	private schedule() {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			const f = this.d.floors[this.fi]!;
			this.view = computeView(f, this.canvas.clientWidth, this.canvas.clientHeight);
			draw(this.canvas, this.d, this.fi, this.view, this.ov);
		});
	}

	/** Update everything that depends on the dungeon (not per-frame). */
	private refresh() {
		this.fi = Math.min(this.fi, this.d.floors.length - 1);
		const f = this.d.floors[this.fi]!;
		for (const t of TOOLS) this.els[`tool-${t.id}`]!.classList.toggle("active", t.id === this.tool);
		this.els.hint!.textContent = TOOLS.find((t) => t.id === this.tool)!.hint;
		(this.els.wIn as HTMLInputElement).value = String(f.width);
		(this.els.hIn as HTMLInputElement).value = String(f.height);

		this.els.tabs!.replaceChildren(
			...this.d.floors.map((fl) => h("button", { class: `tab${fl.index === this.fi ? " active" : ""}`, onClick: () => { this.fi = fl.index; this.refresh(); } }, `${fl.index + 1}F`)),
		);

		(this.els.undoBtn as HTMLButtonElement).disabled = this.undo.length === 0 || this.busy;
		(this.els.redoBtn as HTMLButtonElement).disabled = this.redo.length === 0 || this.busy;
		(this.els.saveBtn as HTMLButtonElement).disabled = !this.dirty || this.busy;
		(this.els.pubBtn as HTMLButtonElement).disabled = this.busy;
		(this.els.unpubBtn as HTMLButtonElement).hidden = this.published === null;

		const pub = this.published === null ? "未公開" : !this.dirty && this.published === this.revision ? "公開中(最新)" : `公開中: r${this.published}(未反映の変更あり)`;
		this.els.status!.textContent = `r${this.revision} ・ ${pub}${this.dirty ? " ・ ● 未保存" : ""}`;
		this.els.status!.classList.toggle("dirty", this.dirty);

		const errs = validateDungeon(this.d, { forPublish: true });
		this.els.checks!.replaceChildren(
			...(errs.length === 0
				? [h("div", { class: "okmsg" }, "問題ありません")]
				: errs.slice(0, 10).map((m) => h("div", { class: "warnmsg" }, m)).concat(errs.length > 10 ? [h("div", { class: "hint" }, `ほか ${errs.length - 10} 件`)] : [])),
		);
		this.schedule();
	}

	private msg(text: string, kind: "err" | "okmsg" | "warnmsg" = "okmsg", extra: string[] = []) {
		this.els.msgs!.replaceChildren(h("div", { class: kind }, text), ...extra.slice(0, 8).map((e) => h("div", { class: "hint" }, e)));
	}

	// ---- editing ------------------------------------------------------------
	private markDirty() {
		this.dirty = true;
		this.refresh();
	}

	private pushUndo(snapshot: Dungeon) {
		this.undo.push(snapshot);
		if (this.undo.length > MAX_UNDO) this.undo.shift();
		this.redo = [];
	}

	/** Run a discrete, undoable edit. */
	private edit(fn: () => string | null | void) {
		const snap = structuredClone(this.d);
		const err = fn();
		if (err) return this.msg(err, "err");
		sanitizeDungeon(this.d);
		this.pushUndo(snap);
		this.markDirty();
	}

	private doUndo() {
		const prev = this.undo.pop();
		if (!prev) return;
		this.redo.push(structuredClone(this.d));
		this.d = prev;
		this.markDirty();
	}
	private doRedo() {
		const next = this.redo.pop();
		if (!next) return;
		this.undo.push(structuredClone(this.d));
		this.d = next;
		this.markDirty();
	}

	private cellAt(e: MouseEvent) {
		const r = this.canvas.getBoundingClientRect();
		const { size, ox, oy } = this.view;
		return { x: (e.clientX - r.left - ox) / size, y: (e.clientY - r.top - oy) / size };
	}

	private onDown(e: MouseEvent) {
		if (e.button !== 0 || this.busy) return;
		const p = this.cellAt(e);
		this.stroke = { snapshot: structuredClone(this.d), changed: false };
		if (this.tool === "room") {
			const f = this.d.floors[this.fi]!;
			const c = { x: Math.max(0, Math.min(f.width - 1, Math.floor(p.x))), y: Math.max(0, Math.min(f.height - 1, Math.floor(p.y))) };
			this.stroke.roomStart = c;
			this.ov = { rect: { x0: c.x, y0: c.y, x1: c.x, y1: c.y } };
			this.schedule();
			return;
		}
		this.apply(p, true);
	}

	private onMove(e: MouseEvent) {
		const p = this.cellAt(e);
		const f = this.d.floors[this.fi]!;
		if (this.stroke?.roomStart) {
			const c = { x: Math.max(0, Math.min(f.width - 1, Math.floor(p.x))), y: Math.max(0, Math.min(f.height - 1, Math.floor(p.y))) };
			this.ov = { rect: { x0: this.stroke.roomStart.x, y0: this.stroke.roomStart.y, x1: c.x, y1: c.y } };
			return this.schedule();
		}
		if (this.stroke) this.apply(p, false);
		const t = hitTest(f, p.x, p.y);
		this.ov = t ? (t.type === "cell" ? { hoverCell: t } : { hoverEdge: t.ref }) : {};
		this.schedule();
	}

	private onUp() {
		const s = this.stroke;
		if (!s) return;
		this.stroke = null;
		if (s.roomStart && this.ov.rect) {
			const r = this.ov.rect;
			this.ov = {};
			fillRoom(this.d.floors[this.fi]!, r.x0, r.y0, r.x1, r.y1);
			s.changed = true;
		}
		if (s.changed) {
			sanitizeDungeon(this.d);
			this.pushUndo(s.snapshot);
			this.markDirty();
		} else {
			this.refresh();
		}
	}

	/** Apply the active tool at a point. `first` = the mouse-down event of the stroke. */
	private apply(p: { x: number; y: number }, first: boolean) {
		const s = this.stroke!;
		const fi = this.fi;
		const f = this.d.floors[fi]!;
		const t = hitTest(f, p.x, p.y, 0.2);
		if (!t) return;
		let changed = false;

		switch (this.tool) {
			case "floor":
				if (t.type === "cell" && getCell(f, t.x, t.y) !== CellType.FLOOR) {
					paintCell(this.d, fi, t.x, t.y, CellType.FLOOR);
					changed = true;
				}
				break;
			case "wall":
				if (t.type === "edge") {
					if (s.edgeVal === undefined) {
						const v = toggleEdge(f, t.ref);
						if (v !== null) { s.edgeVal = v; changed = true; }
					} else changed = setEdgeChecked(f, t.ref, s.edgeVal);
				}
				break;
			case "erase":
				if (t.type === "cell" && getCell(f, t.x, t.y) !== CellType.VOID) {
					paintCell(this.d, fi, t.x, t.y, CellType.VOID);
					changed = true;
				} else if (t.type === "edge") changed = setEdgeChecked(f, t.ref, EdgeType.OPEN);
				break;
			case "chest":
				if (first && t.type === "cell") {
					paintCell(this.d, fi, t.x, t.y, getCell(f, t.x, t.y) === CellType.CHEST ? CellType.FLOOR : CellType.CHEST);
					changed = true;
				}
				break;
			case "down":
			case "up":
				if (first && t.type === "cell") {
					const want = this.tool === "down" ? CellType.STAIRS_DOWN : CellType.STAIRS_UP;
					if (getCell(f, t.x, t.y) === want) {
						removeStairs(this.d, fi, t.x, t.y);
						changed = true;
					} else {
						const err = placeStairs(this.d, fi, t.x, t.y, this.tool);
						if (err) this.msg(err, "err");
						else changed = true;
					}
				}
				break;
			case "start":
				if (first && t.type === "cell" && isPassableCell(f, t.x, t.y)) {
					const sp = this.d.startPoint;
					const same = sp.floor === fi && sp.x === t.x && sp.y === t.y;
					const dir = (same ? (sp.dir + 1) % 4 : (openDirs(f, t.x, t.y)[0] ?? sp.dir)) as Dir;
					changed = setStart(this.d, fi, t.x, t.y, dir);
				}
				break;
		}
		if (changed) {
			s.changed = true;
			sanitizeDungeon(this.d);
			this.schedule();
		}
	}

	private addFloor() {
		const f = this.d.floors[this.fi]!;
		if (this.d.floors.length >= LIMITS.maxFloors) return this.msg(`階数は最大 ${LIMITS.maxFloors} です`, "err");
		this.edit(() => { addFloor(this.d, f.width, f.height); });
		this.fi = this.d.floors.length - 1;
		this.refresh();
	}

	private deleteFloor() {
		if (this.d.floors.length <= 1) return this.msg("最後の階は削除できません", "err");
		if (!confirm(`${this.fi + 1}F を削除しますか?(元に戻せます。接続されていた階段も取り除かれます)`)) return;
		this.edit(() => { removeFloor(this.d, this.fi); });
		this.fi = Math.min(this.fi, this.d.floors.length - 1);
		this.refresh();
	}

	private resize(w: number, hh: number) {
		const f = this.d.floors[this.fi]!;
		if (![w, hh].every((n) => Number.isInteger(n) && n >= LIMITS.minSize && n <= LIMITS.maxSize)) {
			return this.msg(`サイズは ${LIMITS.minSize}〜${LIMITS.maxSize} の整数で指定してください`, "err");
		}
		if ((w < f.width || hh < f.height) && !confirm("縮小すると範囲外の内容(階段の接続を含む)が失われます。続けますか?")) return;
		this.edit(() => { resizeDungeonFloor(this.d, this.fi, w, hh); });
		this.msg(`${w}×${hh} に変更しました`);
	}

	private generate(seed: number, withStairs: boolean) {
		if (!Number.isInteger(seed) || seed < 0) return this.msg("シードは 0 以上の整数です", "err");
		if (!confirm(`${this.fi + 1}F の内容を自動生成で置き換えます。続けますか?(元に戻せます)`)) return;
		this.edit(() => { regenerateFloor(this.d, this.fi, seed, withStairs); });
		this.msg("生成しました。壁・宝箱・階段は手で修正できます");
	}

	// ---- keyboard -----------------------------------------------------------
	private onKey(e: KeyboardEvent) {
		const el = e.target as HTMLElement;
		if (el.tagName === "INPUT") return;
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); }
		else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.doRedo(); }
		else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void this.save(); }
		else if (!mod) {
			const t = TOOLS.find((x) => x.key === e.key);
			if (t) this.setTool(t.id);
		}
	}

	// ---- persistence --------------------------------------------------------
	private async guarded(fn: () => Promise<void>) {
		if (this.busy) return;
		this.busy = true;
		this.refresh();
		try {
			await fn();
		} catch (e) {
			if (e instanceof api.ApiError) {
				if (e.status === 409) this.msg("他の場所でこのダンジョンが更新されています。ページを再読み込みして最新を取得してください(未保存の変更は失われます)", "err");
				else this.msg(`失敗しました: ${e.message}`, "err", e.errors);
			} else {
				console.error(e);
				this.msg("通信に失敗しました", "err");
			}
		} finally {
			this.busy = false;
			this.refresh();
		}
	}

	private async saveInner() {
		const name = (this.els.name as HTMLInputElement).value.trim();
		if (!name) throw new api.ApiError(400, "名前を入力してください");
		this.d.name = name;
		const r = await api.save(this.d, this.revision);
		this.revision = r.revision;
		this.d.revision = r.revision;
		this.dirty = false;
		this.msg(`保存しました(r${r.revision})`);
	}

	save() {
		return this.guarded(() => this.saveInner());
	}

	publish() {
		return this.guarded(async () => {
			if (this.dirty) await this.saveInner();
			const r = await api.publish(this.id);
			this.published = r.publishedRevision;
			this.msg(`公開しました(r${r.publishedRevision})`);
		});
	}

	unpublish() {
		if (!confirm("公開を停止しますか?プレイヤーはこのダンジョンを遊べなくなります(セーブデータは残ります)。")) return Promise.resolve();
		return this.guarded(async () => {
			await api.unpublish(this.id);
			this.published = null;
			this.msg("公開を停止しました");
		});
	}
}
