"""iteminfo.actor に読み仮名が入るかを見るだけ。何も書き換えない。"""
import json, os, urllib.parse, urllib.request

cred = {'api_id': os.environ['FANZA_API_ID'],
        'affiliate_id': os.environ['FANZA_AFFILIATE_ID'], 'output': 'json'}
url = 'https://api.dmm.com/affiliate/v3/ItemList?' + urllib.parse.urlencode(dict(
    cred, site='DMM.com', service='ebook', floor='photo', hits=3, offset=1, sort='date'))

with urllib.request.urlopen(url, timeout=60) as response:
    result = json.loads(response.read().decode('utf-8', 'replace')).get('result', {})

for item in result.get('items') or []:
    info = item.get('iteminfo') or {}
    print(json.dumps({'title': item.get('title'),
                      'actor': info.get('actor'),
                      'author': info.get('author')}, ensure_ascii=False, indent=1))
