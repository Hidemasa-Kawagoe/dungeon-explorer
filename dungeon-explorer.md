# 3Dダンジョン探索 Phase 1 設計書

## 1. 概要・スコープ

Cloudflare 上で動作する、一人称視点・グリッド移動型の 3D ダンジョン探索アプリ。

### Phase 1 で実現すること
| 区分 | 内容 |
|---|---|
| 探索 | 1セル単位のグリッド移動(アニメーション付き)、向き変更 |
| 宝箱 | 宝箱セルに移動して回収 |
| 階層移動 | 上り/下り階段セルに乗ると階層間を移動 |
| マップ画面 | `M` で表示/非表示(再度 `M` または `ESC` で戻る) |
| 自動マッピング | 踏破したセルのみ記録・表示 |
| マップエディタ | サイズ指定(初期 10×10)、複数フロア、壁/通路/宝箱/階段配置、簡易自動生成 |

### Phase 1 の非スコープ
敵・戦闘、アイテム管理画面、マルチプレイ、ユーザー認証(匿名IDのみ)、モバイルタッチ操作。

## 2. 技術構成

| レイヤ | 採用技術 | 理由 |
|---|---|---|
| ゲーム用 Worker (`dungeon-game`) | Workers + Static Assets | 一般公開。探索画面の配信、公開済みマップの読み取り、プレイヤーのセーブ |
| **エディタ用 Worker (`dungeon-editor`)** | Workers + Static Assets + Durable Objects | **ゲームとは別 Worker・別ホスト名**。Cloudflare Access で保護し、マップの作成・編集・公開のみを担当 |
| API | 軽量ルータ(Hono 等)または素の `fetch` | REST JSON |
| フロント | TypeScript + Vite、**Three.js**(探索 3D)、Canvas 2D(マップ/エディタ) | 2つのフロントビルド(game / editor)に分割 |
| マップデータ | **R2 Object Storage** | フロアデータ JSON。revision 単位の不変オブジェクト |
| 軽量メタ/セーブ | **Workers KV** | ダンジョン一覧、プレイヤーセーブ |
| 排他制御 | **Durable Objects**(エディタ側のみ) | 保存の直列化・revision 採番 |

> 実装着手時に Workers / KV / R2 / Durable Objects / Access の最新ドキュメントと制限値を必ず確認すること(AGENTS.md 方針)。

### 2.1 Worker 分割とアクセス制御の方針

| 項目 | dungeon-game(公開) | dungeon-editor(要認証) |
|---|---|---|
| ホスト名 | `play.example.com` | `editor.example.com` |
| 認証 | なし(匿名 playerId Cookie) | **Cloudflare Access**(メール OTP / IdP、許可ユーザーのみ) |
| 公開マップ (R2/KV) | **読み取りのみ**(コード上で read 系 API のみ使用) | 読み書き |
| ドラフト/編集データ | **バインドしない**(アクセス不能) | 読み書き |
| プレイヤーセーブ KV | 読み書き | バインドしない |
| Durable Objects | 使わない | `DungeonEditorLock` を定義・使用 |

ポイント:

1. **責務の分離**: 書き込み権限を持つバインディングはエディタ Worker だけに付与する。ゲーム Worker が侵害・バグで暴走しても、マップ本体を書き換えられない構成にする(R2/KV バインディング自体に読み取り専用の指定はないため、ゲーム側は「公開用の読み取り API のみ実装」+ 下記のバケット/名前空間の分離で被害範囲を限定)。
2. **ストレージの分離**:
   - R2 バケットを `dungeon-draft`(編集中。エディタのみバインド)と `dungeon-published`(公開版。エディタが書き、ゲームは読むだけ)に分ける。
   - KV 名前空間を `DUNGEON_META`(一覧・公開メタ。エディタが書き、ゲームは読む)と `PLAYER_SAVE`(ゲームのみ)に分ける。
