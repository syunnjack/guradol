# guradol（gravure-meikan.jp）

**リポジトリ名は guradol だが、本番は gravure-meikan.jp。**
guradol.jp は証明書が3日発行されなかったため、2026-09-03 にドメインを取り直した。

## プロジェクト概要

グラビアアイドルの名前から出演作品を引ける名鑑サイト。**本番は https://gravure-meikan.jp**。

`gravure-meikan.jp` はこのリポジトリ専用。他のリポジトリに割り当ててはいけない。

darekore.jp（`darenano` リポジトリ）と同じ方針で運用する。あちらが成人向け作品、
こちらが写真集・DVD のグラビアで、扱う出典が違うだけ。

## 掲載データの方針

- **権利者が API で公開している項目だけを載せる。** 推測・補間・独自の評価は載せない
- 実在の人物のデータなので、裏付けのない身体的特徴・所属・経歴を書かない
- ページには必ず出典（DMM.com アフィリエイト Web サービス）を明示する
- **読み仮名は API に入っていない。** 五十音索引を作らない。読みを勝手に振ると別人に行き着く
- アダルト（FANZA）作品へのリンクは置かない
- 削除依頼の窓口 `info@gravure-meikan.jp` を画面に出しておく

### 実在しない利用者を作らない

投票数・口コミ・オンライン人数・ランキングを、初期値として書き込んではいけない。
数字を置きたくなったら、その出どころが公式か実際の投稿かを先に確認する。

### データ取得

| 出典 | スクリプト | 認証情報（環境変数） |
|---|---|---|
| DMM.com アフィリエイト Web サービス | `scripts/fetch-gravure.py` | `FANZA_API_ID` / `FANZA_AFFILIATE_ID` |
| 楽天ウェブサービス（楽天市場商品検索API） | `scripts/fetch-rakuten.py` | `RAKUTEN_ICHIBA_APP_ID` / `RAKUTEN_ICHIBA_ACCESS_KEY` / `RAKUTEN_AFFILIATE_ID` |

**出典を2社にするのは、片方で取扱終了・売り切れになっても買える先を残すため。**
darekore.jp で「クリックはあるのに成果が0」だった原因は、作品単位のリンクを
出していなかったこと。単位を直したうえで、社を増やす。

楽天は `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701`。
**`app.rakuten.co.jp/services` は通らない。** BooksTotal / BooksDVD の
エンドポイントは 404 だった（2026-09-03 実測）ので、市場APIで引く。
GORA・トラベルとは**別のアプリ**なので、鍵も別（`RAKUTEN_ICHIBA_*`）。

商品名に出演者名が入っていないものは捨てる。同名の別人や無関係な商品が混ざるため。

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

https://gravure-meikan.jp

`.github/workflows/deploy.yml` により、`main` へのpush時に自動でビルド & デプロイされる。
データの取り直しは `fetch-gravure.yml`。

独自ドメインは `dist/CNAME`（ビルドが生成）と **GitHub の Settings → Pages の両方**で
設定されている必要がある。片方だけだとサイトが「Site not found」になる。

### 注意

**カスタムドメインを API から解除しないこと。** `PUT /repos/.../pages -f cname=""` を
投げると Pages サイトごと消え、サイトが 404 になる（2026-09-02 に発生）。
変更が必要なときは Web UI から行う。

## ドメインの設定

手順は [docs/domain-setup.md](docs/domain-setup.md) にある。**順番を守り、設定したら触らないこと。**

ドメインは `scripts/build-site.mjs` の `SITE_DOMAIN` 1箇所だけで決まる。
環境変数 `SITE_DOMAIN` でも指定できる。CNAME・canonical・サイトマップ・
llms.txt・OGP・構造化データ・連絡先メールはすべてここから作られるので、
個別のファイルを書き換えない。

状態の確認は `python scripts/check-domain.py` を使う。**見るだけで何も変えない。**

証明書の発行待ちに設定を触ると、GitHub 側の状態が「追加されたばかり」に
戻り、発行処理が振り出しになる。2026年9月に3日開通しなかったのはこれが原因。

## 技術スタック

- 言語: JavaScript (Node) / データ取得は Python 3
- 生成: `scripts/build-site.mjs`（静的HTML。フレームワークは使っていない）
- ランタイム: Node.js v24

### 主なコマンド

- `node scripts/build-site.mjs`: `dist/` にサイトを生成
- `python scripts/fetch-gravure.py`: 作品データの取得
- `python scripts/check-pending-reviews.py`: 未承認の口コミを一覧（要 `SUPABASE_SERVICE_ROLE`）
