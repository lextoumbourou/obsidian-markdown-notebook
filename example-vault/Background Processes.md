# Background Processes

This note starts a server in a separate Python process. Its Run button becomes Stop, and Run All continues to the client cell without waiting for the server to exit.

## 1. Start the server

```python {background=example-server}
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"Hello from a background cell"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass

HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
```

## 2. Call it from the normal notebook kernel

```python
from urllib.request import urlopen

urlopen("http://127.0.0.1:8765").read().decode()
```

Click **Stop** on the first cell when you finish. The same `background=<name>` argument also works on JavaScript, Bash, and R cells.