3. **Cloudflare Access による保護**(エディタのホスト名全体):
   - Zero Trust で Self-hosted アプリケーションとして `editor.example.com/*` を登録し、許可メールアドレス/グループのみ許可するポリシーを設定する。
   - **多層防御**: エディタ Worker 自身も、すべてのリクエストで `Cf-Access-Jwt-Assertion` ヘッダの JWT を検証する(チーム ドメインの JWKS で署名検証、`aud` = Access アプリの AUD タグ、`exp`、`iss`)。検証失敗は 403。Access を経由しない直アクセスを防ぐ。
   - **迂回路の閉鎖**: エディタ Worker は `workers_dev: false`、`preview_urls: false` とし、カスタムドメイン(ルート)経由でのみ公開する。`*.workers.dev` / プレビュー URL から Access をすり抜けられないようにする。
   - 書き込み系 API は JWT のメールアドレスを `updatedBy` として監査ログ(manifest)に記録する。
   - CSRF 対策: 書き込み API は `Content-Type: application/json` 必須 + `Origin` ヘッダ検証。
4. **公開フロー(ドラフト → 公開)**: エディタで保存した内容はドラフトとして保持し、「公開」操作で `dungeon-published` と `DUNGEON_META` に反映する。プレイヤーは公開版だけを見る。編集途中のマップがプレイヤーに見えない。
5. **ゲーム側 → エディタ**: ゲームからエディタへの依存は持たない(プレビュー用の「テストプレイ」はエディタ Worker 内にドラフトを読む試遊ビューを持たせ、ゲームのクライアントコードを共有ライブラリとして再利用する)。

### 2.2 Durable Objects の扱い
Phase 1 では単独プレイのため、DO は**エディタ Worker の保存処理のみ**に使う。

- **`DungeonEditorLock`(ダンジョン ID ごとに 1 インスタンス)**: 保存・公開リクエストを直列化し、`revision` の楽観ロック検証 → R2 書き込み → KV 更新を行う。KV は結果整合のため、revision 採番と更新順序は DO 内ストレージで担保する。
- ゲーム Worker のセーブは本人のみが書くので KV 直書き(最終書き込み優先)。
- 将来の共同編集(WebSocket)も DO で拡張可能。

## 3. アーキテクチャ

```
                    ┌───────────────────────────────────────────┐
Player ─ play.example.com ─▶ Worker: dungeon-game (public)
                    │   ├─ Static Assets (game client)
                    │   ├─ R2  PUBLISHED  (read)
                    │   ├─ KV  DUNGEON_META (read)
                    │   └─ KV  PLAYER_SAVE (read/write)
                    │
Editor ─ editor.example.com ─▶ [Cloudflare Access] ─▶ Worker: dungeon-editor
                    │   ├─ JWT 検証 (Cf-Access-Jwt-Assertion)
                    │   ├─ Static Assets (editor client)
                    │   ├─ R2  DRAFT (read/write), PUBLISHED (write)
                    │   ├─ KV  DUNGEON_META (write)
                    │   └─ DO  EDITOR_LOCK
                    └───────────────────────────────────────────┘
```

### wrangler 設定(案)

`dungeon-game`(既存の `wrangler.jsonc` を使用):
```jsonc
{
  "name": "dungeon-game",
  "main": "src/game/index.ts",
  "assets": { "directory": "./dist/game", "binding": "ASSETS", "not_found_handling": "single-page-application" },
  "kv_namespaces": [
    { "binding": "DUNGEON_META", "id": "<meta-kv-id>" },   // read のみ使用
    { "binding": "PLAYER_SAVE", "id": "<save-kv-id>" }
  ],
  "r2_buckets": [{ "binding": "PUBLISHED", "bucket_name": "dungeon-published" }], // read のみ使用
  "routes": [{ "pattern": "play.example.com", "custom_domain": true }]
}
```

