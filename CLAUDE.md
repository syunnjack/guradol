# guradol（guradol.jp）

## プロジェクト概要

グラビアアイドルの名前から出演作品を引ける名鑑サイト。**本番は https://guradol.jp**。

`guradol.jp` はこのリポジトリ専用。他のリポジトリに割り当ててはいけない。

darekore.jp（`darenano` リポジトリ）と同じ方針で運用する。あちらが成人向け作品、
こちらが写真集・DVD のグラビアで、扱う出典が違うだけ。

## 掲載データの方針

- **権利者が API で公開している項目だけを載せる。** 推測・補間・独自の評価は載せない
- 実在の人物のデータなので、裏付けのない身体的特徴・所属・経歴を書かない
- ページには必ず出典（DMM.com アフィリエイト Web サービス）を明示する
- **読み仮名は API に入っていない。** 五十音索引を作らない。読みを勝手に振ると別人に行き着く
- アダルト（FANZA）作品へのリンクは置かない
- 削除依頼の窓口 `info@guradol.jp` を画面に出しておく

### 実在しない利用者を作らない

投票数・口コミ・オンライン人数・ランキングを、初期値として書き込んではいけない。
数字を置きたくなったら、その出どころが公式か実際の投稿かを先に確認する。

### データ取得

| 出典 | スクリプト | 認証情報（環境変数） |
|---|---|---|
| DMM.com アフィリエイト Web サービス | `scripts/fetch-gravure.py` | `DMM_API_ID` / `DMM_AFFILIATE_ID` |

**キーはリポジトリに書かない。** GitHub Secrets に入れ、環境変数で渡す。

## 検索とAIへの出し方

- `robots.txt` は生成AIのクローラー（GPTBot / ClaudeBot / PerplexityBot など）を名指しで許可する。
  載せているのは API が公開している項目だけで、隠す理由がない
- `llms.txt` に、載せているもの・載せていないもの・**数え方の制約**を書く。
  作品数は商品件数であって出演本数ではない、といった但し書きをここに集約する
- 構造化データは `scripts/build-site.mjs` が出す。
  トップは `WebSite` + `SearchAction` + `Dataset`、一覧は `CollectionPage` + `BreadcrumbList`、
  出演者ページは `Person` + `BreadcrumbList`
- **出典に無い属性を構造化データに書かない。** 生年月日や身長を schema.org の項目として
  埋めたくなるが、データが無いので書けない
- 増えたURLは `indexnow.yml` が IndexNow へ通知する。送信済みは `data/indexnow-sent.txt` に記録し、
  同じURLを送り直さない。鍵ファイルはビルドが `dist/<key>.txt` に出す。
  ワークフローの `INDEXNOW_KEY` と必ず同じ値にすること

## 投票と口コミ（UGC）

- 保存先は Supabase。匿名キーは公開してよい値で、守りはデータベース側の RLS
- **口コミは必ず `pending` で入る。** 承認しない限り表示されない。
  実在の人物についての書き込みなので、公開前に運営が読む
- `pending-reviews.yml` が毎日 09:00 JST に未承認を調べ、あれば Issue を立てる。
  確認したら Issue を閉じる。開いたままだと次の通知が出ない
- 承認・却下は Supabase の SQL Editor で行う。手順は Issue 本文に出る

## デプロイ先

https://guradol.jp

`.github/workflows/deploy.yml` により、`main` へのpush時に自動でビルド & デプロイされる。
データの取り直しは `fetch-gravure.yml`。

独自ドメインは `dist/CNAME`（ビルドが生成）と **GitHub の Settings → Pages の両方**で
設定されている必要がある。片方だけだとサイトが「Site not found」になる。

### 注意

**カスタムドメインを API から解除しないこと。** `PUT /repos/.../pages -f cname=""` を
投げると Pages サイトごと消え、サイトが 404 になる（2026-09-02 に発生）。
変更が必要なときは Web UI から行う。

## 技術スタック

- 言語: JavaScript (Node) / データ取得は Python 3
- 生成: `scripts/build-site.mjs`（静的HTML。フレームワークは使っていない）
- ランタイム: Node.js v24

### 主なコマンド

- `node scripts/build-site.mjs`: `dist/` にサイトを生成
- `python scripts/fetch-gravure.py`: 作品データの取得
- `python scripts/check-pending-reviews.py`: 未承認の口コミを一覧（要 `SUPABASE_SERVICE_ROLE`）
