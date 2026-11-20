# デプロイ手順

ゲーム用 Worker(`dungeon-game`、公開)とエディタ用 Worker(`dungeon-editor`、Cloudflare Access で保護)を Cloudflare の `workers.dev` にデプロイする手順です。
各ステップはアカウントの本番リソースを作成・変更します。

> 設定項目の名前・画面の場所は 2026-11 時点の Cloudflare ドキュメントで確認したものです。変更されている場合は最新のドキュメントを優先してください。
> 独自ドメインを使う場合は末尾の「付録: カスタムドメインを使う場合」を参照してください。

## 構成

| Worker | URL | 保護 |
|---|---|---|
| `dungeon-game` | `https://dungeon-game.<アカウントのサブドメイン>.workers.dev` | なし(公開) |
| `dungeon-editor` | `https://dungeon-editor.<アカウントのサブドメイン>.workers.dev` | Cloudflare Access(Worker 単位)+ Worker 側の JWT 検証 |

プレビュー URL(`preview_urls`)は両方とも無効です。

## 0. 前提

| 必要なもの | 備考 |
|---|---|
| Cloudflare アカウント | Workers(Durable Objects を使うため **Workers Paid** が必要になる場合があります)、R2 の購読(ダッシュボードの R2 > Overview で有効化) |
| Zero Trust(Access)の有効化 | チーム名(`<team>.cloudflareaccess.com`)が決まっていること |
| `npx wrangler login` 済み | `npx wrangler whoami` で確認 |

決める値は **Zero Trust のチーム名** だけです(例: `myteam` → `myteam.cloudflareaccess.com`)。

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

## 3. エディタの設定を確認する(workers.dev)

`apps/editor/wrangler.jsonc` は次の状態にします。

```jsonc
"workers_dev": true,     // workers.dev で公開(Access で保護する)
"preview_urls": false,   // プレビュー URL は無効のまま
"vars": {
  "ACCESS_TEAM_DOMAIN": "<チーム名>.cloudflareaccess.com",   // https:// は付けない
  "ACCESS_AUD": ""   // 手順 5 で取得して設定する
}
```

- `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` のどちらかが空の間、エディタ Worker は **全リクエストを 403** にします(fail closed)。
  先にデプロイしても無防備な状態にはなりません。
- **`DEV_BYPASS_EMAIL` は本番に設定しないでください。** `.dev.vars`(ローカル専用、git 管理外)にだけ置きます。

## 4. 最初のデプロイ(エディタ → ゲームの順)

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

本番へデプロイします。

```bash
npm run deploy:editor
npm run deploy:game
```

- 完了時に URL(`https://dungeon-editor.<サブドメイン>.workers.dev` など)が表示されます。
- 初回のエディタのデプロイでは、Durable Object のマイグレーション(`DungeonEditorLock`、SQLite バックエンド)が適用されます。
- この時点ではエディタは 403 を返します(`ACCESS_AUD` が空のため)。

## 5. エディタを Access で保護する

Worker 単位の Access は、その Worker の `workers.dev` URL を保護します。

1. Cloudflare ダッシュボード → **Workers & Pages** → `dungeon-editor` → **Access** タブ。
2. **Protect this Worker behind Access** → 対象は **All traffic** を選ぶ。
3. 認証ポリシーを設定する。**自分のメールアドレスだけを許可**してください。
   「Email domain」を選ぶとそのドメインの全員が入れます。
4. **Apply Access** で適用する。
5. Zero Trust → **Access controls → Applications** に作られたアプリを開き、**Application Audience (AUD) Tag** をコピーする。
6. `apps/editor/wrangler.jsonc` の `ACCESS_AUD` に貼り、再デプロイする。

```bash
npm run deploy:editor
```

- この設定は Access 側のオブジェクトで、`wrangler deploy` を実行しても維持されることを確認済みです。
- Worker 単位の Access は WebSocket を通しません。現在のエディタは WebSocket を使いません。使うようになった場合は、ホスト名ベースの Access アプリケーションに切り替えてください。
- 手順 6 の前の状態(`ACCESS_AUD` が空)で Access だけが有効な場合、未ログインは Access のログイン画面へ、ログイン後は Worker の 403 になります。