`dungeon-editor`(別ディレクトリ `editor/wrangler.jsonc`):
```jsonc
{
  "name": "dungeon-editor",
  "main": "src/index.ts",
  "workers_dev": false,
  "preview_urls": false,
  "assets": { "directory": "./dist/client", "binding": "ASSETS", "run_worker_first": true, "not_found_handling": "single-page-application" },
  "kv_namespaces": [{ "binding": "DUNGEON_META", "id": "<meta-kv-id>" }],
  "r2_buckets": [
    { "binding": "DRAFT", "bucket_name": "dungeon-draft" },
    { "binding": "PUBLISHED", "bucket_name": "dungeon-published" }
  ],
  "durable_objects": { "bindings": [{ "name": "EDITOR_LOCK", "class_name": "DungeonEditorLock" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DungeonEditorLock"] }],
  "vars": { "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com" },  // AUD は secret/vars で管理
  "routes": [{ "pattern": "editor.example.com", "custom_domain": true }]
}
```
各 Worker のディレクトリで `npx wrangler types` を実行する。

## 4. データモデル

### 4.1 マップ表現(セル + エッジ)

**壁はセルの属性ではなく、セル境界(エッジ)の属性として保持する。** セルは「部屋/通路の床」を表し、隣り合うセル間の通行可否はその間のエッジで決まる。

```
 N×M セル(例: 3×2)            水平エッジ hEdges: 幅 N × (M+1)
 +--+--+--+  y=0 の上端         index = y*N + x  … セル(x,y) の「北側」の辺
 |c |c |c |                     y = M の行はマップ最南端(セル(x,M-1)の南側)
 +--+--+--+
 |c |c |c |                     垂直エッジ vEdges: (N+1) × M
 +--+--+--+  y=M                index = y*(N+1) + x … セル(x,y) の「西側」の辺
                                 x = N の列はマップ最東端(セル(N-1,y)の東側)
```

```ts
type CellType =
  | 0 // VOID   (未使用。侵入不可・描画しない)
  | 1 // FLOOR  (床/通路)
  | 2 // CHEST  (宝箱。通行可)
  | 3 // STAIRS_DOWN
  | 4 // STAIRS_UP

type EdgeType =
  | 0 // OPEN  (通行可)
  | 1 // WALL  (壁。通行不可)
  // 2 は将来 DOOR(開閉扉)、3 は SECRET 等のために予約(Phase 1 では未使用)

interface Floor {
  index: number;            // 階層番号 (0 = 1F)
  width: number;            // N
  height: number;           // M
  cells: number[];          // 長さ N*M, 行優先 (y*N + x)。CellType
  hEdges: number[];         // 長さ N*(M+1)。水平方向の辺 (y*N + x) = セル(x,y)の北辺 / (x,y-1)の南辺
  vEdges: number[];         // 長さ (N+1)*M。垂直方向の辺 (y*(N+1) + x) = セル(x,y)の西辺 / (x-1,y)の東辺
  links: StairLink[];       // 階段の接続
  chests: Record<string, ChestInfo>; // key = "x,y"
}

type Dir = 0 | 1 | 2 | 3; // 0=北(y-1) 1=東(x+1) 2=南(y+1) 3=西(x-1)

// セル(x,y) の dir 側のエッジ
function edgeIndex(f: Floor, x: number, y: number, dir: Dir):
  { kind: 'h' | 'v'; index: number } {
  switch (dir) {
    case 0: return { kind: 'h', index: y * f.width + x };         // 北辺
    case 2: return { kind: 'h', index: (y + 1) * f.width + x };   // 南辺
    case 3: return { kind: 'v', index: y * (f.width + 1) + x };   // 西辺
    case 1: return { kind: 'v', index: y * (f.width + 1) + x + 1 }; // 東辺
  }
}

// 移動可否: エッジが OPEN かつ 移動先セルが範囲内かつ VOID でない
function canMove(f: Floor, x: number, y: number, dir: Dir): boolean;

interface StairLink {
  from: { x: number; y: number };               // この階の階段セル
  to:   { floor: number; x: number; y: number; dir: Dir }; // 移動先(到着セルと向き)
}

interface ChestInfo { id: string; contents?: string } // Phase1 は固定メッセージ/ダミーでよい

interface Dungeon {
  id: string;               // ULID/UUID
  name: string;
  revision: number;         // 保存ごとに +1
  startPoint: { floor: number; x: number; y: number; dir: Dir };
  floors: Floor[];          // 保存時は floor 単位に分割して R2 へ
  updatedAt: string;
}
```

