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
<!-- nb-output hash="09596b4b2c51d1c4" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stderr">Execution timed out after 2000ms</pre>
</div>
<!-- /nb-output -->

## 2. Recovery — run immediately after cell 1; expect `python recovered` (the timed-out cell is interrupted, no stale output leaks in, no kernel restart needed)

```python
print("python recovered")
```
<!-- nb-output hash="a7606af622be120f" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">python recovered

</pre>
</div>
<!-- /nb-output -->

## 3. Bash sleep — expect a ⏱ timeout block after ~2s

```bash
sleep 10 && echo "you should never see this"
```
<!-- nb-output hash="83efa45a94aff008" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stderr">Execution timed out after 2000ms</pre>
</div>
<!-- /nb-output -->

## 4. Recovery — expect `bash recovered`

```bash
echo "bash recovered"
```
<!-- nb-output hash="5a64e3c2ec8345f7" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">bash recovered
</pre>
</div>
<!-- /nb-output -->

## 5. R sleep — expect a ⏱ timeout block after ~2s

```r
Sys.sleep(10)
cat("you should never see this\n")
```
<!-- nb-output hash="cad626d1eb094ac3" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stderr">Execution timed out after 2000ms</pre>
</div>
<!-- /nb-output -->

## 6. Recovery — expect `r recovered`

```r
cat("r recovered\n")
```
<!-- nb-output hash="f2eea077f46e1cf4" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">r recovered

</pre>
</div>
<!-- /nb-output -->

## 7. JavaScript busy loop — expect a ⏱ timeout block after ~2s

```javascript
while (true) {}
```
<!-- nb-output hash="1a7d6952d0704c8b" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stderr">Execution timed out after 2000ms</pre>
</div>
<!-- /nb-output -->

## 8. Recovery — expect `js recovered` (note: the JS kernel restarts after a timeout, so earlier JS state is lost — this is documented behavior)

```javascript
console.log("js recovered");
```
<!-- nb-output hash="ef51bd7b49c44430" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">js recovered

</pre>
</div>
<!-- /nb-output -->

## 9. Concurrency — click Run on cells 1, 3, 5, and 7 in quick succession while each is still running; expect every output to land under its own cell, with no blocks inside fences or under the wrong cell
