"""出演者ごとに、Yahoo!ショッピングの**中古**を集める。

出典: Yahoo!ショッピング商品検索API（V3 itemSearch）

## なぜ中古だけなのか

新品は DMM（写真集・DVD・紙の本）と楽天で足りている。
**Yahoo の強みは `condition` が項目として返ること。**

楽天では「出品者が商品名に『中古』と書いているか」で中古を見分けている。
Yahoo は API が `used` と返すので**推測が要らない**。
グラビアの写真集・DVDは絶版のものが多く、中古がその作品を買える唯一の道になる。

実測（2026-09-04・岸明日香 写真集）:

    全体 19件 / condition=used 10件
    ブックオフ1号館・2号館 ヤフーショッピング店 が並ぶ

1人あたりの検索も1回で済み、ページが広告だらけにもならない。

## リンクの包み方

**APIの `affiliate_type=vc` は効かなかった**（URLが素のまま返る。2026-09-04 実測）。
商品URLをそのまま持っておき、**バリューコマースの MyLink の形に包むのは
build-site.mjs 側**でやる。

    https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=<sid>&pid=<pid>&vc_url=<商品URL>

こうしておくと、提携先や pid が変わってもデータを取り直さずに済む。

## 誤爆を避ける

楽天と同じ。**商品名に出演者名が入っていないものは捨てる。**
ASCII だけの名前と3文字未満の名前は引かない（当たりすぎる）。

## 1日では取り切れない

**appid には上限がある。** 2026-09-04 の実測で、35分ほど（およそ2,000件強）で

    429 The AppID is denied: total count of AppID reached the URL's limit count.

が返るようになった。9,000人ぶんは1回では終わらない。

**応答が無かった人は「済み」にしない**ので、日を分けて流せば続きから埋まる。
埋まりきったあとの実行は、済みの人を読み飛ばすだけでAPIを叩かない。
取り直したいときだけ RESET=1 を付ける。

## 出力

  data/yahoo-works.json  出演者IDごとの中古商品（HITS 件まで）

環境変数:
  YAHOO_APP_ID  Yahoo! デベロッパーネットワークの Client ID
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

ENDPOINT = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch'
HITS = 4
PAUSE = 0.6
# これだけ続けてAPIが答えなかったら切り上げる（1日の上限に当たった見込み）
MAX_MISSES = 20
AGENT = 'Mozilla/5.0 (compatible; gravure-meikan.jp/1.0)'

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'data' / 'gravure-actor-works.json'
OUT = ROOT / 'data' / 'yahoo-works.json'
STATE = ROOT / 'data' / 'yahoo-state.json'


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
            request = urllib.request.Request(url, headers={'User-Agent': AGENT})
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
    app_id = os.environ.get('YAHOO_APP_ID', '').strip()

    if not app_id:
        print('YAHOO_APP_ID が要ります。', file=sys.stderr)
        return 1

    actors = load(SOURCE).get('actors') or {}
    if not actors:
        print('出演者データがありません。先に fetch-gravure.py を走らせてください。', file=sys.stderr)
        return 1

    # 作品数の多い人から。見られるページから順に埋まる。
    people = sorted(((ident, (value.get('name') or '').strip(), value.get('n') or 0)
                     for ident, value in actors.items()), key=lambda row: -row[2])
    people = [row for row in people if searchable(row[1])]

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(STATE)
    found = ({} if reset else load(OUT).get('actors', {}))
    done = set(state.get('done') or [])

    only = int(os.environ.get('ONLY') or 0)
    if only:
        people = people[:only]

    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    today = date.today()
    hits = 0
    misses = 0

    def save():
        STATE.write_text(json.dumps({'done': sorted(done), 'confirmedOn': today.isoformat()},
                                    ensure_ascii=False), encoding='utf-8')
        OUT.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'source': 'Yahoo!ショッピング商品検索API（中古）',
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

        query = urllib.parse.urlencode({
            'appid': app_id,
            'query': f'{name} 写真集',
            'condition': 'used',
            'results': HITS,
            'in_stock': 'true',
            'image_size': 300,
        })
        payload = fetch(f'{ENDPOINT}?{query}')
        time.sleep(PAUSE)

        # **応答が無いときは「済み」にしない。**
        # 済みにすると、次に流したときこの人は飛ばされ、永久に空のままになる。
        # 商品が無いのと、APIが答えなかったのは別のこと。
        if not payload:
            misses += 1
            if misses >= MAX_MISSES:
                print(f'APIが{MAX_MISSES}回続けて応答しないので切り上げます。'
                      '（1日の上限に当たった可能性があります）', file=sys.stderr)
                save()
                return 0
            continue

        misses = 0
        items = []
        for item in payload.get('hits') or []:
            title = str(item.get('name') or '').strip()
            url = str(item.get('url') or '').strip()

            # **商品名に名前が入っていないものは捨てる。** 同名の別人や
            # 無関係な商品が混ざるのを防ぐ。
            if not title or not url or name not in title:
                continue

            # APIが used と言っているものだけ。こちらでは判断しない。
            if str(item.get('condition') or '') != 'used':
                continue

            image = (item.get('image') or {}).get('medium') or ''

            items.append({
                't': title,
                'u': url,
                'i': image,
                'p': item.get('price'),
                's': str((item.get('seller') or {}).get('name') or '').strip(),
            })

        if items:
            found[ident] = {'name': name, 'u': items}
            hits += 1

        done.add(ident)

        if index % 50 == 0:
            print(f'  {index:,}/{len(people):,}人  中古が見つかった人 {hits:,}', file=sys.stderr)
            save()

    save()
    print(f'\n{len(people):,}人を見て、中古が見つかったのは {len(found):,}人', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
