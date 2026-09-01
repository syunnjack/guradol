// 当サイトの投票数によるランキング。（guradol.jp）
//
// 投票は Supabase に入っているので、表示のたびに読み直す。
// 外部の人気度ではなく、このサイトで押された票の数であることを画面に明記する。

(function () {
  const root = document.getElementById('ranking')
  if (!root) return

  const api = root.dataset.api
  const key = root.dataset.key

  if (!api || !key) {
    root.innerHTML = '<p class="note">ランキングの準備中です。</p>'
    return
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}` }

  function escape(text) {
    const box = document.createElement('div')
    box.textContent = text
    return box.innerHTML
  }

  async function load() {
    const url = `${api}/rest/v1/idol_stats?select=slug,votes,reviews&order=votes.desc&limit=100`
    const response = await fetch(url, { headers })
    return response.ok ? response.json() : []
  }

  function render(rows) {
    const ranked = rows.filter((row) => Number(row.votes) > 0)

    if (!ranked.length) {
      return '<p class="note">まだ投票がありません。出演者のページから投票できます。</p>'
    }

    return `<ol class="rank-list">${ranked.map((row) => `
      <li>
        <a href="/idol/${encodeURIComponent(row.slug)}/">${escape(decodeURIComponent(row.slug))}</a>
        <span class="rank-count">${Number(row.votes).toLocaleString('ja-JP')}票${
          Number(row.reviews) ? ` ・ 口コミ${Number(row.reviews).toLocaleString('ja-JP')}件` : ''
        }</span>
      </li>`).join('')}</ol>`
  }

  load()
    .then((rows) => { root.innerHTML = render(rows) })
    .catch(() => { root.innerHTML = '<p class="note">ランキングを読み込めませんでした。</p>' })
})()
