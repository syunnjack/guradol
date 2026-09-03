// グラビアの作品データから、出演者ページ・分類別・メーカー別・索引を作る。
//
// 方針（darekore.jp と同じ）:
//   - 権利者が API で公開している項目だけを載せる。推測や補完はしない
//   - **読み仮名は API に入っていない**ので、五十音索引は作らない。
//     読みを勝手に振ると間違った人に行き着くため
//   - アダルト（FANZA）のリンクは置かない
//
// 使い方: node scripts/build-site.mjs

import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dataDir = path.join(root, 'data')
const outDir = path.join(root, 'dist')

// ドメインはここ1箇所だけで決める。CNAME・canonical・サイトマップ・
// llms.txt・OGP・構造化データは、すべてこの値から作られる。
// 引っ越すときは SITE_DOMAIN を変えるだけでよい。個別に書き換えない。
// guradol.jp は証明書が3日発行されず、原因が「待てずに設定を変え続けたこと」
// だったため、ドメインを取り直した（2026-09-03）。**リポジトリ名は guradol のまま。**
const SITE_DOMAIN = process.env.SITE_DOMAIN || 'gravure-meikan.jp'
const SITE_URL = `https://${SITE_DOMAIN}`
// ドメイン（gravure-meikan）と揃える。インデックスが1件も無いうちに決めた。
const SITE_NAME = 'グラビア名鑑'
const CONTACT = process.env.SITE_CONTACT || `info@${SITE_DOMAIN}`

// Search Console の所有権確認。公開してよい値なので直接書く。
// Search Console の所有確認。**ドメインごとに違う。**
// guradol.jp のものは gravure-meikan.jp では通らない。
const SITE_VERIFICATION = process.env.SITE_VERIFICATION || '_yH97rSgvjN81riHsBdT8lZmVLwkcImdDGsL68tD3G8'

// 投票と口コミの保存先。匿名キーは公開してよい値で、守りはデータベース側の RLS。
// 未設定のときは、投稿欄そのものを出さずにページを作る。
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

// 1ページに並べる人数（一覧のページ送り）
const PER_PAGE = 200
// 分類ページを作る下限。これ未満はページにしない（中身が薄くなるため）
const GENRE_MIN_PEOPLE = 5
// メーカーページを作る下限
const MAKER_MIN_WORKS = 20

// 分類のうち、ページにしないもの。商品の売り方であって内容ではない。
const SKIP_GENRES = new Set([
  'サンプル動画', '特典付きグラビア商品', 'セット商品', '予約商品', 'ベスト・総集編',
  '独占配信', 'ハイビジョン', '期間限定セール', 'その他',
])

// 売り方・形態の分類。**ページは残す**（すでに公開して検索に載っているため。
// 出典から消えたわけでもないのに URL を落とさない）が、
// 「同じ分類に出ている方」の手がかりには使わない。
// 「DMMブックス限定特典付きの作品に出ている方」では、読む人に何も伝わらない。
const WEAK_GENRES = new Set([
  '独占販売', 'ディスクオンデマンド', 'グラビアセール', 'おすすめ商品', 'アウトレット',
  '先行販売', 'DMMブックス限定特典付き', '抽選特典付き', 'デジタル特装版', '通常版',
  'Blu-ray（ブルーレイ）', '3D', '2020年代前半（DOD）', 'アイドルグッズ',
])

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function slugify(name) {
  // URL に使えない文字と、Windows のファイル名に使えない文字を落とす。
  // 「瑚桃きらり（MORE*）」のように * を含む名前があり、手元のビルドが落ちた。
  const slug = String(name ?? '').trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/?#%&=+*:"<>|]/g, '')
    .replace(/\.+$/, '')
  return slug || 'unknown'
}

function jpDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || '')
    ? iso.replace(/^(\d+)-(\d+)-(\d+)$/, (_m, y, m, d) => `${Number(y)}年${Number(m)}月${Number(d)}日`)
    : ''
}

function readJson(file) {
  return readFile(file, 'utf8').then(JSON.parse)
}

function jpMonth(iso) {
  return /^\d{4}-\d{2}/.test(iso || '')
    ? iso.replace(/^(\d+)-(\d+).*$/, (_m, y, m) => `${Number(y)}年${Number(m)}月`)
    : ''
}

/**
 * 出演者ごとに、**数えられることだけ**をまとめる。
 *
 * `w` は新しい順に最大 8 件しか持っていない（fetch-gravure.py の WORKS_PER_ACTOR）。
 * だから `n === w.length` のときだけ、内訳と発売時期を「その方の全部」として書く。
 * 足りないときに全体の話をすると、8件ぶんの事実を全体のことのように書いてしまう。
 * いま 9,608 人のうち 8,305 人は 8 件以下なので、ほとんどのページで全部そろっている。
 */