不変条件(エディタ・サーバ両方で検証/補正):
- マップ外周のエッジは必ず `WALL`。
- `VOID` セルに接するエッジは(反対側がマップ外/VOID でも)`WALL` として扱う。描画対象は「少なくとも片側が非 VOID セル」のエッジのみ。
- 通行可否の判定は常に **エッジ + 移動先セルの種別** の 2 条件(セルの種別だけで壁を判断しない)。

保存サイズ目安: 64×64 でも cells 約4KB + エッジ約8KB(各1バイト/要素)。JSON 配列のままで十分小さい(必要なら base64 化)。

### 4.2 プレイヤー進行(セーブ)
```ts
interface PlayerSave {
  playerId: string;
  dungeonId: string;
  dungeonRevision: number;      // 保存時のダンジョン版。不一致時はマップ記録を整合させる
  position: { floor: number; x: number; y: number; dir: Dir };
  visited: Record<number, string>;   // floor → "WxH:base64" 訪問済みビットマップ(1bit/セル。サイズを併記し、改訂でサイズが変わった階は破棄)
  openedChests: string[];            // "floor:x,y"
  inventory: string[];
  updatedAt: string;
}
```
- 自動マッピングは **訪問済みセルのビットマップ** のみ保存(エッジの情報はダンジョン本体から導出)。
- マップ画面では「訪問済みセル」と「その4辺のエッジ(壁/開口)」だけを描画する。エッジは、隣接する2セルのどちらかが訪問済みなら既知として扱う。

## 5. ストレージ設計

### 5.1 R2(マップ本体)

バケットは 2 つに分離する。

| バケット | 書き込み | 読み取り | 用途 |
|---|---|---|---|
| `dungeon-draft` | editor | editor | 編集中のドラフト |
| `dungeon-published` | editor(公開時のみ) | game, editor | プレイヤーに見える公開版 |

キー構造(両バケット共通):

| キー | 内容 |
|---|---|
| `dungeons/{dungeonId}/manifest.json` | `Dungeon` のメタ(name, revision, startPoint, floor 数, 各フロアサイズ, `updatedBy`, `publishedBy`) |
| `dungeons/{dungeonId}/r{revision}/floor-{n}.json` | `Floor` データ(不変。revision ごとに別キー) |

- 保存/公開は「新 revision のフロアを書き込み → 最後に manifest を更新」の順。manifest が切り替わるまで旧版が有効なため、途中失敗しても破損しない。
- 古い revision は、直近 N 世代を残して削除(Phase 1 では保存時にまとめて削除)。
- ゲームは公開版 manifest → 必要な floor のみ取得。revision がキーなので `Cache-Control` を長期設定し、Cache API / ブラウザキャッシュを活用。

### 5.2 KV

| 名前空間 | キー | 値 | 書き込み | 読み取り |
|---|---|---|---|---|
| `DUNGEON_META` | `dungeon:index` | 公開済み一覧 `[{id,name,revision,floors,publishedAt}]` | editor | game, editor |
| (R2 `dungeon-draft`) | `index.json` | ドラフト含む一覧(エディタ専用)。**KV ではなく R2 に置く**: 強整合で、ゲームと共有する名前空間にも載らない | editor(index DO 経由) | editor のみ |
| `PLAYER_SAVE` | `save:{playerId}:{dungeonId}` | `PlayerSave` JSON(数KB、TTL なし) | game | game |

