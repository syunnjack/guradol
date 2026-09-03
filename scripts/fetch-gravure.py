"""グラビアの作品を集めて、出演者ごとの出演作品にする。

出典: DMM.com アフィリエイト Web サービス（一般）
      https://affiliate.dmm.com/api/

**アダルト（FANZA）は見ない。** このサイトは一般側だけで作る。

## どこから取るか（2026-09-01 に実測）

  ebook/photo   写真集         39,628件  iteminfo に actor と genre（グラビア/アイドル）
  mono/dvd      DVD・Blu-ray   keyword=グラビア で 11,483件  actor が複数入る

どちらも gte_date / lte_date で月に絞れる（写真集の2026年8月＝388件）。
offset に上限があるので、FANZA と同じく**発売月で区切ってなめる**。

## 出力

  data/gravure-actor-works.json  出演者ごとの新しい作品 WORKS_PER_ACTOR 本
  data/gravure-makers.json       レーベル・出版社ごとの本数と代表作

出演者1人ぶんの中身:

  name  名前          n   作品数          w  新しい作品（WORKS_PER_ACTOR 本まで）
  g     分類ごとの件数  kn  種別ごとの件数   f  いちばん古い作品の発売日
  y     発売年ごとの件数
  r     いま開いている月で数えた作品ID（二重計上よけ。表示には使わない）

**w は8本しか残らないので、全体のことは kn / f / y に数えておく。**
あとから w を見ても、8本より多い人の発売時期や内訳は分からない。

作品ページのURLと画像URLは API が返すものをそのまま持つ（一般側は
FANZA のように品番から組み立てられないため）。

環境変数:
  FANZA_API_ID / FANZA_AFFILIATE_ID   （DMM.com 一般でも同じキーが使える）
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  FROM_MONTH    取り始める月（YYYY-MM。既定は前回の続き）
  RESET         1 なら前回の結果を捨てて最初から
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BASE = 'https://api.dmm.com/affiliate/v3'
MAX_OFFSET = 50000
WORKS_PER_ACTOR = 8
WORKS_PER_MAKER = 12
START_MONTH = '2005-01'
PAUSE = 0.4

# 見るフロア。keyword はそのフロアで絞り込みに使う語（空なら絞らない）。
SOURCES = [
    {'key': 'photo', 'label': '写真集', 'service': 'ebook', 'floor': 'photo', 'keyword': ''},
    {'key': 'dvd', 'label': 'DVD', 'service': 'mono', 'floor': 'dvd', 'keyword': 'グラビア'},
]

OUT_DIR = Path(__file__).resolve().parent.parent / 'data'


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


def months(start: str, end: str) -> list:
    sy, sm = (int(x) for x in start.split('-'))
    ey, em = (int(x) for x in end.split('-'))
    out = []

    while (sy, sm) <= (ey, em):
        out.append(f'{sy:04d}-{sm:02d}')
        sm += 1
        if sm > 12:
            sy, sm = sy + 1, 1

    return out


def month_bounds(month: str) -> tuple:
    year, mon = (int(x) for x in month.split('-'))
    nxt_y, nxt_m = (year + 1, 1) if mon == 12 else (year, mon + 1)

    return f'{year:04d}-{mon:02d}-01T00:00:00', f'{nxt_y:04d}-{nxt_m:02d}-01T00:00:00'


def keep_newest(bucket: list, work: dict, limit: int) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[limit:]


def counted_twice(bucket: dict, cid: str, open_month: str) -> bool:
    """**まだ終わっていない月は、次の回でもう一度なめる。**

    「次に取る月」は最後の月だけ進まない（その月の作品はまだ増えるため）。
    そのため同じ作品を2回数えていて、作品数と分類の件数が回を追うごとに増えていた。
    2026-09-04 時点で13人が1件ずつ多く出ていた。

    数えた作品IDを、その開いている月のあいだだけ `r` に控えて、2度目を飛ばす。
    月が変われば `r` は捨てる（過去の月は二度となめないので要らない）。
    """
    if not open_month:
        return False

    seen = bucket.setdefault('r', [])
    if cid in seen:
        return True

    seen.append(cid)
    return False


def forget_open_month(*collections) -> None:
    for group in collections:
        for bucket in group.values():
            bucket.pop('r', None)


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def scan(cred: dict, source: dict, month: str) -> tuple:
    gte, lte = month_bounds(month)
    params = dict(cred, output='json', site='DMM.com', service=source['service'],
                  floor=source['floor'], hits=100, offset=1, sort='date',
                  gte_date=gte, lte_date=lte)

    if source['keyword']:
        params['keyword'] = source['keyword']

    items, offset, total = [], 1, None

    while True:
        params['offset'] = offset
        payload = fetch(f'{BASE}/ItemList?' + urllib.parse.urlencode(params)).get('result', {})

        if total is None:
            total = int(payload.get('total_count') or 0)

        got = payload.get('items') or []
        if not got:
            break

        items.extend(got)
        offset += 100
        time.sleep(PAUSE)

        if offset > min(total or 0, MAX_OFFSET):
            break

    return items, (total or 0)


def usable_name(name: str) -> bool:
    """「----」のように名前が入っていない行がある。"""
    cleaned = (name or '').strip().strip('-').strip('－').strip('―')
    return bool(cleaned)


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    works_path = OUT_DIR / 'gravure-actor-works.json'
    makers_path = OUT_DIR / 'gravure-makers.json'
    state_path = OUT_DIR / 'gravure-state.json'

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(state_path)
    actors = {} if reset else load(works_path).get('actors', {})
    makers = {} if reset else load(makers_path).get('makers', {})

    today = date.today()
    last_month = f'{today.year:04d}-{today.month:02d}'
    from_month = os.environ.get('FROM_MONTH', '').strip() or state.get('nextMonth') or START_MONTH

    todo = months(from_month, last_month)
    if not todo:
        print('取る月がありません。', file=sys.stderr)
        return 0

    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    scanned = int(state.get('scanned') or 0)

    print(f'{todo[0]} から {todo[-1]} まで {len(todo)}か月ぶんを取ります。', file=sys.stderr)

    open_month = '' if reset else str(state.get('openMonth') or '')

    def save(next_month: str) -> None:
        head = {'confirmedOn': today.isoformat(), 'scanned': scanned,
                'source': 'DMM.com アフィリエイト Web サービス（一般）',
                'worksPerActor': WORKS_PER_ACTOR}
        state_path.write_text(json.dumps(dict(head, nextMonth=next_month, openMonth=open_month),
                                         ensure_ascii=False),
                              encoding='utf-8')
        works_path.write_text(json.dumps(dict(head, actors=actors), ensure_ascii=False),
                              encoding='utf-8')
        makers_path.write_text(json.dumps(dict(head, makers=makers), ensure_ascii=False),
                               encoding='utf-8')

    for month in todo:
        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので {month} の手前で切り上げます。', file=sys.stderr)
            save(month)
            break

        got = 0

        # 終わった月はもう二度となめないので、控えは要らない。
        # なめ直すのは「まだ終わっていない今月」だけ。
        if month == last_month:
            if open_month != month:
                forget_open_month(actors, makers)
                open_month = month
        elif open_month:
            forget_open_month(actors, makers)
            open_month = ''

        # **同じ月のなかで同じ作品が2回出てくることがある。**
        # 「催眠遊戯 〜アイドールズ〜」（h_343rmq004）で、春日桃さんと夏川なみさんが
        # 1件ずつ多く数えられていた（2026-09-04）。offset をずらしながら取るので、
        # 境目で同じ作品が返るか、iteminfo.actor に同じ人が2度入っている。
        # 月をなめるあいだだけ覚えておけばよい（過去の月は二度と来ない）。
        month_seen = set()

        for source in SOURCES:
            items, _total = scan(cred, source, month)

            for raw in items:
                cid = str(raw.get('content_id') or '').strip()
                title = str(raw.get('title') or '').strip()
                url = str(raw.get('affiliateURL') or '').strip()
                released = str(raw.get('date') or '')[:10]

                if not cid or not title or not url:
                    continue

                images = raw.get('imageURL') or {}
                image = images.get('list') or images.get('small') or ''
                info = raw.get('iteminfo') or {}
                genres = [str(g.get('name') or '') for g in (info.get('genre') or [])]

                scanned += 1
                got += 1
                work = {'c': cid, 't': title, 'd': released, 'u': url,
                        'i': image, 'k': source['key']}

                for person in info.get('actor') or []:
                    ident = str(person.get('id') or '').strip()
                    name = str(person.get('name') or '').strip()

                    if not ident or not usable_name(name):
                        continue

                    bucket = actors.setdefault(ident, {'name': name, 'n': 0, 'w': [], 'g': {}})
                    bucket['name'] = name
                    keep_newest(bucket['w'], work, WORKS_PER_ACTOR)

                    if ('a', ident, cid) in month_seen:
                        continue

                    month_seen.add(('a', ident, cid))

                    if counted_twice(bucket, cid, open_month):
                        continue

                    bucket['n'] += 1

                    for genre in genres:
                        bucket['g'][genre] = bucket['g'].get(genre, 0) + 1

                    # **w は新しい8件しか残らないので、全体のことはここで数えておく。**
                    # あとから w を見ても、8件より多い人の発売時期や内訳は分からない。
                    bucket['kn'] = bucket.get('kn') or {}
                    bucket['kn'][source['key']] = bucket['kn'].get(source['key'], 0) + 1

                    if released:
                        if not bucket.get('f') or released < bucket['f']:
                            bucket['f'] = released
                        bucket['y'] = bucket.get('y') or {}
                        bucket['y'][released[:4]] = bucket['y'].get(released[:4], 0) + 1

                for entry in info.get('maker') or []:
                    ident = str(entry.get('id') or '').strip()
                    name = str(entry.get('name') or '').strip()

                    if not ident or not name:
                        continue

                    bucket = makers.setdefault(ident, {'name': name, 'n': 0, 'w': []})
                    keep_newest(bucket['w'], work, WORKS_PER_MAKER)

                    if ('m', ident, cid) in month_seen:
                        continue

                    month_seen.add(('m', ident, cid))

                    if counted_twice(bucket, cid, open_month):
                        continue

                    bucket['n'] += 1

        print(f'  {month}  {got:,}件  出演者 {len(actors):,}人', file=sys.stderr)
        save(months(month, last_month)[1] if month != last_month else last_month)

    print(f'\n作品 {scanned:,}件を見て、出演者 {len(actors):,}人にまとめました。', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