function actorFacts(person) {
  const works = person.w ?? []
  const dates = works.map((work) => work.d).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  const newest = dates[dates.length - 1] || ''
  // 手元の w だけで、その方の作品を全部並べられているか。作品数の但し書きに使う。
  const showsAll = works.length > 0 && person.n === works.length

  // 取得のときに全部を数えてある（kn / f / y）なら、8件しか持っていない人でも
  // 発売時期と内訳を書ける。fetch-gravure.py を新しくしてから取り直したデータ。
  if (person.kn && Object.keys(person.kn).length) {
    return {
      complete: true,
      showsAll,
      oldest: person.f || '',
      newest,
      kinds: Object.entries(person.kn).sort((a, b) => b[1] - a[1]),
      years: Object.entries(person.y ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
    }
  }

  // 古いデータのとき。w が n 件すべてなら、そこから数えてよい。
  const kinds = {}
  const years = new Map()

  if (showsAll) {
    for (const work of works) {
      kinds[work.k] = (kinds[work.k] ?? 0) + 1
      if (/^\d{4}/.test(work.d || '')) {
        const year = work.d.slice(0, 4)
        years.set(year, (years.get(year) ?? 0) + 1)
      }
    }
  }

  return {
    complete: showsAll,
    showsAll,
    oldest: showsAll ? dates[0] || '' : '',
    newest,
    kinds: Object.entries(kinds).sort((a, b) => b[1] - a[1]),
    years: [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  }
}

/** 事実だけの表。順位は同じ件数の人をまとめて同順位にする。 */
function renderFacts(person, facts, rank) {
  const rows = []
  const kindText = facts.kinds.length === 1
    ? `（${KIND_LABEL[facts.kinds[0][0]] || facts.kinds[0][0]}）`
    : facts.kinds.length
      ? `（${facts.kinds.map(([kind, count]) => `${KIND_LABEL[kind] || kind}${count}件`).join('・')}）`
      : ''

  rows.push(['収録作品数', `${person.n.toLocaleString('ja-JP')}件${kindText}`])

  if (facts.complete && facts.oldest && facts.newest) {
    rows.push(['発売時期', facts.oldest.slice(0, 7) === facts.newest.slice(0, 7)
      ? jpMonth(facts.newest)
      : `${jpMonth(facts.oldest)} 〜 ${jpMonth(facts.newest)}`])
  } else if (facts.newest) {
    rows.push(['いちばん新しい作品', jpMonth(facts.newest)])
  }

  if (facts.years.length > 1) {
    rows.push(['発売年の内訳', facts.years.map(([year, count]) => `${Number(year)}年 ${count}件`).join('／')])
  }

  if (rank) {
    rows.push(['作品数の順位', `${rank.total.toLocaleString('ja-JP')}人中 ${rank.place.toLocaleString('ja-JP')}位`
      + (rank.tied > 1 ? `（同じ${person.n.toLocaleString('ja-JP')}件の方が${rank.tied.toLocaleString('ja-JP')}人）` : '')])
  }

  return `<dl class="facts">${rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('')}</dl>`
}


const KIND_LABEL = { photo: '写真集', dvd: 'DVD' }

/** 作品を表紙つきで並べる。リンク先は作品ページ、画像は権利者が返したURL。 */
function renderWorks(works) {
  if (!works?.length) return ''

  const items = works.map((work) => {
    const cover = work.i
      ? `<img src="${escapeHtml(work.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="142" />`
      : '<span class="no-cover"></span>'

    return `<li class="work"><a href="${escapeHtml(work.u)}" target="_blank" rel="nofollow sponsored noopener">`
      + cover
      + `<span class="work-title">${escapeHtml(work.t)}</span>`
      + `<span class="work-meta">${escapeHtml(KIND_LABEL[work.k] || '')}${work.d ? `／${escapeHtml(jpDate(work.d))}` : ''}</span>`
      + '</a></li>'
  }).join('')

  return `<ul class="work-list">${items}</ul>`
}

function shell({ title, description, canonical, crumbs, body, noindex, script, schema }) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="google-site-verification" content="${SITE_VERIFICATION}" />
    ${noindex ? '<meta name="robots" content="noindex,follow" />\n    ' : ''}<link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="ja_JP" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${canonical}" />
    <link rel="stylesheet" href="/assets/page.css" />
    ${script ? `<script defer src="${script}"></script>` : ''}
    ${schema ? `<script type="application/ld+json">${jsonLd(schema)}</script>` : ''}
  </head>
  <body>
    <div class="wrap">
      <header class="site-head"><a class="site-name" href="/">${escapeHtml(SITE_NAME)}</a></header>
      <nav class="crumbs"><a href="/">${escapeHtml(SITE_NAME)}</a>${crumbs ? ` ＞ ${crumbs}` : ''}</nav>
      ${body}
      <footer>
        <p>掲載内容の訂正・削除のご依頼は <a href="mailto:${CONTACT}">${CONTACT}</a> へご連絡ください。確認のうえ対応します。</p>
        <nav class="site-nav">
          <a href="/">トップ</a>
          <a href="/idol/">出演者一覧</a>
          <a href="/genre/">分類別</a>
          <a href="/maker/">メーカー別</a>
          <a href="/ranking/">投票ランキング</a>
          <a href="/about/">このサイトについて</a>
        </nav>
        <p class="credit">作品データの出典: <a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">DMM.com アフィリエイト Web サービス</a></p>
      </footer>
    </div>
  </body>
</html>
`
}

/**
 * 楽天市場の商品。**DMM と並ぶ2社目の出典。**
 *
 * 出典が1社だけだと、その社で取扱終了・売り切れになった時点で
 * そのページから買える先が消える。2社あれば片方が残る。
 *
 * リンクは楽天が返した `affiliateUrl` をそのまま使う。組み替えない。
 */
function renderRakutenWorks(works) {
  if (!works?.length) return ''

  const items = works.map((work) => {
    const cover = work.i
      ? `<img src="${escapeHtml(work.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="142" />`
      : '<span class="no-cover"></span>'
    const price = work.p ? `／${Number(work.p).toLocaleString('ja-JP')}円` : ''

    return `<li class="work"><a href="${escapeHtml(work.u)}" target="_blank" rel="nofollow sponsored noopener">`
      + cover
      + `<span class="work-title">${escapeHtml(work.t)}</span>`
      + `<span class="work-meta">${escapeHtml(work.s || '楽天市場')}${escapeHtml(price)}</span>`
      + '</a></li>'
  }).join('')

  return `<ul class="work-list">${items}</ul>`
}

