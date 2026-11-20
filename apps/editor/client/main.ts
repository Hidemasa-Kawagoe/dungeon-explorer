import type { DraftIndexEntry } from "@dungeon/shared";
import * as api from "./api";
import { h } from "./dom";
import { Editor } from "./editor";

const app = document.getElementById("app")!;
let editor: Editor | null = null;
let currentHash = location.hash;
let restoring = false;

function go(hash: string) {
	if (editor?.hasUnsaved && !confirm("未保存の変更があります。破棄して移動しますか?")) return;
	currentHash = hash; // already confirmed: the hashchange handler must not ask again
	if (location.hash !== hash) location.hash = hash;
	else void route();
}

async function route() {
	editor?.unmount();
	editor = null;
	const m = /^#\/d\/([A-Za-z0-9_-]+)$/.exec(location.hash);
	if (m) {
		app.replaceChildren(h("div", { class: "list" }, "読み込み中…"));
		try {
			editor = new Editor(m[1]!, () => go("#/"));
			await editor.mount(app);
		} catch (e) {
			console.error(e);
			app.replaceChildren(h("div", { class: "list" }, "ダンジョンを読み込めませんでした。", h("button", { onClick: () => go("#/") }, "一覧へ")));
		}
		return;
	}
	await showList();
}

async function showList() {
	app.replaceChildren(h("div", { class: "list" }, "読み込み中…"));
	let items: DraftIndexEntry[], email = "";
	try {
		[items, { email }] = await Promise.all([api.list(), api.me()]);
	} catch (e) {
		console.error(e);
		app.replaceChildren(h("div", { class: "list" }, "一覧を取得できませんでした。"));
		return;
	}

	const name = h("input", { type: "text", placeholder: "ダンジョン名", maxLength: 100 });
	const w = h("input", { type: "number", min: 5, max: 64, value: "10" });
	const hh = h("input", { type: "number", min: 5, max: 64, value: "10" });
	const floors = h("input", { type: "number", min: 1, max: 20, value: "1" });
	const gen = h("input", { type: "checkbox" });
	const err = h("div", { class: "msgs" });
	const createBtn = h("button", { class: "primary" }, "作成");
	createBtn.addEventListener("click", async () => {
		createBtn.disabled = true;
		try {
			const r = await api.create({ name: name.value, width: Number(w.value), height: Number(hh.value), floors: Number(floors.value), generate: gen.checked });
			go(`#/d/${r.id}`);
		} catch (e) {
			err.replaceChildren(h("div", { class: "err" }, e instanceof api.ApiError ? e.message : "作成に失敗しました"));
		} finally {
			createBtn.disabled = false;
		}
	});

	const rows = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((e) => {
		const del = h("button", { class: "danger" }, "削除");
		del.addEventListener("click", async () => {
			if (!confirm(`「${e.name}」を削除しますか?公開中の場合は公開も取り消され、元に戻せません。`)) return;
			try { await api.remove(e.id); void showList(); } catch { alert("削除に失敗しました"); }
		});
		return h("tr", {},
			h("td", {}, e.name),
			h("td", {}, `${e.floors}階`),
			h("td", {}, `r${e.revision}`),
			h("td", {}, e.publishedRevision === null ? h("span", { class: "badge" }, "未公開") : h("span", { class: "badge pub" }, `公開中 r${e.publishedRevision}`)),
			h("td", {}, new Date(e.updatedAt).toLocaleString("ja-JP"), e.updatedBy ? ` / ${e.updatedBy}` : ""),
			h("td", { class: "row" }, h("button", { onClick: () => go(`#/d/${e.id}`) }, "開く"), del),
		);
	});

	app.replaceChildren(
		h("div", { class: "list" },
			h("div", { class: "row" }, h("h1", { style: "margin:0;flex:1" }, "Dungeon Editor"), h("span", { class: "status" }, email)),
			h("div", { class: "card" },
				h("div", { class: "row" }, name, "幅", w, "高さ", hh, "階数", floors, h("label", {}, gen, "迷路を自動生成"), createBtn),
				err,
			),
			items.length === 0
				? h("p", { class: "hint" }, "まだダンジョンがありません。上のフォームから作成してください。")
				: h("table", {}, h("thead", {}, h("tr", {}, ...["名前", "階層", "版", "公開", "更新", ""].map((t) => h("th", {}, t)))), h("tbody", {}, ...rows)),
		),
	);
}

window.addEventListener("hashchange", () => {
	if (restoring) {
		restoring = false;
		return;
	}
	// Browser back/forward bypasses go(): ask here and put the hash back if the user cancels.
	if (editor?.hasUnsaved && location.hash !== currentHash && !confirm("未保存の変更があります。破棄して移動しますか?")) {
		restoring = true;
		location.hash = currentHash;
		return;
	}
	currentHash = location.hash;
	void route();
});
void route();