- `playerId` は初回アクセスで game Worker が生成し、`HttpOnly; Secure; SameSite=Lax` Cookie で保持(匿名)。
- KV は結果整合(反映に最大 60 秒程度かかる場合あり)であるため、**セーブは「クライアントが最新状態を保持し、定期/節目で PUT」**し、読み込みは起動時のみとする。

## 6. API

### 6.1 ゲーム API(`dungeon-game`、公開・読み取り中心)

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/dungeons` | 公開済みダンジョン一覧 (KV `DUNGEON_META`) |
| GET | `/api/dungeons/:id` | 公開版 manifest (R2 `PUBLISHED`) |
| GET | `/api/dungeons/:id/floors/:n?rev=` | 公開版フロア (R2 `PUBLISHED`、revision キーで長期キャッシュ) |
| GET | `/api/save/:dungeonId` | 自分のセーブ取得 (KV `PLAYER_SAVE`) |
| PUT | `/api/save/:dungeonId` | セーブ更新 (KV `PLAYER_SAVE`、サイズ上限・スキーマ検証) |

マップを書き換える API は**ゲーム Worker に存在しない**。

### 6.2 エディタ API(`dungeon-editor`、Cloudflare Access 保護下)

すべてのリクエストで Access JWT を検証(§2.1)。

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/dungeons` | ドラフトを含む一覧 |
| POST | `/api/dungeons` | 新規作成(`{name, width, height}`) |
| GET | `/api/dungeons/:id` | ドラフト manifest (R2 `DRAFT`) |
| GET | `/api/dungeons/:id/floors/:n` | ドラフトフロア |
| PUT | `/api/dungeons/:id` | ドラフト保存。`If-Match: <revision>` 必須 → DO 経由。不一致は 409 |
| POST | `/api/dungeons/:id/publish` | ドラフトを公開版へ反映(R2 `PUBLISHED` + KV `DUNGEON_META`)→ DO 経由 |
| POST | `/api/dungeons/:id/unpublish` | 公開停止 |
| DELETE | `/api/dungeons/:id` | 削除(ドラフト・公開版) |

### バリデーション(保存・公開時、サーバ側で必ず実施)
- `width, height`: 整数 5〜64(初期値 10)。`cells.length === width*height`、`hEdges.length === width*(height+1)`、`vEdges.length === (width+1)*height`
- 各エッジ値が既知の `EdgeType`、各セル値が既知の `CellType`
- 外周エッジがすべて `WALL`、`VOID` セルに接するエッジがすべて `WALL`
- スタート地点が非 VOID セル
- 階段セルすべてに `links` が存在し、リンク先が有効な非 VOID セル
- フロア数上限(例: 20)、リクエストサイズ上限(例: 1MB)
- 公開時は追加で、スタートから**エッジの開口を辿って**全階段・宝箱へ到達できることを BFS で検証


## 7. 探索モード(クライアント)

### 7.1 状態
```ts
interface Player { floor: number; x: number; y: number; dir: Dir }
```
論理状態はグリッド座標・向き(離散)、描画は補間値(連続)を別に持つ。

### 7.2 入力
| キー | 動作 |
|---|---|
| ↑ | 前方1セル移動(前方エッジが壁、または移動先が VOID/範囲外なら不可。移動アニメ中は入力をキューまたは無視) |
| ↓ | **右回りで180°回転**(後ろを向く)。※「後退」ではなく向き変更 |
| ← / → | 左 / 右に90°旋回 |
| M | マップ画面トグル |
| ESC | マップ画面を閉じる |

### 7.3 アニメーション
- 移動: 約 250ms、イージング付きでカメラ位置を線形補間。壁にぶつかる場合は移動せず、短いバンプ演出(約 80ms の微小な前後揺れ)と効果音のみ(Phase 1 では省略可)。
- 回転: 90° 約 180ms、180° は右回りで約 300ms(角度を連続値で保持し、最短経路ではなく**常に右回り**で補間)。
- `requestAnimationFrame` で更新。アニメ完了時に論理状態確定 → セル判定。

