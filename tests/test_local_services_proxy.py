from __future__ import annotations

import json
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from run_web_tool import SpaHandler


class _FakeApi(BaseHTTPRequestHandler):
    def _reply(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        request_body = self.rfile.read(length).decode("utf-8") if length else ""
        payload = json.dumps({
            "path": self.path,
            "method": self.command,
            "body": request_body,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _reply
    do_POST = _reply

    def log_message(self, *_args) -> None:
        return


class LocalServicesProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.api = ThreadingHTTPServer(("127.0.0.1", 0), _FakeApi)
        SpaHandler.api_host = "127.0.0.1"
        SpaHandler.api_port = cls.api.server_port
        cls.web = ThreadingHTTPServer(("127.0.0.1", 0), SpaHandler)
        cls.threads = [
            threading.Thread(target=cls.api.serve_forever, daemon=True),
            threading.Thread(target=cls.web.serve_forever, daemon=True),
        ]
        for thread in cls.threads:
            thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.web.shutdown()
        cls.api.shutdown()
        cls.web.server_close()
        cls.api.server_close()

    def test_get_api_request_is_proxied_as_json(self) -> None:
        url = f"http://127.0.0.1:{self.web.server_port}/api/v1/health?probe=1"
        with urllib.request.urlopen(url, timeout=5) as response:
            self.assertEqual(response.headers.get_content_type(), "application/json")
            payload = json.load(response)
        self.assertEqual(payload["path"], "/api/v1/health?probe=1")
        self.assertEqual(payload["method"], "GET")

    def test_post_body_is_forwarded(self) -> None:
        url = f"http://127.0.0.1:{self.web.server_port}/api/v1/cloud/reports"
        body = json.dumps({"name": "Regression"}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.load(response)
        self.assertEqual(json.loads(payload["body"]), {"name": "Regression"})
        self.assertEqual(payload["method"], "POST")


if __name__ == "__main__":
    unittest.main()
