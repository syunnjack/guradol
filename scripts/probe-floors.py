"""DMM.com（一般）にどのフロアがあるかを調べる。**見るだけで何も書かない。**

いまは ebook/photo と mono/dvd の2フロアしか見ていない。
一般側にほかにグラビアを扱うフロアがあれば、同じ人の作品を増やせるし、
DMM のなかで買える先が1つ増える（配信とパッケージは別物）。

FloorList でフロアの一覧を取り、そのフロアで「グラビア」を引いて
件数と、iteminfo に actor が入っているかを見る。**actor が無いフロアは
出演者に結びつけられないので使えない。**

    python scripts/probe-floors.py

環境変数: FANZA_API_ID / FANZA_AFFILIATE_ID
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = 'https://api.dmm.com/affiliate/v3'
PAUSE = 0.5


def call(path: str, params: dict) -> dict:
    url = f'{BASE}/{path}?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return json.loads(response.read().decode('utf-8', 'replace'))
    except Exception as error:
        print(f'    {error}', file=sys.stderr)
        return {}


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id, 'output': 'json'}

    payload = call('FloorList', cred)
    floors = payload.get('result', {}).get('site') or []

    if not floors:
        print('FloorList の応答:', json.dumps(payload, ensure_ascii=False)[:800])
        return 1

    print('サイト:', [(s.get('name'), s.get('code')) for s in floors])

    for site in floors:
        if 'FANZA' in str(site.get('name')) or 'FANZA' in str(site.get('code')):
            continue

        print(f"=== {site.get('name')}（{site.get('code')}）")

        for service in site.get('service') or []:
            for floor in service.get('floor') or []:
                scode, fcode = service.get('code'), floor.get('code')
                label = f"{service.get('name')} / {floor.get('name')}"

                for keyword in ('グラビア', ''):
                    payload = call('ItemList', dict(
                        cred, site='DMM.com', service=scode, floor=fcode,
                        hits=5, offset=1, sort='date',
                        **({'keyword': keyword} if keyword else {}),
                    )).get('result', {})
                    time.sleep(PAUSE)

                    total = int(payload.get('total_count') or 0)
                    items = payload.get('items') or []

                    if not items:
                        if keyword:
                            continue
                        print(f'  {scode}/{fcode:<14} {label}  件数0')
                        break

                    with_actor = sum(1 for i in items if (i.get('iteminfo') or {}).get('actor'))
                    sample = str((items[0].get('title') or ''))[:34]
                    mark = 'グラビア' if keyword else '全体'
                    print(f'  {scode}/{fcode:<14} {label}')
                    print(f'      {mark} {total:>8,}件  actorあり {with_actor}/{len(items)}  例: {sample}')

                    if keyword:
                        break

    # actor が見当たらなかったフロアで、iteminfo に何が入っているかを見る。
    # **別のキーに出演者が入っているなら使える。**
    for scode, fcode in (('dmmtv', 'dmmtv_video'), ('mono', 'book'), ('ebook', 'comic')):
        payload = call('ItemList', dict(
            cred, site='DMM.com', service=scode, floor=fcode,
            hits=8, offset=1, sort='date', keyword='グラビア',
        )).get('result', {})
        time.sleep(PAUSE)

        print()
        print(f'--- {scode}/{fcode} の iteminfo')
        for item in (payload.get('items') or [])[:8]:
            info = item.get('iteminfo') or {}
            shown = {k: [str(x.get('name')) for x in v][:3] for k, v in info.items() if isinstance(v, list)}
            print(f"   {str(item.get('title'))[:30]}")
            print(f"      {json.dumps(shown, ensure_ascii=False)[:220]}")

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
