#!/usr/bin/env python3
"""Minimal Onebase Provisioner Webhook mock for local integration tests.

Usage:
  python3 mock_server.py
  # listens on http://127.0.0.1:9090

  # 模拟异步 Terraform（202 + poll）：
  MOCK_ASYNC=1 python3 mock_server.py
  # 或在开通时 slug 以 async- 开头

Configure Onebase:
  PROVISION_WEBHOOK_URL=http://127.0.0.1:9090/provision
  PROVISION_WEBHOOK_DEPROVISION_URL=http://127.0.0.1:9090/deprovision
  PROVISION_WEBHOOK_TOKEN=dev-token   # optional
  PROVISION_WEBHOOK_POLL_INTERVAL_SECS=2
  PROVISION_WEBHOOK_POLL_MAX_SECS=120
"""

from __future__ import annotations

import json
import os
import secrets
import string
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

HOST = "127.0.0.1"
PORT = 9090
EXPECTED_TOKEN = "dev-token"
ASYNC_MODE = os.environ.get("MOCK_ASYNC", "").strip().lower() in ("1", "true", "yes")
POLLS_NEEDED = int(os.environ.get("MOCK_ASYNC_POLLS", "3"))

# provision_id -> job state
JOBS: dict[str, dict[str, Any]] = {}


def _random_password(length: int = 24) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _build_success_payload(slug: str, requested: list[Any]) -> dict[str, Any]:
    db_name = slug.replace("-", "_")
    provision_id = f"prov_{slug}"
    password = _random_password()
    want_redis = "redis" in [str(x).lower() for x in requested]

    payload: dict[str, Any] = {
        "status": "succeeded",
        "provision_id": provision_id,
        "postgresql": {
            "host": "127.0.0.1",
            "port": 5432,
            "database": db_name,
            "user": f"{db_name}_app",
            "password": password,
        },
        "env_vars": {},
    }
    if want_redis:
        redis_pass = _random_password(16)
        redis_url = f"redis://:{redis_pass}@127.0.0.1:6379/0"
        payload["redis"] = {"url": redis_url}
        payload["env_vars"] = {"REDIS_URL": redis_url}
    return payload


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[mock-provisioner] {self.address_string()} - {fmt % args}")

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _auth_ok(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth:
            return True
        return auth == f"Bearer {EXPECTED_TOKEN}"

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        if not self._auth_ok():
            self._send_json(401, {"error": "invalid token"})
            return

        body = self._read_json()
        path = self.path.rstrip("/")
        action = body.get("action")

        if action == "ping":
            self._send_json(200, {"ok": True, "message": "pong"})
            return

        if action == "poll":
            provision_id = str(body.get("provision_id", ""))
            job = JOBS.get(provision_id)
            if not job:
                self._send_json(404, {"status": "failed", "error": f"unknown provision_id {provision_id}"})
                return
            job["polls"] += 1
            if job["polls"] < job["polls_needed"]:
                self._send_json(
                    200,
                    {
                        "status": "pending",
                        "provision_id": provision_id,
                        "message": f"terraform apply ({job['polls']}/{job['polls_needed']})",
                        "poll_after_secs": 2,
                    },
                )
                print(f"poll pending {provision_id} ({job['polls']}/{job['polls_needed']})")
                return
            slug = job["slug"]
            requested = job["requested"]
            del JOBS[provision_id]
            payload = _build_success_payload(slug, requested)
            self._send_json(200, payload)
            print(f"poll succeeded slug={slug} provision_id={provision_id}")
            return

        if path.endswith("/provision"):
            slug = str(body.get("slug", "unknown"))
            provision_id = f"prov_{slug}"
            requested = body.get("requested_resources") or ["postgresql"]
            if not isinstance(requested, list):
                requested = ["postgresql"]

            use_async = ASYNC_MODE or slug.startswith("async-")
            if use_async:
                JOBS[provision_id] = {
                    "slug": slug,
                    "requested": requested,
                    "polls": 0,
                    "polls_needed": POLLS_NEEDED,
                }
                self._send_json(
                    202,
                    {
                        "status": "pending",
                        "provision_id": provision_id,
                        "message": "terraform apply started",
                        "poll_after_secs": 2,
                    },
                )
                print(f"provision async accepted slug={slug} provision_id={provision_id}")
                return

            payload = _build_success_payload(slug, requested)
            self._send_json(201, payload)
            print(f"provision sync ok slug={slug} provision_id={provision_id}")
            return

        if path.endswith("/deprovision"):
            slug = body.get("slug")
            provision_id = body.get("provision_id")
            if provision_id:
                JOBS.pop(str(provision_id), None)
            self._send_json(200, {"ok": True, "slug": slug, "provision_id": provision_id})
            print(f"deprovision ok slug={slug} provision_id={provision_id}")
            return

        self._send_json(404, {"error": f"unknown path {self.path}"})


def main() -> None:
    server = HTTPServer((HOST, PORT), Handler)
    print(f"Mock Provisioner listening on http://{HOST}:{PORT}")
    print(f"  MOCK_ASYNC={ASYNC_MODE} (polls_needed={POLLS_NEEDED})")
    print("  POST /provision  (action=provision)")
    print("  POST /provision  (action=poll)")
    print("  POST /deprovision")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.server_close()


if __name__ == "__main__":
    main()
