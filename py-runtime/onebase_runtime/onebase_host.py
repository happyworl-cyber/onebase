"""OneBase Python workflow host API.

IPC is newline-delimited JSON over the Unix-domain socket named by
``ONEBASE_HOST_SOCK``. Each request is ``{id, op, args}`` and receives exactly
one ``{id, ok, result|error}`` response line. This mirrors the JavaScript host
runtime (``js-runtime/onebase-runtime/index.js``) so both languages share the
same Rust ``js_host_bridge`` and therefore the same secret / SSRF policy.

Python has a synchronous Unix-socket client, so unlike the Node runtime no
per-call helper subprocess is needed.
"""

import json as _json
import os as _os
import socket as _socket
from types import SimpleNamespace

_next_id = 0


def _call(op, args=None):
    global _next_id
    sock_path = _os.environ.get("ONEBASE_HOST_SOCK")
    if not sock_path:
        raise RuntimeError("ONEBASE_HOST_SOCK is not configured")
    _next_id += 1
    request = {"id": str(_next_id), "op": op, "args": args or {}}
    conn = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    try:
        conn.connect(sock_path)
        conn.sendall((_json.dumps(request) + "\n").encode("utf-8"))
        buffer = b""
        while b"\n" not in buffer:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buffer += chunk
    finally:
        conn.close()
    line = buffer.split(b"\n", 1)[0]
    try:
        response = _json.loads(line.decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - surface parse errors to the node
        raise RuntimeError("OneBase host returned invalid JSON: %s" % error)
    if not response.get("ok"):
        raise RuntimeError(
            response.get("error") or ("OneBase host operation failed: %s" % op)
        )
    return response.get("result")


def _request(method, url, body_or_options=None, maybe_options=None):
    has_body = method in ("post", "put")
    body = body_or_options if has_body else None
    options = maybe_options if has_body else body_or_options
    args = {"url": url}
    if body is not None:
        args["body"] = body
    if options:
        if options.get("headers") is not None:
            args["headers"] = options["headers"]
        if options.get("timeout") is not None:
            args["timeout"] = options["timeout"]
    return _call("http.%s" % method, args)


env = SimpleNamespace(get=lambda key: _call("env.get", {"key": key}))

http = SimpleNamespace(
    get=lambda url, options=None: _request("get", url, options),
    post=lambda url, body=None, options=None: _request("post", url, body, options),
    put=lambda url, body=None, options=None: _request("put", url, body, options),
    delete=lambda url, options=None: _request("delete", url, options),
)

crypto = SimpleNamespace(
    sha256=lambda value: _call("crypto.sha256", {"input": value}),
    hmac_sha256=lambda key, data: _call("crypto.hmac_sha256", {"key": key, "data": data}),
    uuid=lambda: _call("crypto.uuid", {}),
    base64_encode=lambda value: _call("crypto.base64_encode", {"input": value}),
    base64_decode=lambda value: _call("crypto.base64_decode", {"input": value}),
)

log = SimpleNamespace(
    info=lambda message: _call("log.info", {"message": message}),
    warn=lambda message: _call("log.warn", {"message": message}),
    error=lambda message: _call("log.error", {"message": message}),
    debug=lambda message: _call("log.debug", {"message": message}),
)

json = SimpleNamespace(
    encode=lambda value: _call("json.encode", {"value": value}),
    encode_pretty=lambda value: _call("json.encode_pretty", {"value": value}),
    decode=lambda value: _call("json.decode", {"input": value}),
)

time = SimpleNamespace(
    now=lambda: _call("time.now", {}),
    now_ms=lambda: _call("time.now_ms", {}),
)

sse = SimpleNamespace(
    publish=lambda topic, event=None, data=None: _call(
        "sse.publish", {"topic": topic, "event": event, "data": data}
    )
)

google = SimpleNamespace(
    sa_assertion=lambda project, scope: _call(
        "google.sa_assertion", {"project": project, "scope": scope}
    )
)
