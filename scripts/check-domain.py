"""ドメインとGitHub Pagesの状態を **見るだけ** の点検ツール。

このスクリプトは何も変更しない。読むだけ。

2026年9月に guradol.jp で失敗したときの経緯:
  証明書が発行されないので、カスタムドメインの再設定・解除・Pagesの再作成を
  5回以上繰り返した。GitHub は設定を変えるたびに「追加されたばかり」の状態へ
  戻すため、発行処理が毎回振り出しに戻っていた。さらに cname を空にする API を
  投げて Pages サイトごと消し、本番を10分落とした。

  **触るほど遠のく。** そのための点検ツール。状態を見て、次にやることだけを
  出す。実行しても何も壊れない。

使い方:
  python scripts/check-domain.py                 SITE_DOMAIN を見る
  python scripts/check-domain.py example.jp      指定したドメインを見る
"""
import json
import os
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

PAGES_IPS = {'185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'}
REPO = os.environ.get('GITHUB_REPOSITORY', 'syunnjack/guradol')


def dns_a(host: str) -> set:
    try:
        return {info[4][0] for info in socket.getaddrinfo(host, None, socket.AF_INET)}
    except OSError:
        return set()


def http_status(url: str) -> str:
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'domain-check/1.0'}, method='HEAD')
        with urllib.request.urlopen(request, timeout=20) as response:
            return str(response.status)
    except urllib.error.HTTPError as error:
        return str(error.code)
    except ssl.SSLError as error:
        return f'TLSエラー（{error.reason}）'
    except Exception as error:
        return f'つながらない（{type(error).__name__}）'


def pages_state() -> dict | None:
    try:
        out = subprocess.run(['gh', 'api', f'repos/{REPO}/pages'], capture_output=True, text=True, timeout=40)
        return json.loads(out.stdout) if out.returncode == 0 else None
    except Exception:
        return None


def main() -> None:
    domain = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('SITE_DOMAIN', 'gravure-meikan.jp')
    print(f'== {domain} ==\n')

    apex = dns_a(domain)
    print(f'DNS (A):  {", ".join(sorted(apex)) or "解決できない"}')
    dns_ok = apex and apex <= PAGES_IPS
    print(f'          {"GitHub Pages を向いている" if dns_ok else "GitHub Pages のIPではない"}')

    www = dns_a(f'www.{domain}')
    print(f'DNS www:  {"あり" if www else "なし"}（あってもなくてもよい）')

    print(f'HTTP:     {http_status(f"http://{domain}/")}')
    print(f'HTTPS:    {http_status(f"https://{domain}/")}')

    pages = pages_state()
    if pages is None:
        print('Pages:    取得できない（gh の認証を確認）')
    else:
        cert = (pages.get('https_certificate') or {}).get('state', 'なし')
        print(f'Pages:    cname={pages.get("cname")} / 証明書={cert} / HTTPS強制={pages.get("https_enforced")}')

    print('\n-- 次にやること --')
    if not dns_ok:
        print('DNSを GitHub Pages の4つのIPへ向ける。')
        for ip in sorted(PAGES_IPS):
            print(f'  A  @  {ip}')
        print('向けたら、権威サーバーに反映されるまで待つ。反映前にPagesを設定しない。')
        return

    if pages and not pages.get('cname'):
        print('GitHub の Settings → Pages でカスタムドメインを設定する（Web UIから。APIは使わない）。')
        return

    cert = (pages or {}).get('https_certificate', {}).get('state')
    if cert == 'approved':
        if not (pages or {}).get('https_enforced'):
            print('証明書は発行済み。Settings → Pages で Enforce HTTPS を有効にする。')
        else:
            print('設定は完了している。触らないこと。')
        return

    print('証明書は発行待ち。**ここで何もしないこと。**')
    print('カスタムドメインの再設定・解除・Pagesの再作成をすると、発行処理が振り出しに戻る。')
    print('数時間おきにこのスクリプトで見るだけにする。24時間を過ぎても変わらなければ、')
    print('Web UI から一度だけ削除・再入力し、その後は同じく触らない。')


if __name__ == '__main__':
    main()
