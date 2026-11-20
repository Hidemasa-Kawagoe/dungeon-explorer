# デプロイ手順

ゲーム用 Worker(`dungeon-game`、公開)とエディタ用 Worker(`dungeon-editor`、Cloudflare Access で保護)を Cloudflare にデプロイする手順です。
各ステップはアカウントの本番リソースを作成・変更します。**実行前に値(ドメイン名、チーム名)を決めてから**進めてください。

> 設定項目の名前・画面の場所は 2026-11 時点の Cloudflare ドキュメントで確認したものです。変更されている場合は最新のドキュメントを優先してください。

## 0. 前提

| 必要なもの | 備考 |
|---|---|
| Cloudflare アカウント | Workers(Durable Objects を使うため **Workers Paid** プランが必要になる場合があります。料金ページで確認)、R2 の購読(ダッシュボードの R2 > Overview で有効化) |
| Cloudflare に載っているドメイン(ゾーン) | カスタムドメインは「自分が所有するアクティブなゾーン」にのみ作成できます。対象ホスト名に既存の CNAME があってはいけません |
| Zero Trust(Access)の有効化 | チーム名(`<team>.cloudflareaccess.com`)が決まっていること |
| `npx wrangler login` 済み | `npx wrangler whoami` で確認 |

決める値:

| 値 | 例 |
|---|---|
| ゲームのホスト名 | `play.example.com` |
| エディタのホスト名 | `editor.example.com` |
| Zero Trust チーム名 | `myteam` → チームドメイン `myteam.cloudflareaccess.com` |

## 1. リソースを作成する(R2)

```bash
npx wrangler r2 bucket create dungeon-draft
npx wrangler r2 bucket create dungeon-published
npx wrangler r2 bucket list
```

- `dungeon-draft` はエディタだけにバインドします(ゲームには付けません)。
- バケット名は `apps/*/wrangler.jsonc` の `bucket_name` と一致させてください。

## 2. リソースを作成する(KV)— 重要: id を 2 つの Worker で揃える

```bash
npx wrangler kv namespace create DUNGEON_META
npx wrangler kv namespace create PLAYER_SAVE
```

出力された `id` を設定ファイルに書きます。

| ファイル | バインディング | 設定する id |
|---|---|---|
| `apps/game/wrangler.jsonc` | `DUNGEON_META` | 作成した `DUNGEON_META` の id |
| `apps/game/wrangler.jsonc` | `PLAYER_SAVE` | 作成した `PLAYER_SAVE` の id |
| `apps/editor/wrangler.jsonc` | `DUNGEON_META` | **game と同じ** `DUNGEON_META` の id |

```jsonc
{ "binding": "DUNGEON_META", "id": "<作成した id>" }
```

> **注意**: id を書かずにデプロイすると、wrangler が Worker ごとに別の名前空間を自動作成します。
> そうなるとエディタで公開した一覧がゲームから見えません。必ず同じ id を指定してください。
> (R2 は名前で共有されるので、この問題は起きません。)

## 3. カスタムドメインを設定する

各 `wrangler.jsonc` に `routes` を追加します(`custom_domain: true` の場合、DNS レコードと証明書は自動作成されます)。

```jsonc
// apps/game/wrangler.jsonc
"routes": [{ "pattern": "play.example.com", "custom_domain": true }]

// apps/editor/wrangler.jsonc
"routes": [{ "pattern": "editor.example.com", "custom_domain": true }]
```

- ワイルドカードは使えません(ホスト名の完全一致)。
- 同じホスト名に CNAME が既にある場合は、先に削除してください。

## 4. エディタを **Access で保護してから** 公開する(順序が重要)

エディタ Worker は、Access の設定が空のまま(`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` が空)だと **全リクエストを 403** にします(fail closed)。
そのため、先にデプロイしても公開状態にはなりませんが、次の順で進めるのが確実です。

### 4-1. Access アプリケーションを作成
Zero Trust ダッシュボード → **Access controls → Applications → Create new application → Self-hosted and private**。

- **Add public hostname**: `editor.example.com`(Domain はドロップダウンから選択)
- **Access policies**: 許可するユーザーだけを **Allow** で指定(例: 自分のメールアドレス、チームのメールドメイン)。Access は既定で拒否のため、Allow に一致しないユーザーは入れません。
- **Identity providers**: 使用する IdP を選択(One-time PIN なら登録不要で使えます)。
- **Create** で作成。

