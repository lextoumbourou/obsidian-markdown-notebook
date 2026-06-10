---
notebook:
  timeout: 2000
---

# Timeouts

This note sets `notebook.timeout: 2000` in frontmatter, overriding the plugin setting for every cell here. Each slow cell should produce an orange **⏱ Execution timed out after 2s** block — *not* a red "Execution failed".

## 1. Python sleep — expect a ⏱ timeout block after ~2s

```python
import time
time.sleep(10)
print("you should never see this")
```

## 2. Recovery — run immediately after cell 1; expect `python recovered` (the timed-out cell is interrupted, no stale output leaks in, no kernel restart needed)

```python
print("python recovered")
```

## 3. Bash sleep — expect a ⏱ timeout block after ~2s

```bash
sleep 10 && echo "you should never see this"
```

## 4. Recovery — expect `bash recovered`

```bash
echo "bash recovered"
```

## 5. R sleep — expect a ⏱ timeout block after ~2s

```r
Sys.sleep(10)
cat("you should never see this\n")
```

## 6. Recovery — expect `r recovered`

```r
cat("r recovered\n")
```

## 7. JavaScript busy loop — expect a ⏱ timeout block after ~2s

```javascript
while (true) {}
```

## 8. Recovery — expect `js recovered` (note: the JS kernel restarts after a timeout, so earlier JS state is lost — this is documented behavior)

```javascript
console.log("js recovered");
```

## 9. Concurrency — click Run on cells 1, 3, 5, and 7 in quick succession while each is still running; expect every output to land under its own cell, with no blocks inside fences or under the wrong cell