### 7.4 セル到着時イベント
1. 訪問済みビットを更新(自動マッピング)。
2. `CHEST` かつ未回収 → 回収処理(メッセージ表示、`openedChests` 追加、セルは見た目を開封済みに)。
3. `STAIRS_*` → `links` に従い階層切り替え(フェード演出、到着位置・向きを設定、フロアを R2 から未取得ならロード)。
4. セーブを非同期に PUT(デバウンス、階層移動・宝箱回収時は即時)。

### 7.5 3D描画
- 座標系: セル(x,y) は XZ 平面上の `[x, x+1] × [y, y+1]`。エッジはセル間の線分で、壁は**エッジ上に立てた薄い板(クアッド)**として描画。
- カメラ高さ 0.5、FOV 約 70°、セル 1.0 単位。
- 壁: `WALL` かつ「少なくとも片側が非 VOID セル」のエッジごとに、高さ 1.0 の平面(両面描画、または厚み 0.05 の薄いボックス)を生成。全壁を 1 つの `BufferGeometry` にマージして draw call を最小化(または `InstancedMesh`)。
  - 水平エッジ (x, y): 始点 `(x, y)` → 終点 `(x+1, y)`
  - 垂直エッジ (x, y): 始点 `(x, y)` → 終点 `(x, y+1)`
- 床・天井: 非 VOID セルごとに 1×1 の平面(マージして描画)。VOID セルは何も描画しない。
- 宝箱 / 階段: セル中央に簡易ジオメトリ(ボックス、階段状メッシュ)+ 色分け。
- ライティング: プレイヤーに追従するポイントライト + 距離フォグで視界を絞る。
- フロア切り替え時にジオメトリを再構築(10×10〜64×64 では全描画で可。必要ならカメラ周辺のチャンクのみ描画)。
- 壁の面ごとのテクスチャ/色はエッジ値で切り替え可能な構造にしておく(将来の扉・隠し壁用)。

## 8. マップ画面・自動マッピング
- 初期状態は全セル未訪問(非表示)。
- 訪問済みセルを塗りつぶし、その**4辺のエッジ**を描画する: `WALL` は太線、`OPEN` は線なし(または薄い点線)。隣接2セルのどちらかが訪問済みならそのエッジは既知。
  - 例: 通路の途中で左右に壁があれば、そのセルに入った時点で両側の壁が地図に現れる。
- 階段・開封済み/未開封の宝箱は訪問済みなら記号表示。
- 現在位置と向きを矢印で表示。階層切り替え(`[` `]` もしくは `PageUp/PageDown`)で既知の他階も閲覧可能。
- Canvas 2D 描画。`M`/`ESC` で探索画面に戻る(その間、探索入力は無効)。

## 9. マップエディタ

### 9.1 画面
- `/editor`: ダンジョン選択/新規作成 → グリッド編集キャンバス。
- 新規作成時にサイズ N×M(初期 10×10)を指定。サイズ変更は既存内容を左上基準でトリム/拡張。
- フロアタブ: 追加・削除・並び替え。

### 9.2 ツール
編集キャンバスはセルとエッジの両方を操作できる。カーソル位置から**最も近い要素**を判定する: セル内部(中央付近)ならセル操作、セル境界付近(各辺から約 20% 以内)ならエッジ操作。境界ヒットは最寄りのエッジ(水平/垂直)にスナップし、ハイライト表示する。

| ツール | 対象 | 内容 |
|---|---|---|
| 床 | セル | `FLOOR` を配置(ドラッグで連続配置)。オプション「自動で外周に壁を張る」: 隣接が VOID/マップ外のエッジを `WALL` に、隣接する他の床セルとの間は `OPEN` にする |
| 壁 | エッジ | クリックで `WALL` ⇄ `OPEN` を切替。境界線に沿ったドラッグで連続設定(ドラッグ開始エッジの反転結果を全体に適用) |
| 部屋 | セル+エッジ | 矩形ドラッグで、内部を `FLOOR`・内部エッジを `OPEN`・周囲を `WALL` にする |
| 宝箱 | セル | 配置/削除 |
| 階段(下り/上り) | セル | 配置後、接続先(フロア・セル・到着向き)をダイアログで指定。接続先に対となる階段を**自動生成するオプション** |
| スタート地点 | セル | 開始位置と向き |
| 消しゴム | セル/エッジ | セル → `VOID`(接するエッジは自動で `WALL`)、エッジ → `OPEN` |
| 塗りつぶし / Undo-Redo | - | 補助。Undo の単位はセルとエッジの変更をまとめた操作 |

