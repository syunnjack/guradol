// 出演者ページの投票と口コミ。（guradol.jp）
//
// サイトは静的なので、投稿の保存先は Supabase。ブラウザから匿名キーで
// 直接読み書きする。匿名キーは公開してよい値で、守りはデータベース側の
// RLS が担う（supabase/migrations/0001_votes_and_reviews.sql）。
//
// 口コミは実在の人物についての書き込みなので、運営が確認するまで表示しない。
//
// テーブルは darekore.jp と分けてある（idol_ を付けたもの）。
// スラッグが衝突しうるうえ、確認待ちの列が混ざると扱いにくいため。

(function () {
  const root = document.getElementById('ugc')
  if (!root) return

  const slug = root.dataset.slug
  const api = root.dataset.api
  const key = root.dataset.key

  if (!api || !key) {
    root.innerHTML = '<p class="note">投票と口コミの準備中です。</p>'
    return
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}` }
  const json = { ...headers, 'Content-Type': 'application/json' }

  /** この端末を表す識別子。個人を特定するものではなく、二重投票を防ぐだけ。 */
  function voterHash() {
    const saved = localStorage.getItem('guradol-voter')
    if (saved) return saved

    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const made = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

    localStorage.setItem('guradol-voter', made)
    return made
  }

  function escape(text) {
    const box = document.createElement('div')
    box.textContent = text
    return box.innerHTML
  }

  function whenLabel(iso) {
    const date = new Date(iso)
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }

  const voted = () => localStorage.getItem(`guradol-voted-${slug}`) === '1'

  async function loadVotes() {
    const url = `${api}/rest/v1/idol_votes?slug=eq.${encodeURIComponent(slug)}&select=id`
    const response = await fetch(url, { headers: { ...headers, Prefer: 'count=exact' } })
    const range = response.headers.get('content-range') || '0-0/0'
    return Number(range.split('/')[1] || 0)
  }

  async function loadReviews() {
    const url = `${api}/rest/v1/idol_reviews`
      + `?slug=eq.${encodeURIComponent(slug)}&status=eq.approved`
      + '&select=nickname,body,created_at&order=created_at.desc&limit=30'
    const response = await fetch(url, { headers })
    return response.ok ? response.json() : []
  }

  function renderVotes(count) {
    const done = voted()
    return `
      <div class="vote-box">
        <button type="button" id="voteButton" class="vote"${done ? ' disabled' : ''}>
          ${done ? '投票済み' : 'この人に投票する'}
        </button>
        <span class="vote-count"><strong id="voteCount">${count.toLocaleString('ja-JP')}</strong> 票</span>
      </div>`
  }

  function renderReviews(rows) {
    if (!rows.length) {
      return '<p class="note">まだ口コミはありません。</p>'
    }

    return `<ul class="reviews">${rows.map((row) => `
      <li>
        <p class="review-body">${escape(row.body)}</p>
        <p class="review-meta">${escape(row.nickname || '名無し')}・${whenLabel(row.created_at)}</p>
      </li>`).join('')}</ul>`
  }

  const form = `
    <form id="reviewForm" class="review-form">
      <label for="reviewNickname">お名前（任意・20文字まで）</label>
      <input id="reviewNickname" type="text" maxlength="20" autocomplete="off" />

      <label for="reviewBody">口コミ（4〜400文字）</label>
      <textarea id="reviewBody" rows="4" maxlength="400" required></textarea>

      <p class="note">
        実在の方についての投稿です。悪口や、確認できない事実の断定は載せません。
        運営が内容を確認してから公開するため、すぐには表示されません。
      </p>
      <button type="submit" class="button">口コミを送る</button>
      <p id="reviewMessage" class="note"></p>
    </form>`

  async function draw() {
    const [count, rows] = await Promise.all([loadVotes(), loadReviews()])

    root.innerHTML = `
      <h2>この人への投票</h2>
      ${renderVotes(count)}
      <h2>口コミ（${rows.length}件）</h2>
      ${renderReviews(rows)}
      ${form}`

    document.getElementById('voteButton')?.addEventListener('click', vote)
    document.getElementById('reviewForm')?.addEventListener('submit', send)
  }

  async function vote(event) {
    const button = event.currentTarget
    button.disabled = true

    const response = await fetch(`${api}/rest/v1/idol_votes`, {
      method: 'POST',
      headers: { ...json, Prefer: 'return=minimal' },
      body: JSON.stringify({ slug, voter_hash: voterHash() }),
    })

    if (response.ok || response.status === 409) {
      localStorage.setItem(`guradol-voted-${slug}`, '1')
      button.textContent = '投票済み'
      const box = document.getElementById('voteCount')
      if (response.ok && box) {
        box.textContent = (Number(box.textContent.replace(/,/g, '')) + 1).toLocaleString('ja-JP')
      }
    } else {
      button.disabled = false
      button.textContent = '投票できませんでした'
    }
  }

  async function send(event) {
    event.preventDefault()

    const form = event.currentTarget
    const message = document.getElementById('reviewMessage')
    const body = document.getElementById('reviewBody').value.trim()
    const nickname = document.getElementById('reviewNickname').value.trim()

    if (body.length < 4) {
      message.textContent = '4文字以上でお願いします。'
      return
    }

    message.textContent = '送っています…'

    const response = await fetch(`${api}/rest/v1/idol_reviews`, {
      method: 'POST',
      headers: { ...json, Prefer: 'return=minimal' },
      body: JSON.stringify({ slug, body, nickname: nickname || null, status: 'pending' }),
    })

    if (response.ok) {
      form.reset()
      message.textContent = '受け付けました。運営が確認してから公開します。'
    } else {
      message.textContent = '送れませんでした。時間をおいてお試しください。'
    }
  }

  draw().catch(() => {
    root.innerHTML = '<p class="note">投票と口コミを読み込めませんでした。</p>'
  })
})()
