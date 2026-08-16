#!/usr/bin/env python3
"""静的配信サーバ。テキスト系レスポンスに charset=utf-8 を必ず付ける。

Python 標準の `http.server` は .js/.css を charset 無しで返すため、ブラウザで
生ファイルを直接開くと日本語が文字化けして見える(実体は UTF-8 で正常)。
本スクリプトは charset を明示し、その混乱を防ぐ。使い方: `python3 serve.py [port]`。
"""
import sys
from http.server import SimpleHTTPRequestHandler, test

# 拡張子→Content-Type(charset付き)。text系は utf-8 を明示する。
CHARSET_TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
}


class Utf8Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **CHARSET_TYPES}

    def end_headers(self):
        # 編集の即時反映を妨げないよう、キャッシュを無効化(開発用途)。
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    test(HandlerClass=Utf8Handler, port=port, bind='127.0.0.1')