不変条件(§4.1)に違反する編集(外周を `OPEN` にする等)は、エディタが即座に拒否または補正する。サイズ変更時は外周エッジを再計算し、拡張部分は `VOID`、エッジは `WALL` で初期化する。

### 9.3 簡易自動生成
アルゴリズム(フロアごとに実行、シード指定可)。エッジモデルでは**セルグラフ上の迷路生成**がそのまま使え、サイズの偶奇に依存しない。
1. 全セルを `FLOOR`、全エッジを `WALL` で初期化(外周を含む)。
2. **再帰バックトラック法**: 開始セルから、未訪問の隣接セルへ進みつつ、その間のエッジを `OPEN` にして通路を掘る。全セルを訪問すると、すべてのセルが連結した完全迷路になる。
3. オプション(ループ/部屋): 残った内部 `WALL` エッジをランダムに数%開ける(ループ追加)。矩形領域を選んで内部エッジをすべて開け、部屋を作る。
4. オプション(疎な配置): 一部セルを `VOID` にしてもよいが、生成後に残りのセルの連結性を BFS で確認する(Phase 1 では全セル使用を既定)。
5. 袋小路(開いているエッジが 1 本のセル)から宝箱を k 個配置(k ≈ セル数の 3%)。
6. 階段を配置: 上り階段は開始地点のセル、下り階段は BFS で最も遠いセル。
7. 生成後、BFS で全セル・宝箱・階段の到達可能性を検証。

生成は**クライアント側**で実行(サーバ負荷なし)。結果はエディタ上で手修正可能。

### 9.4 保存・公開フロー
1. エディタ画面は Access 認証後にのみ配信される(未認証は Access のログイン画面へ)。
2. 保存: `PUT /api/dungeons/:id`(`If-Match: revision`)→ JWT 検証 → バリデーション → `EDITOR_LOCK` DO へ転送 → DO が revision を検証し、R2 `DRAFT` に新 revision のフロアを書込 → manifest 更新 → revision+1 を返す。409 の場合は最新を再取得してユーザーに通知。
3. 公開: `POST /api/dungeons/:id/publish` → DO 内で公開用バリデーション → R2 `PUBLISHED` にフロアをコピー → manifest 切り替え → KV `DUNGEON_META` の一覧を更新。
4. 操作者(JWT のメール)を manifest の `updatedBy` / `publishedBy` に記録。


### 9.5 ダンジョン改訂時の既存セーブ
`PlayerSave.dungeonRevision` が現在の revision と異なる場合:
- 位置が `VOID` セル/範囲外になっていればスタート地点に戻す(エッジが変わっただけならそのまま)。
- 訪問済みビットマップはサイズ一致時のみ継承、不一致のフロアは破棄。エッジはダンジョン本体から導出するため、壁の変更はマップ表示に自動で反映される。
- 存在しない宝箱の `openedChests` は無視。


## 10. ディレクトリ構成(案)