function renderIdol(person, { related, relatedGenre, sameYear, year, yearsCounted, rank }) {
  const canonical = `${SITE_URL}/idol/${encodeURIComponent(person.slug)}/`
  const genres = Object.entries(person.g ?? {})
    .sort((a, b) => b[1] - a[1])
    .filter(([name]) => !SKIP_GENRES.has(name))
    .slice(0, 8)

  const facts = actorFacts(person)

  // 説明文もデータから作る。9,601ページが同じ文面だと、どのページも中身が無いのと同じ。
  const kindText = facts.kinds.length === 1
    ? `（${KIND_LABEL[facts.kinds[0][0]] || facts.kinds[0][0]}）`
    : facts.kinds.length
      ? `（${facts.kinds.map(([kind, count]) => `${KIND_LABEL[kind] || kind}${count}件`).join('・')}）`
      : ''
  const periodText = facts.complete && facts.oldest && facts.newest
    ? (facts.oldest.slice(0, 7) === facts.newest.slice(0, 7)
        ? `${jpMonth(facts.newest)}の作品です。`
        : `${jpMonth(facts.oldest)}から${jpMonth(facts.newest)}までの作品です。`)
    : (facts.newest ? `いちばん新しい作品は${jpMonth(facts.newest)}です。` : '')

  const description = `${person.name}さんの出演作品${person.n.toLocaleString('ja-JP')}件${kindText}を、`
    + `DMM.com が公開しているデータからまとめています。`
    + periodText
    + (genres.length ? `分類は${genres.slice(0, 3).map(([n]) => n).join('・')}など。` : '')

  const genreHtml = genres.length
    ? `<section class="related"><h2>この方の作品の分類</h2><div class="chips">${genres
        .map(([name, count]) => `<a href="/genre/${encodeURIComponent(slugify(name))}/">${escapeHtml(name)}<span class="count">${count}</span></a>`)
        .join('')}</div></section>`
    : ''

  const relatedHtml = related.length
    ? `<section class="related"><h2>${escapeHtml(relatedGenre ? `${relatedGenre}の作品に出ている方` : '同じ分類に出ている方')}</h2><div class="chips">${related
        .map((r) => `<a href="/idol/${encodeURIComponent(r.slug)}/">${escapeHtml(r.name)}</a>`)
        .join('')}</div></section>`
    : ''

  const sameYearHtml = sameYear?.length
    ? `<section class="related"><h2>${escapeHtml(`${Number(year)}年に発売された作品がある方`)}</h2><div class="chips">${sameYear
        .map((r) => `<a href="/idol/${encodeURIComponent(r.slug)}/">${escapeHtml(r.name)}</a>`)
        .join('')}</div>
      ${yearsCounted ? '' : '<p class="note">手元に持っている作品の発売日で数えています。この年にほかの作品が無かったとは限りません。</p>'}</section>`
    : ''

  return shell({
    title: `${person.name}の出演作品｜${SITE_NAME}`,
    description,
    canonical,
    crumbs: `<a href="/idol/">出演者一覧</a> ＞ ${escapeHtml(person.name)}`,
    script: '/assets/ugc.js',
    body: `
      <h1>${escapeHtml(person.name)}</h1>
      <p class="lead">${escapeHtml(description)}</p>
      ${renderFacts(person, facts, rank)}
      <section class="work-block">
        <h2>出演作品<span class="pr">広告</span></h2>
        ${renderWorks(person.w)}
        <p class="note">${facts.showsAll
          ? `DMM.com に収録されている ${person.n.toLocaleString('ja-JP')} 件すべてです。`
          : `DMM.com に収録されている ${person.n.toLocaleString('ja-JP')} 件のうち、新しい ${person.w.length} 件です。`}</p>
      </section>
      ${person.rakuten?.w?.length
        ? `<section class="work-block">
        <h2>楽天市場で買えるもの<span class="pr">広告</span></h2>
        ${renderRakutenWorks(person.rakuten.w)}
        <p class="note">商品名にお名前が入っているものだけを載せています。同名の別の方の商品が混ざるのを避けるためです。</p>
      </section>`
        : ''}
      ${genreHtml}
      <section id="ugc" class="ugc"
               data-slug="${escapeHtml(person.slug)}"
               data-api="${escapeHtml(SUPABASE_URL)}"
               data-key="${escapeHtml(SUPABASE_ANON_KEY)}"></section>
      ${relatedHtml}
      ${sameYearHtml}
      <section class="source-block">
        <h2>出典</h2>
        <ul class="sources"><li><a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">DMM.com アフィリエイト Web サービス</a>（出演者ID ${escapeHtml(person.id)}）</li>${
          person.rakuten?.w?.length
            ? '<li><a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener">楽天ウェブサービス（楽天市場商品検索API）</a></li>'
            : ''
        }</ul>
        <p class="note">写真集・DVD の商品情報をそのまま数えたものです。プロフィール（生年月日・身長など）は出典が無いため載せていません。</p>
      </section>
      <script type="application/ld+json">${jsonLd({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Person',
            name: person.name,
            url: canonical,
            mainEntityOfPage: canonical,
            // 出典に無い属性は書かない。数えられるのは作品数だけ。
            subjectOf: { '@type': 'CreativeWorkSeries', name: `${person.name}の出演作品`, numberOfItems: person.n },
          },
          {
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
              { '@type': 'ListItem', position: 2, name: '出演者一覧', item: `${SITE_URL}/idol/` },
              { '@type': 'ListItem', position: 3, name: person.name, item: canonical },
            ],
          },
        ],
      })}</script>`,
  })
}

