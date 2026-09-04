"""DMMTV（動画配信）の作品を、タイトルから出演者に結びつける。

出典: DMM.com アフィリエイト Web サービス（一般・dmmtv/dmmtv_video）

## なぜ別のスクリプトなのか

**DMMTV は iteminfo が空で返る。** 出演者も分類も入っていない
（2026-09-04・probe-floors.py で確認）。fetch-gravure.py は
`iteminfo.actor` を頼りに人へ配るので、この棚だけは同じやり方が使えない。

グラビアで 27,792 件あり、写真集・DVD とは**買い方が違う（配信）**。
写真集を買わない人でも配信なら見る、という道が1本増える。

## どうやって結びつけるか

**タイトルを区切った語が、そのまま出演者名と一致したときだけ拾う。**

    追憶の彼女 大瀧沙羅                  → 大瀧沙羅
    NEXUS Girls Extra vol.464 八角麗子   → 八角麗子
    【VR】モテ期の晩餐 涼やか関西美人と美酒 白川珠里 → 白川珠里

部分一致にすると、「みなみ」のような短い名前が別人の作品に当たる。
**名前が独立した語として置かれているときだけ**にして、取りこぼしても
間違えないほうを選ぶ。楽天（fetch-rakuten.py）で
「商品名にお名前が入っているものだけ」にしているのと同じ考え方。

2文字以下の名前と、ASCII だけの名前は引かない（当たりすぎる）。

## 出力

  data/dmmtv-works.json  出演者IDごとの作品（WORKS_PER_ACTOR 件まで）

環境変数:
  FANZA_API_ID / FANZA_AFFILIATE_ID   （DMM.com 一般でも同じキー）
  MAX_MINUTES   これを過ぎたら打ち切る（既定 60 分）
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BASE = 'https://api.dmm.com/affiliate/v3'
SERVICE = 'dmmtv'
FLOOR = 'dmmtv_video'
KEYWORD = 'グラビア'
HITS = 100
MAX_OFFSET = 50000
PAUSE = 0.4
WORKS_PER_ACTOR = 6

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'data' / 'gravure-actor-works.json'
OUT = ROOT / 'data' / 'dmmtv-works.json'

# タイトルを語に割る文字。全角の空白と、囲みや区切りに使われるもの。
SPLIT = re.compile(r'[\s　/／・,，、\[\]【】（）()「」『』〈〉《》＜＞<>|｜:：;；!！?？~〜\-–—+＋*＊#＃"\'’”]+')


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def searchable(name: str) -> bool:
    """引いてよい名前か。当たりすぎる名前は使わない。"""
    if len(name) < 3:
        return False
    if re.fullmatch(r'[\x00-\x7F]+', name):
        return False
    return True


def tokens(title: str) -> set:
    return {part for part in SPLIT.split(title or '') if part}


def keep_newest(bucket: list, work: dict) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[WORKS_PER_ACTOR:]


def fetch(url: str, tries: int = 5, wait: float = 3.0) -> dict:
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return json.loads(response.read().decode('utf-8', 'replace'))
        except Exception as error:
            if attempt == tries - 1:
                print(f'    あきらめます: {error}', file=sys.stderr)
                return {}
            time.sleep(wait * (attempt + 1))
    return {}


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    actors = load(SOURCE).get('actors') or {}
    if not actors:
        print('出演者データがありません。先に fetch-gravure.py を走らせてください。', file=sys.stderr)
        return 1

    # 名前 → 出演者ID。同じ名前が2人いたら、**どちらか分からないので使わない。**
    by_name = {}
    for ident, value in actors.items():
        name = (value.get('name') or '').strip()
        if not searchable(name):
            continue
        by_name[name] = None if name in by_name else ident

    ambiguous = sum(1 for v in by_name.values() if v is None)
    by_name = {k: v for k, v in by_name.items() if v}
    print(f'引ける名前 {len(by_name):,}件（同名で外したもの {ambiguous:,}件）', file=sys.stderr)

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id, 'output': 'json'}
    limit_minutes = float(os.environ.get('MAX_MINUTES', '60'))
    started = time.time()

    found = {}
    seen = set()
    offset, total, scanned, matched = 1, None, 0, 0

    while True:
        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので切り上げます。', file=sys.stderr)
            break

        payload = fetch(f'{BASE}/ItemList?' + urllib.parse.urlencode(dict(
            cred, site='DMM.com', service=SERVICE, floor=FLOOR,
            keyword=KEYWORD, hits=HITS, offset=offset, sort='date',
        ))).get('result', {})

        if total is None:
            total = int(payload.get('total_count') or 0)
            print(f'DMMTV のグラビア {total:,}件をなめます。', file=sys.stderr)

        items = payload.get('items') or []
        if not items:
            break

        for raw in items:
            cid = str(raw.get('content_id') or '').strip()
            title = str(raw.get('title') or '').strip()
            url = str(raw.get('affiliateURL') or '').strip()

            if not cid or not title or not url or cid in seen:
                continue

            seen.add(cid)
            scanned += 1

            hits = {by_name[word] for word in tokens(title) if word in by_name}
            if not hits:
                continue

            matched += 1
            images = raw.get('imageURL') or {}
            work = {'c': cid, 't': title, 'd': str(raw.get('date') or '')[:10],
                    'u': url, 'i': images.get('list') or images.get('small') or ''}

            for ident in hits:
                keep_newest(found.setdefault(ident, {'w': []})['w'], work)

        offset += HITS
        time.sleep(PAUSE)

        if offset > min(total or 0, MAX_OFFSET):
            break

        if offset % 2000 == 1:
            print(f'  {offset:,}/{total:,}  名前が取れた作品 {matched:,}  出演者 {len(found):,}人',
                  file=sys.stderr)

    OUT.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'scanned': scanned,
        'matched': matched,
        'source': 'DMM.com アフィリエイト Web サービス（DMMTV）',
        'worksPerActor': WORKS_PER_ACTOR,
        'actors': found,
    }, ensure_ascii=False), encoding='utf-8')

    print(f'\n作品 {scanned:,}件を見て、{matched:,}件で名前が取れました。'
          f'出演者 {len(found):,}人。', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