```
dungeon/
├─ packages/shared/          # 型定義 (Floor, Dungeon, PlayerSave) と純粋ロジック
│  └─ src/                   #   エッジ計算/移動判定/階段遷移/BFS/迷路生成/バリデーション
├─ apps/
│  ├─ game/                  # Worker: dungeon-game
│  │  ├─ wrangler.jsonc
│  │  ├─ src/index.ts, api/ (dungeons.ts, save.ts)
│  │  └─ client/             # 探索画面・マップ画面 (Three.js)
│  └─ editor/                # Worker: dungeon-editor
│     ├─ wrangler.jsonc
│     ├─ src/index.ts, access.ts (JWT 検証), api/, do/DungeonEditorLock.ts
│     └─ client/             # エディタ画面、generator.ts、試遊ビュー
├─ test/                     # vitest
└─ package.json              # npm workspaces
```
既存の単一 Worker 構成(`src/`, ルートの `wrangler.jsonc`)は `apps/game` に移行する。ゲームロジックは描画非依存の純粋関数として `packages/shared` に置き、Vitest で単体テストする。デプロイは各 Worker ごとに `wrangler deploy`(`apps/game`、`apps/editor`)。

## 11. 実装ステップ(推奨順)

1. `packages/shared`: 型定義と純粋ロジック(エッジ添字計算、`canMove`、階段遷移、BFS、迷路生成、バリデーション)+ テスト。エッジの添字・外周・対称性は特にテストを厚くする
2. R2 バケット/KV 名前空間の作成、`apps/game` の API(公開版の読み取り、セーブ)
3. 3D 探索画面(固定サンプルマップ)+ アニメーション・キー入力
4. 宝箱・階段・フロア切り替え
5. 自動マッピング + マップ画面
6. `apps/editor` の骨組み + **Cloudflare Access の設定と JWT 検証**(認証が通るまで他の機能を公開しない)
7. エディタ画面(編集・サイズ指定・階段リンク)+ 自動生成
8. `DungeonEditorLock` DO による保存・公開の排他制御、公開フロー
9. セーブ/ロード統合、両 Worker のデプロイ、Access ポリシーと `workers_dev` 無効化の確認

## 12. 未決事項 / 将来拡張
- Access の IdP 選定(メール OTP / Google / GitHub など)と許可ユーザー管理方法、ロール分離(閲覧のみ / 編集 / 公開)。
- ゲーム Worker 側のレート制限(セーブ API の乱用対策、Rate Limiting / WAF ルール)。
- エッジ値の拡張: 扉(開閉・鍵)、隠し壁、一方通行の壁、エッジごとのテクスチャ(`EdgeType` の予約値を使用)。
- マルチプレイ / 共同編集(DO + WebSocket)。
- 宝箱の中身・アイテム・敵、テクスチャ/効果音。
- R2 の古い revision の自動クリーンアップ(Cron Triggers)。

## 13. 実装メモ(Phase 1 実装時の設計差分)
- **エディタの索引**: ドラフト一覧は R2 `index.json`、公開一覧は KV `dungeon:index`。いずれも更新は、固定名 `__index__` の Durable Object(`DungeonEditorLock` の別インスタンス)に集約し、別ダンジョンの保存・公開が同時に起きても読み取り→書き込みが衝突しないようにしている。
- **排他制御**: ダンジョンごとの DO が、リビジョン照合・R2 書き込み・索引更新を直列化する。リビジョンの真値は R2 の manifest(強整合)。
- **エディタ Worker の認証**: 静的アセットを含む**全リクエスト**で Worker が Access JWT を検証する(`run_worker_first: true`)。`DEV_BYPASS_EMAIL` は host が localhost のときのみ有効で、`.dev.vars` にのみ置く。
- **階段**: エディタは階段を置くと、隣接階の同座標に対の階段を自動作成する(接続先の手動指定ダイアログは未実装)。接続先を変えたい場合は撤去して置き直す。
- **エディタ未実装**: 階の並び替え、試遊ビュー(ドラフトのテストプレイ)、ロール分離。
- **本番の公開構成(workers.dev)**: 独自ドメインがないため、エディタは `workers_dev: true`、`preview_urls: false` で `workers.dev` に公開し、Workers の Access(Worker 単位、All traffic)で保護している。Worker 側の JWT 検証(多層防御)はそのまま有効。§3 の「`workers_dev: false`・カスタムドメイン」はドメインを使う場合の構成で、手順は `docs/deploy.md` の付録を参照。
