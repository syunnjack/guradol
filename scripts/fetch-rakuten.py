"""出演者ごとに、楽天市場の写真集・DVD を集める。DMM と並ぶ2社目の出典。

出典: 楽天ウェブサービス（楽天市場商品検索API）

## なぜ2社目が要るか

darekore.jp で分かったこと。**成果は「リンクの単位」で決まる**が、
出典が1社だけだと、その社で取扱終了・売り切れになった時点で
そのページから買える先が消える。同じ出演者に2社を並べておけば、
片方が落ちてももう片方が残る。

写真集とDVDは楽天ブックスでも売られているので、同じ人を引ける。

## エンドポイント（2026-09-01 に golf-search で実測）

    https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701

**app.rakuten.co.jp/services のほうは、このアプリIDでは通らない。**
`applicationId` と `accessKey` の両方が要る。BooksTotal/BooksDVD の
エンドポイントは 404 だった（2026-09-03 実測）ので、市場APIで引く。

## 誤爆を避ける

名前だけで引くと、同名の別人や無関係な商品が混ざる。

  - キーワードは「<名前> 写真集」「<名前> DVD」の2本立て
  - **商品名に出演者名が入っていないものは捨てる**
    （darekore の大人のおもちゃで、「OL」が「COOL」に当たった)
  - ASCII だけの名前と2文字未満の名前は引かない（当たりすぎる）

## 出力

  data/rakuten-works.json  出演者IDごとの商品（HITS 件まで）

環境変数:
  RAKUTEN_ICHIBA_APP_ID / RAKUTEN_ICHIBA_ACCESS_KEY / RAKUTEN_AFFILIATE_ID
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  ONLY          この人数だけ試す（動作確認用）
  RESET         1 なら前回の結果を捨てて最初から
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701'
HITS = 4
PAUSE = 1.1
AGENT = 'Mozilla/5.0 (compatible; gravure-meikan.jp/1.0)'

# **Referer と Origin を付ける。** 楽天のアプリ登録には Allowed websites があり、
# そこに載っていないドメインから叩くと 403 HTTP_REFERRER_NOT_ALLOWED が返る。
# golf-search で、ドメインを移したあと登録を直さず47都道府県すべてが0件になった
# （2026-08-30）。SITE_URL は build-site.mjs の SITE_DOMAIN と同じ値にする。
SITE_URL = os.environ.get('SITE_URL', 'https://gravure-meikan.jp').rstrip('/')
HEADERS = {'User-Agent': AGENT, 'Referer': SITE_URL, 'Origin': SITE_URL}

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'data' / 'gravure-actor-works.json'
OUT = ROOT / 'data' / 'rakuten-works.json'
STATE = ROOT / 'data' / 'rakuten-state.json'


def load(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def searchable(name):
    """引いてよい名前か。当たりすぎる名前は引かない。"""
    if len(name) < 3:
        return False
    if re.fullmatch(r'[\x00-\x7F]+', name):
        return False
    return True


def fetch(url, tries=4, wait=4.0):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode('utf-8', 'replace'))
        except urllib.error.HTTPError as error:
            body = ''
            try:
                body = error.read().decode('utf-8', 'replace')[:120]
            except Exception:
                pass
            # 429 は待てば通る。それ以外の 4xx は投げ方が違うので、すぐ知らせる。
            if error.code not in (429, 500, 502, 503):
                print(f'    {error.code}: {body}', file=sys.stderr)
                return {}
            time.sleep(wait * (attempt + 1))
        except Exception as error:
            if attempt == tries - 1:
                print(f'    あきらめます: {error}', file=sys.stderr)
                return {}
            time.sleep(wait * (attempt + 1))
    return {}


def main():
    app_id = os.environ.get('RAKUTEN_ICHIBA_APP_ID', '').strip()
    access_key = os.environ.get('RAKUTEN_ICHIBA_ACCESS_KEY', '').strip()
    affiliate_id = os.environ.get('RAKUTEN_AFFILIATE_ID', '').strip()

    if not app_id or not access_key:
        print('RAKUTEN_ICHIBA_APP_ID と RAKUTEN_ICHIBA_ACCESS_KEY が要ります。', file=sys.stderr)
        return 1

    source = load(SOURCE)
    actors = source.get('actors') or {}

    if not actors:
        print('出演者データがありません。先に fetch-gravure.py を走らせてください。', file=sys.stderr)
        return 1

    # 作品数の多い人から。見られるページから順に埋まる。
    people = sorted(
        ((ident, value.get('name') or '', value.get('n') or 0) for ident, value in actors.items()),
        key=lambda row: -row[2],
    )
    people = [row for row in people if searchable(row[1])]

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(STATE)
    stored = {} if reset else load(OUT)
    found = stored.get('actors', {})
    done = set(state.get('done') or [])

    only = int(os.environ.get('ONLY') or 0)
    if only:
        people = people[:only]

    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    today = date.today()
    hits = 0

    def save():
        STATE.write_text(json.dumps({'done': sorted(done), 'confirmedOn': today.isoformat()},
                                    ensure_ascii=False), encoding='utf-8')
        OUT.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'source': '楽天ウェブサービス（楽天市場商品検索API）',
            'hits': HITS,
            'actors': found,
        }, ensure_ascii=False), encoding='utf-8')

    print(f'対象 {len(people):,}人（済み {len(done):,}人）', file=sys.stderr)

    for index, (ident, name, _n) in enumerate(people, 1):
        if ident in done:
            continue

        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので切り上げます。', file=sys.stderr)
            save()
            return 0

        items = []
        seen = set()

        for suffix in ('写真集', 'DVD'):
            query = urllib.parse.urlencode({
                'format': 'json', 'formatVersion': 2,
                'applicationId': app_id, 'accessKey': access_key,
                'affiliateId': affiliate_id,
                'keyword': f'{name} {suffix}',
                'hits': HITS, 'sort': '-reviewCount',
                'imageFlag': 1, 'availability': 1,
            })
            payload = fetch(f'{ENDPOINT}?{query}')
            time.sleep(PAUSE)

            for raw in payload.get('Items') or []:
                item = raw.get('Item', raw)
                title = str(item.get('itemName') or '').strip()
                url = str(item.get('affiliateUrl') or item.get('itemUrl') or '').strip()

                # **商品名に名前が入っていないものは捨てる。** 同名の別人や
                # 無関係な商品が混ざるのを防ぐ。
                if not title or not url or name not in title:
                    continue
                if url in seen:
                    continue

                seen.add(url)
                images = item.get('mediumImageUrls') or []
                image = images[0] if isinstance(images, list) and images else ''
                if isinstance(image, dict):
                    image = image.get('imageUrl') or ''

                items.append({
                    't': title,
                    'u': url,
                    'i': str(image).replace('?_ex=128x128', '?_ex=200x200'),
                    'p': item.get('itemPrice'),
                    's': str(item.get('shopName') or '').strip(),
                })

        del items[HITS:]

        if items:
            found[ident] = {'name': name, 'w': items}
            hits += 1

        done.add(ident)

        if index % 50 == 0:
            print(f'  {index:,}/{len(people):,}人  商品が見つかった人 {hits:,}', file=sys.stderr)
            save()

    save()
    print(f'\n{len(people):,}人を見て、商品が見つかったのは {len(found):,}人', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