### 4-2. AUD タグとチームドメインを控える
- AUD タグ: 作成したアプリを **Edit → Additional settings → Application Audience (AUD) Tag** からコピー。
- チームドメイン: `<チーム名>.cloudflareaccess.com`(Zero Trust の設定で確認)。

### 4-3. 値を設定
AUD タグとチームドメインは秘密情報ではありませんが、環境ごとに異なるため、`apps/editor/wrangler.jsonc` の `vars` に書きます。

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "myteam.cloudflareaccess.com",   // https:// は付けない
  "ACCESS_AUD": "<AUD タグ>"
}
```

> **`DEV_BYPASS_EMAIL` は本番に設定しないでください。** `.dev.vars`(ローカル専用、git 管理外)にだけ置きます。
> 万一設定されていても host が localhost のリクエストにしか効きませんが、不要な変数は置かない方針です。

## 5. デプロイ

デプロイ前に、テストと型チェックを通します。

```bash
npm test
npm run typecheck -w @dungeon/game -w @dungeon/editor -w @dungeon/shared
```

ビルドの確認(本番には何も変更しません):

```bash
cd apps/game   && npm run build:client && npx wrangler deploy --dry-run
cd ../editor   && npm run build:client && npx wrangler deploy --dry-run
```

本番へデプロイ(**エディタ → ゲームの順**を推奨。どちらもクライアントのビルドを含みます):

```bash
npm run deploy:editor
npm run deploy:game
```

初回のエディタのデプロイでは、Durable Object のマイグレーション(`DungeonEditorLock`、SQLite バックエンド)が適用されます。

## 6. デプロイ後の確認

| # | 確認 | 期待する結果 |
|---|---|---|
| 1 | シークレットウィンドウで `https://editor.example.com/` を開く | Access のログイン画面に遷移する(エディタは表示されない) |
| 2 | 許可したアカウントでログインする | エディタの一覧画面が表示され、右上に自分のメールアドレスが出る |
| 3 | 許可していないアカウントでログインする | Access に拒否される |
| 4 | `curl -i https://editor.example.com/api/dungeons`(ヘッダなし) | `302`(Access のログインへ)。Worker まで届いても `403` |
| 5 | `https://dungeon-editor.<サブドメイン>.workers.dev/` を開く | 到達できない(`workers_dev: false`)。バージョン URL も生成されない |
| 6 | エディタでダンジョンを作成 → 保存 → 公開 | 「公開しました」と表示される |
| 7 | `https://play.example.com/` を開く | 公開したダンジョンが一覧に出て、遊べる |
| 8 | ゲームで移動して宝箱を取り、ページを再読み込み | 位置・マップ・宝箱の回収状況が復元される |
| 9 | エディタで「公開停止」 | ゲームの一覧から消える |
| 10 | `curl -i -X PUT https://play.example.com/api/dungeons/x` | `405`(ゲーム側にマップを書き換える API はない) |

5 で到達できてしまう場合は、`apps/editor/wrangler.jsonc` に `"workers_dev": false` と `"preview_urls": false` があることを確認し、再デプロイしてください。
ダッシュボードで設定を変えても、次回の `wrangler deploy` で設定ファイルの値に戻ります。

## 7. ロールバック・運用メモ

- **Worker のロールバック**: `npx wrangler rollback`(各 `apps/*` ディレクトリで実行)。データ(R2/KV)は戻りません。
- **公開を即座に止める**: エディタの「公開停止」、または KV の `dungeon:index` からエントリを削除。
- **エディタを即座に閉じる**: Access のポリシーを無効化(拒否)にする。Worker 側も JWT を検証するので二重に守られます。
- **AUD タグ**: アプリを削除・再作成すると変わります。変わったら `ACCESS_AUD` を更新して再デプロイしてください。
- **署名鍵のローテーション**: Access は約 6 週間ごとに鍵を更新します(旧鍵は 7 日間有効)。Worker は `kid` で鍵を選び、未知の `kid` のときは鍵一覧を再取得するため、対応は不要です。
- **R2 / KV の中身の確認**:
  ```bash
  npx wrangler r2 object get dungeon-published/dungeons/<id>/manifest.json --remote
  npx wrangler kv key get dungeon:index --binding DUNGEON_META --remote   # apps/game か apps/editor で実行
  ```
- **ローカル開発**は本番リソースに触れません(`wrangler dev` はローカルの R2/KV を使います)。

## 8. 参考(ドキュメント)

- Access アプリケーション: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Access JWT の検証: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- カスタムドメイン: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- workers.dev の無効化: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Wrangler 設定(assets など): https://developers.cloudflare.com/workers/wrangler/configuration/
