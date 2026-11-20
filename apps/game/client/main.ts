import * as api from "./api";
import { Game } from "./game";

const menu = document.getElementById("menu")!;
const body = document.getElementById("menu-body")!;

function note(text: string) {
	body.innerHTML = "";
	const p = document.createElement("div");
	p.className = "note";
	p.textContent = text;
	body.append(p);
}

async function launch(id: string) {
	note("ダンジョンを読み込み中…");
	try {
		const manifest = await api.getManifest(id);
		const game = new Game(
			manifest,
			document.getElementById("view") as HTMLCanvasElement,
			document.getElementById("map") as HTMLCanvasElement,
		);
		await game.start();
		menu.classList.add("gone");
	} catch (e) {
		console.error(e);
		note("読み込みに失敗しました。ページを再読み込みしてください。");
	}
}

async function main() {
	try {
		const list = await api.listDungeons();
		if (list.length === 0) {
			note("公開されているダンジョンがありません。(ローカル開発では `npm run seed -w @dungeon/game` で サンプルを登録できます)");
			return;
		}
		body.innerHTML = "";
		for (const d of list) {
			const b = document.createElement("button");
			b.textContent = `${d.name}(${d.floors}階)`;
			b.addEventListener("click", () => void launch(d.id));
			body.append(b);
		}
	} catch (e) {
		console.error(e);
		note("ダンジョン一覧を取得できませんでした。");
	}
}

void main();