## 6. デプロイ後の確認

| # | 確認 | 期待する結果 |
|---|---|---|
| 1 | シークレットウィンドウでエディタの URL を開く | Access のログイン画面に遷移する(エディタは表示されない) |
| 2 | `curl -i https://dungeon-editor.<サブドメイン>.workers.dev/api/dungeons`(認証なし) | `302`(Access のログインへ)。Worker まで届いても `403` |
| 3 | 許可したアカウントでログインする | エディタの一覧画面が表示され、右上に自分のメールアドレスが出る |
| 4 | 許可していないアカウントでログインする | Access に拒否される |
| 5 | エディタでダンジョンを作成 → 保存 → 公開 | 「公開しました」と表示される |
| 6 | ゲームの URL を開く | 公開したダンジョンが一覧に出て、遊べる |
| 7 | ゲームで移動して宝箱を取り、ページを再読み込み | 位置・マップ・宝箱の回収状況が復元される |
| 8 | エディタで「公開停止」 | ゲームの一覧から消える |
| 9 | `curl -i -X PUT https://dungeon-game.<サブドメイン>.workers.dev/api/dungeons/x` | `405`(ゲーム側にマップを書き換える API はない) |
| 10 | エディタのプレビュー URL(`*-dungeon-editor.<サブドメイン>.workers.dev`)が無いこと | 生成されない(`preview_urls: false`) |

> 認証が必要な 3〜5 はログインした人だけが確認できます。`curl` で確認できるのは 2 と 9 です。

## 7. ロールバック・運用メモ

- **Worker のロールバック**: `npx wrangler rollback`(各 `apps/*` ディレクトリで実行)。データ(R2/KV)は戻りません。
- **公開を即座に止める**: エディタの「公開停止」、または KV の `dungeon:index` からエントリを削除。
- **エディタを即座に閉じる**: Access のポリシーを無効化(拒否)にする。Worker 側も JWT を検証するので二重に守られます。
- **AUD タグ**: Access アプリを削除・再作成すると変わります。変わったら `ACCESS_AUD` を更新して再デプロイしてください。
- **署名鍵のローテーション**: Access は約 6 週間ごとに鍵を更新します(旧鍵は 7 日間有効)。Worker は `kid` で鍵を選び、未知の `kid` のときは鍵一覧を再取得するため、対応は不要です。
- **R2 / KV の中身の確認**:
  ```bash
  npx wrangler r2 object get dungeon-published/dungeons/<id>/manifest.json --remote
  npx wrangler kv key get dungeon:index --binding DUNGEON_META --remote   # apps/game か apps/editor で実行
  ```
- **ローカル開発**は本番リソースに触れません(`wrangler dev` はローカルの R2/KV を使います)。

## 付録: カスタムドメインを使う場合

独自ドメイン(Cloudflare 上のアクティブなゾーン)がある場合は、次のように切り替えられます。

1. 各 `wrangler.jsonc` に `routes` を追加する(DNS レコードと証明書は自動作成されます。ワイルドカード不可、同じホスト名の既存 CNAME は先に削除)。
   ```jsonc
   "routes": [{ "pattern": "play.example.com", "custom_domain": true }]     // apps/game
   "routes": [{ "pattern": "editor.example.com", "custom_domain": true }]   // apps/editor
   ```
2. エディタは `workers_dev: false` に戻す。この場合は、Worker 単位の Access ではなく、Zero Trust → Access controls → Applications → **Self-hosted and private** で、`editor.example.com` を対象にしたアプリを作成する(ポリシーは許可するユーザーだけを Allow)。
3. そのアプリの AUD タグを `ACCESS_AUD` に設定して再デプロイする。
4. `workers.dev` 側に到達できないことを確認する。設定ファイルの値が優先されるため、ダッシュボードで変えても次のデプロイで戻ります。

## 参考(ドキュメント)

- Workers の Cloudflare Access: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Access アプリケーション: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Access JWT の検証: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- カスタムドメイン: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- workers.dev: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Wrangler 設定(assets など): https://developers.cloudflare.com/workers/wrangler/configuration/