function renderList({ title, heading, lead, canonical, crumbs, rows, pager, breadcrumb }) {
  const list = rows
    .map((row) => `<li><a href="${escapeHtml(row.href)}">${escapeHtml(row.name)}</a><span class="count">${row.count.toLocaleString('ja-JP')}件</span></li>`)
    .join('')

  const trail = [{ name: SITE_NAME, item: `${SITE_URL}/` }, ...(breadcrumb ?? []), { name: heading, item: canonical }]

  return shell({
    title,
    description: lead,
    canonical,
    crumbs,
    schema: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: title,
          description: lead,
          url: canonical,
          isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/` },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: trail.map((t, n) => ({ '@type': 'ListItem', position: n + 1, name: t.name, item: t.item })),
        },
      ],
    },
    body: `
      <h1>${escapeHtml(heading)}</h1>
      <p class="lead">${escapeHtml(lead)}</p>
      <ul class="name-list">${list}</ul>
      ${pager ?? ''}`,
  })
}

const PAGE_CSS = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin:0; font-family:"Hiragino Sans","Yu Gothic",system-ui,sans-serif; color:#1b1f2a; background:#f7f8fb; line-height:1.7; }
body, .name-list a, .chips a { overflow-wrap:anywhere; }
img { max-width:100%; height:auto; }
.wrap { max-width:820px; margin:0 auto; padding:24px 20px 64px; }
.site-head { padding:14px 0 12px; border-bottom:1px solid #e2e6ef; margin-bottom:16px; }
.site-head .site-name { font-size:clamp(19px,4vw,24px); font-weight:800; text-decoration:none; color:#2b4d7e; }
.crumbs { font-size:14px; color:#6b7280; margin-bottom:18px; }
.crumbs a { color:#2b6cb0; text-decoration:none; }
h1 { font-size:clamp(24px,5vw,34px); margin:0 0 8px; }
h2 { font-size:18px; margin:30px 0 10px; display:flex; align-items:center; gap:8px; }
.lead { color:#4b5563; font-size:15px; margin:0 0 20px; }
.note { font-size:13px; color:#6b7280; }
.pr { font-size:11px; color:#6b7280; border:1px solid #d6dbe5; border-radius:4px; padding:1px 6px; font-weight:400; }
.work-list { list-style:none; padding:0; margin:12px 0 8px; display:grid; grid-template-columns:repeat(auto-fill,minmax(116px,1fr)); gap:18px 12px; }
.work a { display:block; color:#1b1f2a; text-decoration:none; }
.work img, .work .no-cover { display:block; width:100%; aspect-ratio:100/142; object-fit:cover; border-radius:6px; border:1px solid #e2e6ef; background:#fff; }
.work-title { display:-webkit-box; -webkit-line-clamp:3; line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; font-size:12px; line-height:1.45; margin-top:6px; }
.work-meta { display:block; font-size:11px; color:#6b7280; margin-top:3px; }
.work a:hover .work-title { color:#2b6cb0; text-decoration:underline; }
.name-list { list-style:none; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:0 16px; }
.name-list li { display:flex; align-items:baseline; gap:8px; padding:7px 0; border-bottom:1px solid #eceff5; font-size:15px; }
.name-list a { color:#1b1f2a; text-decoration:none; }
.name-list a:hover { color:#2b6cb0; text-decoration:underline; }
.count { font-size:12px; color:#6b7280; margin-left:auto; }
.chips { display:flex; flex-wrap:wrap; gap:8px; }
.chips a { display:inline-flex; align-items:center; gap:6px; color:#2b6cb0; text-decoration:none; font-size:13px; border:1px solid #e2e6ef; border-radius:18px; padding:5px 12px; background:#fff; }
.chips a:hover { border-color:#2b6cb0; }
.facts { display:grid; grid-template-columns:max-content 1fr; margin:0 0 24px; border-top:1px solid #e2e6ef; font-size:14px; }
.facts dt { padding:9px 18px 9px 0; color:#6b7280; border-bottom:1px solid #eceff5; }
.facts dd { padding:9px 0; margin:0; border-bottom:1px solid #eceff5; }
@media (max-width:520px) { .facts { grid-template-columns:1fr; } .facts dt { padding-bottom:0; border-bottom:0; font-size:13px; } }
.related, .source-block { margin-top:30px; border-top:1px solid #e2e6ef; padding-top:8px; }
.sources { padding-left:1.2em; font-size:14px; color:#4b5563; margin:8px 0; }
.sources a { color:#2b6cb0; }
.pager { display:flex; gap:8px; flex-wrap:wrap; margin:22px 0 0; }
.pager a, .pager span { border:1px solid #e2e6ef; border-radius:8px; padding:6px 12px; text-decoration:none; color:#2b6cb0; background:#fff; font-size:14px; }
.pager .current { background:#2b4d7e; color:#fff; border-color:#2b4d7e; }
.search { width:100%; font:inherit; padding:12px 14px; border:1px solid #d6dbe5; border-radius:10px; background:#fff; color:inherit; }
#hits { list-style:none; padding:0; margin:12px 0 0; }
#hits li { padding:7px 0; border-bottom:1px solid #eceff5; }
#hits a { color:#1b1f2a; text-decoration:none; }
.ugc { margin-top:32px; border-top:1px solid #e2e6ef; padding-top:8px; }
.vote-box { display:flex; align-items:center; gap:12px; margin:12px 0 4px; flex-wrap:wrap; }
.vote { background:#2b4d7e; color:#fff; border:0; border-radius:8px; padding:10px 20px; font-size:15px; font-weight:700; cursor:pointer; }
.vote[disabled] { background:#b7bdc9; cursor:default; }
.vote-count { font-size:15px; color:#4b5563; }
.reviews { list-style:none; padding:0; margin:10px 0; }
.reviews li { background:#fff; border:1px solid #e2e6ef; border-radius:10px; padding:12px 14px; margin-bottom:10px; }
.review-body { margin:0 0 6px; font-size:15px; white-space:pre-wrap; }
.review-meta { margin:0; font-size:12px; color:#6b7280; }
.review-form { display:flex; flex-direction:column; gap:6px; margin-top:16px; }
.review-form label { font-size:13px; color:#4b5563; }
.review-form input, .review-form textarea { font:inherit; padding:10px 12px; border:1px solid #d6dbe5; border-radius:8px; background:#fff; color:inherit; }
.review-form .button { align-self:flex-start; border:0; cursor:pointer; background:#2b4d7e; color:#fff; border-radius:8px; padding:10px 20px; font-weight:700; }
.rank-list { list-style:none; padding:0; margin:0; counter-reset:rank; }
.rank-list li { display:flex; align-items:baseline; gap:10px; padding:8px 0; border-bottom:1px solid #eceff5; font-size:15px; }
.rank-list li::before { counter-increment:rank; content:counter(rank); min-width:2.2em; color:#6b7280; font-size:13px; }
.rank-list a { color:#1b1f2a; text-decoration:none; }
.rank-list a:hover { color:#2b6cb0; text-decoration:underline; }
.rank-count { font-size:13px; color:#6b7280; margin-left:auto; }
footer { margin-top:44px; border-top:1px solid #e2e6ef; padding-top:16px; font-size:13px; color:#6b7280; }
footer a { color:#2b6cb0; }
.site-nav { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 12px; }
.site-nav a { display:inline-flex; align-items:center; min-height:40px; padding:0 14px; font-size:14px; font-weight:600; text-decoration:none; border:1px solid #e2e6ef; border-radius:999px; background:#fff; }
.site-nav a:hover { border-color:#2b6cb0; }
@media (max-width:480px) { .wrap { padding:16px 14px 56px; } }
@media (prefers-color-scheme: dark) {
  body { background:#12151c; color:#e7eaf0; }
  .site-head, .crumbs, .related, .source-block, footer { border-color:#262b36; }
  .name-list li, #hits li { border-color:#1e222c; }
  .chips a, .pager a, .pager span, .search, .work img, .work .no-cover { background:#1a1e27; border-color:#262b36; }
  .name-list a, .work a, #hits a, .rank-list a { color:#e7eaf0; }
  .reviews li, .review-form input, .review-form textarea { background:#1a1e27; border-color:#262b36; }
  .ugc, .rank-list li { border-color:#262b36; }
  .site-head .site-name { color:#8ab4e8; }
  .crumbs a, .chips a, .sources a, footer a, .pager a { color:#8ab4e8; }
  .site-nav a { background:#1a1e27; border-color:#262b36; color:#8ab4e8; }
}
`

const SEARCH_JS = `(async () => {
  const box = document.getElementById('q')
  const hits = document.getElementById('hits')
  if (!box || !hits) return

  const text = await fetch('/data/search-index.tsv').then((r) => r.text())
  const rows = text.trim().split('\\n').map((line) => line.split('\\t'))

  const draw = (list) => {
    hits.innerHTML = list.slice(0, 60)
      .map(([name, slug, n]) => '<li><a href="/idol/' + encodeURIComponent(slug) + '/">' + name + '</a> <span class="count">' + n + '件</span></li>')
      .join('')
  }

  box.addEventListener('input', () => {
    const q = box.value.trim()
    draw(q ? rows.filter((r) => r[0].includes(q)) : [])
  })
})()
`

async function main() {
  let file = null
  try {
    file = await readJson(path.join(dataDir, 'gravure-actor-works.json'))
  } catch {
    console.log('データがまだありません。取得を先に走らせてください。')
    return
  }

  const confirmedOn = file.confirmedOn || new Date().toISOString().slice(0, 10)

  // **一度公開したURLを落とさない。**
  // darekore.jp では、出典から人が消えたときにページごと消えて 404 になり、
  // 検索に載って順位も付いていたページのクリックが 0 になった（2026-09-03）。
  // 出典が消えるのは向こうの都合で、こちらのURLの価値ではない。
  const readList = async (name) => {
    try {
      const text = await readFile(path.join(root, 'data', name), 'utf8')
      return new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))
    } catch {
      return new Set()
    }
  }

  const published = await readList('published-slugs.txt')

  // 楽天の商品。**無くても作れる**（まだ取っていないときは、これまでどおりのページになる）。
  let rakuten = {}
  try {
    const file = await readJson(path.join(dataDir, 'rakuten-works.json'))
    rakuten = file.actors ?? {}
    console.log(`楽天: ${Object.keys(rakuten).length.toLocaleString('ja-JP')}人ぶんの商品を読み込みました`)
  } catch {
    console.log('楽天のデータが無いので、DMM だけで作ります。')
  }

  const usedSlugs = new Set()

  const people = Object.entries(file.actors ?? {})
    .map(([id, value]) => ({ id, ...value }))
    .filter((p) => p.name && p.w?.length)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'))

  for (const person of people) {
    let slug = slugify(person.name)
    let suffix = 2
    while (usedSlugs.has(slug)) slug = `${slugify(person.name)}-${suffix++}`
    usedSlugs.add(slug)
    person.slug = slug
    person.rakuten = rakuten[person.id] ?? null
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(path.join(outDir, 'assets'), { recursive: true })
  await mkdir(path.join(outDir, 'data'), { recursive: true })
  await writeFile(path.join(outDir, 'assets/page.css'), PAGE_CSS, 'utf8')
  await writeFile(path.join(outDir, 'assets/search.js'), SEARCH_JS, 'utf8')
  // 投票と口コミ、ランキングの読み込み。ビルドで作らずリポジトリに置いてある。
  await cp(path.join(root, 'assets'), path.join(outDir, 'assets'), { recursive: true })
  await writeFile(path.join(outDir, 'CNAME'), `${SITE_DOMAIN}\n`, 'utf8')

  // 分類ごとの人。分類ページと「同じ分類でよく出ている方」に使う。
  const byGenre = new Map()
  for (const person of people) {
    for (const [name, count] of Object.entries(person.g ?? {})) {
      if (SKIP_GENRES.has(name)) continue
      if (!byGenre.has(name)) byGenre.set(name, [])
      byGenre.get(name).push({ person, count })
    }
  }
  for (const rows of byGenre.values()) rows.sort((a, b) => b.count - a.count)

  // 発売年ごとの人。「同じ年に作品がある方」に使う。
  // 手元にあるのは新しい8件までなので、年は「持っている作品の発売年」であって
  // その方の活動期間ではない。ページの但し書きでそう書いてある。
  const byYear = new Map()
  for (const person of people) {
    const counted = Object.keys(person.y ?? {})
    const years = counted.length
      ? counted
      : (person.w ?? []).map((work) => String(work.d || '').slice(0, 4))

    for (const year of new Set(years.filter((year) => /^\d{4}$/.test(year)))) {
      if (!byYear.has(year)) byYear.set(year, [])
      byYear.get(year).push(person)
    }
  }

  // 作品数の順位。同じ件数の人は同じ順位にする（4,121人が1件で並ぶため）。
  const rankByCount = new Map()
  for (let index = 0; index < people.length; index += 1) {
    const count = people[index].n
    if (!rankByCount.has(count)) rankByCount.set(count, { place: index + 1, tied: 0 })
    rankByCount.get(count).tied += 1
  }

  /** 一覧から、その人の近くにいる人を取り出す。上位を切ると全ページ同じ顔ぶれになる。 */
  const neighbours = (rows, person, size = 10) => {
    const index = rows.indexOf(person)
    const start = Math.max(0, (index < 0 ? 0 : index) - Math.floor(size / 2))
    return rows.slice(start, start + size + 1)
      .filter((row) => row !== person)
      .slice(0, size)
      .map((row) => ({ name: row.name, slug: row.slug }))
  }

  // 出演者ページ
  for (const person of people) {
    // **いちばん人数の少ない分類を選ぶ。**「アイドル」は5,342人が入っていて、
    // そこから上位10人を出すと、どのページも同じ10人になり内部リンクとして働かない。
    const genreNames = Object.entries(person.g ?? {})
      .map(([name]) => name)
      .filter((name) => !SKIP_GENRES.has(name) && !WEAK_GENRES.has(name)
        && (byGenre.get(name)?.length ?? 0) >= 6)
      .sort((a, b) => byGenre.get(a).length - byGenre.get(b).length)

    const relatedGenre = genreNames[0] ?? null
    const related = relatedGenre
      ? neighbours(byGenre.get(relatedGenre).map((row) => row.person), person)
      : []

    const year = String(person.w?.[0]?.d || '').slice(0, 4)
    const sameYear = /^\d{4}$/.test(year) ? neighbours(byYear.get(year) ?? [], person) : []
    // 発売年を全部数えてあるか。数えていないなら、8件から拾った年でしかない。
    const yearsCounted = Boolean(Object.keys(person.y ?? {}).length)

    const dir = path.join(outDir, 'idol', person.slug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), renderIdol(person, {
      related,
      relatedGenre,
      sameYear,
      year,
      yearsCounted,
      rank: rankByCount.has(person.n)
        ? { ...rankByCount.get(person.n), total: people.length }
        : null,
    }), 'utf8')
  }

  // 出典から消えた人。中身は書けない（推測は載せない方針）が、404 は返さない。
  const written = new Set(people.map((person) => person.slug))
  const goneSlugs = [...published].filter((slug) => !written.has(slug))

  // 取得が途中で失敗すると大量に「消えた」ことになる。その状態で作り直すと、
  // 公開中のページがまとめて転送に変わる。**1割を超えたら作らずに止める。**
  if (published.size && goneSlugs.length > published.size * 0.1) {
    throw new Error(`公開済み ${published.size} 件のうち ${goneSlugs.length} 件が出典から消えています。`
      + '取得に失敗している可能性が高いので、ページを作り直しません。')
  }

  for (const slug of goneSlugs) {
    const dir = path.join(outDir, 'idol', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex,follow" />
    <link rel="canonical" href="${SITE_URL}/idol/" />
    <meta http-equiv="refresh" content="0; url=/idol/" />
    <title>このページは公開を終えました</title>
  </head>
  <body>
    <p>この方は出典のデータから見当たらなくなったため、いまは載せていません。
       <a href="/idol/">出演者の一覧</a>から探せます。</p>
  </body>
</html>
`, 'utf8')
  }

  if (goneSlugs.length) {
    console.log(`出典から消えた人の転送: ${goneSlugs.length.toLocaleString('ja-JP')}件`)
  }

  // 出演者一覧（作品数順・ページ送り）
  const pages = Math.max(1, Math.ceil(people.length / PER_PAGE))
  const urls = [`${SITE_URL}/`, `${SITE_URL}/idol/`, `${SITE_URL}/genre/`, `${SITE_URL}/maker/`, `${SITE_URL}/about/`]

  for (let page = 1; page <= pages; page += 1) {
    const rows = people.slice((page - 1) * PER_PAGE, page * PER_PAGE)
      .map((p) => ({ name: p.name, href: `/idol/${encodeURIComponent(p.slug)}/`, count: p.n }))

    const links = []
    for (let n = 1; n <= pages; n += 1) {
      links.push(n === page
        ? `<span class="current">${n}</span>`
        : `<a href="${n === 1 ? '/idol/' : `/idol/page/${n}/`}">${n}</a>`)
    }

    const html = renderList({
      title: page === 1 ? `出演者一覧（${people.length.toLocaleString('ja-JP')}人）｜${SITE_NAME}` : `出演者一覧 ${page}ページ目｜${SITE_NAME}`,
      heading: '出演者一覧',
      lead: `写真集・DVD に出ている ${people.length.toLocaleString('ja-JP')} 人を、収録作品の多い順に並べています。${confirmedOn} 時点のデータです。`,
      canonical: page === 1 ? `${SITE_URL}/idol/` : `${SITE_URL}/idol/page/${page}/`,
      crumbs: '出演者一覧',
      rows,
      pager: pages > 1 ? `<nav class="pager">${links.join('')}</nav>` : '',
    })

    const dir = page === 1 ? path.join(outDir, 'idol') : path.join(outDir, 'idol', 'page', String(page))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), html, 'utf8')
    if (page > 1) urls.push(`${SITE_URL}/idol/page/${page}/`)
  }

  // 分類別
  const genres = [...byGenre.entries()]
    .filter(([, rows]) => rows.length >= GENRE_MIN_PEOPLE)
    .sort((a, b) => b[1].length - a[1].length)

  for (const [name, rows] of genres) {
    const slug = slugify(name)
    const lead = `「${name}」に分類される作品に出ている ${rows.length.toLocaleString('ja-JP')} 人を、本数の多い順に並べています。`
    const html = renderList({
      title: `${name}の作品に出ている方${rows.length.toLocaleString('ja-JP')}人｜${SITE_NAME}`,
      heading: `${name}の作品に出ている方`,
      lead: `${lead}${confirmedOn} 時点のデータです。`,
      canonical: `${SITE_URL}/genre/${encodeURIComponent(slug)}/`,
      crumbs: `<a href="/genre/">分類別</a> ＞ ${escapeHtml(name)}`,
      rows: rows.slice(0, 600).map((row) => ({
        name: row.person.name, href: `/idol/${encodeURIComponent(row.person.slug)}/`, count: row.count,
      })),
    })
    const dir = path.join(outDir, 'genre', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), html, 'utf8')
    urls.push(`${SITE_URL}/genre/${encodeURIComponent(slug)}/`)
  }

  await mkdir(path.join(outDir, 'genre'), { recursive: true })
  await writeFile(path.join(outDir, 'genre', 'index.html'), renderList({
    title: `分類別に見る（${genres.length}区分）｜${SITE_NAME}`,
    heading: '分類別',
    lead: `DMM.com が作品に付けている分類のうち、${GENRE_MIN_PEOPLE}人以上が出ている ${genres.length} 区分を並べています。`,
    canonical: `${SITE_URL}/genre/`,
    crumbs: '分類別',
    rows: genres.map(([name, rows]) => ({ name, href: `/genre/${encodeURIComponent(slugify(name))}/`, count: rows.length })),
  }), 'utf8')

  // メーカー別
  let makers = []
  try {
    const makerFile = await readJson(path.join(dataDir, 'gravure-makers.json'))
    makers = Object.entries(makerFile.makers ?? {})
      .map(([id, value]) => ({ id, ...value }))
      .filter((m) => m.n >= MAKER_MIN_WORKS && m.w?.length)
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'))
  } catch {
    console.log('メーカーのデータが無いので、そのページは作りません。')
  }

  for (const maker of makers) {
    const canonical = `${SITE_URL}/maker/${encodeURIComponent(maker.id)}/`
    const lead = `${maker.name}の作品 ${maker.n.toLocaleString('ja-JP')} 件のうち、新しい ${maker.w.length} 件です。`
    const html = shell({
      title: `${maker.name}の作品｜${SITE_NAME}`,
      description: lead,
      canonical,
      crumbs: `<a href="/maker/">メーカー別</a> ＞ ${escapeHtml(maker.name)}`,
      body: `
        <h1>${escapeHtml(maker.name)}</h1>
        <p class="lead">${escapeHtml(lead)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
        <section class="work-block">
          <h2>収録作品<span class="pr">広告</span></h2>
          ${renderWorks(maker.w)}
        </section>`,
    })
    const dir = path.join(outDir, 'maker', maker.id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), html, 'utf8')
    urls.push(canonical)
  }

  await mkdir(path.join(outDir, 'maker'), { recursive: true })
  await writeFile(path.join(outDir, 'maker', 'index.html'), renderList({
    title: `メーカー別（${makers.length}社）｜${SITE_NAME}`,
    heading: 'メーカー別',
    lead: `収録作品が ${MAKER_MIN_WORKS} 件以上あるメーカー ${makers.length} 社を並べています。`,
    canonical: `${SITE_URL}/maker/`,
    crumbs: 'メーカー別',
    rows: makers.map((m) => ({ name: m.name, href: `/maker/${encodeURIComponent(m.id)}/`, count: m.n })),
  }), 'utf8')

  // 検索用の索引
  const tsv = people.map((p) => `${p.name}\t${p.slug}\t${p.n}`).join('\n')
  await writeFile(path.join(outDir, 'data/search-index.tsv'), `${tsv}\n`, 'utf8')

  // トップ
  const topLead = `写真集・DVD に出ているグラビアアイドル ${people.length.toLocaleString('ja-JP')} 人を、`
    + `名前から引けるようにしています。作品データは DMM.com が公開しているものだけを使い、`
    + `推測や独自の評価は載せていません。`

  await writeFile(path.join(outDir, 'index.html'), shell({
    title: `${SITE_NAME}｜グラビアアイドル・グラドルの出演作品を名前から探す`,
    description: topLead,
    canonical: `${SITE_URL}/`,
    crumbs: '',
    schema: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          name: SITE_NAME,
          url: `${SITE_URL}/`,
          description: topLead,
          inLanguage: 'ja',
          // 名前で引くサイトなので、検索の入口を機械にも示しておく。
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/idol/?q={search_term_string}` },
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@type': 'Dataset',
          name: `${SITE_NAME} 収録データ`,
          description: `グラビアアイドル ${people.length} 人と、その出演作品数。DMM.com アフィリエイト Web サービスが公開している項目のみ。`,
          url: `${SITE_URL}/`,
          creator: { '@type': 'Organization', name: SITE_NAME, url: `${SITE_URL}/` },
          isAccessibleForFree: true,
          license: 'https://affiliate.dmm.com/api/regulation/',
        },
      ],
    },
    body: `
      <h1>${escapeHtml(SITE_NAME)}</h1>
      <p class="lead">${escapeHtml(topLead)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <input id="q" class="search" type="search" placeholder="名前を入力（例: 小倉奈々）" autocomplete="off" />
      <ul id="hits"></ul>
      <h2>収録作品の多い方</h2>
      <ul class="name-list">${people.slice(0, 60)
        .map((p) => `<li><a href="/idol/${encodeURIComponent(p.slug)}/">${escapeHtml(p.name)}</a><span class="count">${p.n.toLocaleString('ja-JP')}件</span></li>`)
        .join('')}</ul>
      <p><a href="/idol/">出演者一覧をすべて見る</a></p>
      <h2>分類から探す</h2>
      <div class="chips">${genres.slice(0, 24)
        .map(([name, rows]) => `<a href="/genre/${encodeURIComponent(slugify(name))}/">${escapeHtml(name)}<span class="count">${rows.length}</span></a>`)
        .join('')}</div>
      <script defer src="/assets/search.js"></script>`,
  }), 'utf8')

  // 投票ランキング。中身は表示時に Supabase から読む。
  await mkdir(path.join(outDir, 'ranking'), { recursive: true })
  await writeFile(path.join(outDir, 'ranking', 'index.html'), shell({
    title: `投票ランキング｜${SITE_NAME}`,
    description: 'このサイトで押された票の数による順位です。外部の人気度ではありません。',
    canonical: `${SITE_URL}/ranking/`,
    crumbs: '投票ランキング',
    script: '/assets/ranking.js',
    body: `
      <h1>投票ランキング</h1>
      <p class="lead"><strong>このサイトで押された票の数</strong>による順位です。
      外部の人気度や売上ではありません。出演者のページから投票できます。</p>
      <div id="ranking"
           data-api="${escapeHtml(SUPABASE_URL)}"
           data-key="${escapeHtml(SUPABASE_ANON_KEY)}"><p class="note">読み込んでいます…</p></div>`,
  }), 'utf8')
  urls.push(`${SITE_URL}/ranking/`)

  // このサイトについて
  await mkdir(path.join(outDir, 'about'), { recursive: true })
  await writeFile(path.join(outDir, 'about', 'index.html'), shell({
    title: `このサイトについて｜${SITE_NAME}`,
    description: `${SITE_NAME}の掲載方針と出典、削除依頼の窓口について。`,
    canonical: `${SITE_URL}/about/`,
    crumbs: 'このサイトについて',
    body: `
      <h1>このサイトについて</h1>
      <h2>載せているもの</h2>
      <p>写真集とDVDの商品情報から、出演者ごとの作品をまとめています。出典は
      <a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">DMM.com アフィリエイト Web サービス</a>です。</p>
      <h2>載せていないもの</h2>
      <ul>
        <li><strong>生年月日・身長などのプロフィール。</strong>出典が無いため書きません</li>
        <li><strong>読み仮名。</strong>APIに入っていないため、五十音索引も作っていません。勝手に振ると別人に行き着きます</li>
        <li><strong>アダルト作品へのリンク。</strong>このサイトでは扱いません</li>
        <li>独自の順位づけや評価</li>
      </ul>
      <h2>投票と口コミについて</h2>
      <p>投票は<strong>このサイトで押された票の数</strong>で、外部の人気度や売上ではありません。
      口コミは実在の方についての書き込みなので、<strong>運営が内容を確認してから公開します。</strong>
      悪口や、確認できない事実の断定は載せません。</p>
      <h2>広告について</h2>
      <p>作品へのリンクは DMM.com のアフィリエイトプログラムを利用しています。
      リンクから購入があった場合、運営者に紹介料が入ります。</p>
      <h2>削除・訂正のご依頼</h2>
      <p><a href="mailto:${CONTACT}">${CONTACT}</a> へご連絡ください。確認のうえ対応します。</p>`,
  }), 'utf8')

  // robots.txt / llms.txt / sitemap.xml
  //
  // 生成AIのクローラーは名指しで許可する。載せているのは DMM.com の API が
  // 公開している項目だけで、隠す理由がない。数え方の制約と載せていないものは
  // llms.txt に書いてあるので、そちらも読ませる。
  const AI_CRAWLERS = [
    'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
    'ClaudeBot', 'Claude-User', 'Claude-SearchBot',
    'PerplexityBot', 'Perplexity-User',
    'Google-Extended', 'Applebot-Extended', 'Bingbot', 'CCBot',
  ]
  await writeFile(path.join(outDir, 'robots.txt'),
    `User-agent: *\nAllow: /\n\n`
    + AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nAllow: /\n`).join('\n')
    + `\nSitemap: ${SITE_URL}/sitemap.xml\n`, 'utf8')

  await writeFile(path.join(outDir, 'llms.txt'), `# ${SITE_NAME}（${SITE_DOMAIN}）

> 写真集・DVD に出ているグラビアアイドルを、名前から引ける名鑑。DMM.com アフィリエイト Web サービスが公開している項目だけを集めています。

## このサイトが載せているもの

- 出演者の氏名（APIの表記そのまま）
- 出演作品の数と、その作品ページへのリンク
- 分類（ジャンル）別・メーカー別の集計
- 閲覧者による投票と口コミ

## 載せていないもの

- 生年月日・身長・出身地などのプロフィール（APIに項目が無いため）
- 読み仮名（APIに無いため、五十音索引そのものを作っていません。読みを勝手に振ると別人に行き着きます）
- 当サイトによる推測・補間・独自の評価
- アダルト作品へのリンク

数値はすべて DMM.com が公開しているものを数えたものです。当サイトが独自に推定した数字はありません。

## 数え方の制約

- 収録は ${people.length} 人、${confirmedOn} 時点のデータです
- 作品数は写真集・DVD の商品件数であり、出演本数そのものとは一致しません
- 分類ページは ${GENRE_MIN_PEOPLE} 人以上、メーカーページは ${MAKER_MIN_WORKS} 件以上のものだけを作っています。下回るものはページにしていません
- 商品の売り方を表す分類（セット商品・予約商品・ベスト盤など）は数えていません
- 同姓同名が区別できない場合があります

## 主なページ

- ${SITE_URL}/ — 名前で検索
- ${SITE_URL}/idol/ — 出演者一覧
- ${SITE_URL}/genre/ — 分類別
- ${SITE_URL}/maker/ — メーカー別
- ${SITE_URL}/ranking/ — 投票ランキング
- ${SITE_URL}/about/ — このサイトについて

## 連絡先

掲載内容の訂正・削除のご依頼は ${CONTACT} へ。確認のうえ対応します。
`, 'utf8')

  for (const person of people) urls.push(`${SITE_URL}/idol/${encodeURI(person.slug)}/`)

  // 次回のために記録する。**これが無いと上の安全網が働かない。**
  // 転送ページになったURLも残す（消すと、次回また404が生まれる）。
  await writeFile(path.join(root, 'data', 'published-slugs.txt'),
    `${[...new Set([...published, ...people.map((person) => person.slug)])].sort().join('\n')}\n`, 'utf8')

  const today = new Date().toISOString().slice(0, 10)
  await writeFile(path.join(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((loc) => `  <url><loc>${loc}</loc><lastmod>${today}</lastmod></url>`).join('\n')
    + '\n</urlset>\n', 'utf8')

  // IndexNow の鍵ファイル。検索エンジンは、送られた鍵がこのURLに置かれて
  // いるかを見て、そのサイトの持ち主からの通知かを確かめる。
  // 鍵は秘密ではないが、ワークフロー側と必ず同じ値にすること。
  const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'guradolindex2026'
  await writeFile(path.join(outDir, `${INDEXNOW_KEY}.txt`), `${INDEXNOW_KEY}\n`, 'utf8')

  await writeFile(path.join(outDir, 'favicon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2b4d7e"/><text x="16" y="22" font-size="17" text-anchor="middle" fill="#fff" font-family="sans-serif">G</text></svg>\n', 'utf8')

  console.log(`出演者 ${people.length.toLocaleString('ja-JP')}人 / 分類 ${genres.length} / メーカー ${makers.length}`)
  console.log(`サイトマップ: ${urls.length.toLocaleString('ja-JP')}URL`)
}

await main()
