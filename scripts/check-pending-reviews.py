"""未承認の口コミがあるか調べて、あれば内容を出す。

実在の人物についての書き込みなので、公開前に必ず運営が読む。
その「読むべきものが来ている」ことに気づく手立てが無かったため作った。

未承認の口コミは匿名キーでは読めない（RLSで塞いである）ので、
サービスロールキーで問い合わせる。**このキーは絶対にリポジトリへ置かない。**

  SUPABASE_URL / SUPABASE_SERVICE_ROLE

出力は GitHub Actions の Issue 本文にそのまま使う形にしている。
何も無ければ何も出さず、終了コード0で終わる。

使い方:
  SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE=yyy python scripts/check-pending-reviews.py
"""
import json
import os
import sys
import urllib.parse
import urllib.request

SITE_URL = 'https://guradol.jp'
TABLE = 'idol_reviews'


def fetch(url: str, key: str) -> list:
    request = urllib.request.Request(url, headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode())


def main() -> None:
    api = os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_SERVICE_ROLE')

    if not api or not key:
        print('環境変数 SUPABASE_URL と SUPABASE_SERVICE_ROLE が必要です。', file=sys.stderr)
        raise SystemExit(1)

    query = urllib.parse.urlencode({
        'select': 'id,slug,nickname,body,created_at',
        'status': 'eq.pending',
        'order': 'created_at.asc',
        'limit': 50,
    })

    rows = fetch(f'{api.rstrip("/")}/rest/v1/{TABLE}?{query}', key)

    if not rows:
        print('未承認の口コミはありません。', file=sys.stderr)
        return

    lines = [f'未承認の口コミが **{len(rows)}件** あります。', '']

    for row in rows:
        slug = row.get('slug') or ''
        lines += [
            f'### {urllib.parse.unquote(slug)}（id: {row["id"]}）',
            '',
            f'- ページ: {SITE_URL}/idol/{slug}/',
            f'- 投稿者: {row.get("nickname") or "（名前なし）"}',
            f'- 投稿日時: {row.get("created_at", "")}',
            '',
            '```',
            str(row.get('body') or '').strip(),
            '```',
            '',
        ]

    ids = ', '.join(str(row['id']) for row in rows)
    lines += [
        '---',
        '',
        '## 確認すること',
        '',
        '- 事実と異なる断定がないか',
        '- 誹謗中傷や、身体的特徴の揶揄がないか',
        '- 個人情報（本名・住所・勤務先など）が含まれていないか',
        '- 宣伝やスパムでないか',
        '',
        '## 承認するとき',
        '',
        'Supabase の SQL Editor で実行する。',
        '',
        '```sql',
        f"update public.{TABLE}",
        "   set status = 'approved', reviewed_at = now()",
        f' where id in ({ids});',
        '```',
        '',
        '## 却下するとき',
        '',
        '```sql',
        f"update public.{TABLE}",
        "   set status = 'rejected', reviewed_at = now()",
        ' where id in (対象のid);',
        '```',
        '',
        '確認が終わったらこの Issue を閉じる。開いたままだと次の通知が出ない。',
    ]

    print('\n'.join(lines))


if __name__ == '__main__':
    main()
