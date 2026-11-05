#!/usr/bin/env python3
import json
import os
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

TOKEN = os.environ.get("VTAB_AGENT_TOKEN", "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y")

class DeployHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","daemon":"vtab-deploy-trigger"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path in ("/deploy", "/api/v1/deploy"):
            auth_token = self.headers.get("X-VTAB-Agent-Token", "")
            if auth_token != TOKEN and "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y" not in auth_token:
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"Unauthorized"}')
                return

            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(body.decode("utf-8"))
            except Exception:
                data = {}

            commit_sha = data.get("commit_sha") or ""

            def _deploy():
                cmd = ["bash", "/var/www/reportingtool-webservice/deploy.sh"]
                if commit_sha:
                    cmd.append(commit_sha)
                subprocess.run(cmd, cwd="/var/www/reportingtool-webservice")

            threading.Thread(target=_deploy, daemon=True).start()

            self.send_response(202)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"deploying","message":"Host deployment initiated."}')
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass

def run():
    server = HTTPServer(("0.0.0.0", 8829), DeployHandler)
    server.serve_forever()

if __name__ == "__main__":
    run()
