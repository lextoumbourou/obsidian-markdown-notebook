---
notebook:
  readyTimeout: 5000
---

# Background Processes

This note tests both background readiness modes. Click **Run all cells**. It
waits for each background process to become ready before it runs the next cell.

## 1. Wait for a TCP port

The server deliberately waits two seconds before it binds the port. The client
cell must still succeed.

```python {background=example-server ready=port:18765}
import time
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

time.sleep(2)
HTTPServer(("127.0.0.1", 18765), Handler).serve_forever()
```

## 2. Call the ready server

```python
from urllib.request import urlopen

urlopen("http://127.0.0.1:18765").read().decode()
```

The result must be `Hello from a background cell`.

## 3. Wait for literal output

This worker writes its readiness message in two stdout chunks, with stderr
between them. It tests quoted arguments, chunk boundaries and separate stream
matching.

```python {background=example-worker ready="Worker ready" context=none}
import sys
import time

sys.stdout.write("Worker ")
sys.stdout.flush()
sys.stderr.write("Worker is starting...\n")
sys.stderr.flush()
time.sleep(1)
sys.stdout.write("ready\n")
sys.stdout.flush()

while True:
    time.sleep(1)
```

## 4. Confirm Run All continued

```python
print("Run All waited for both background processes.")
```

Click **Stop** on both background cells when you finish. The same
`background=<name>` argument also works on JavaScript, Bash and R cells.
