# Bash

Fresh `bash -c` process per cell — **no state persists between cells** (by design).

## 1. Plain output — expect `hello from bash`

```bash
echo "hello from bash"
```
<!-- nb-output hash="ffb2826e241b4e2a" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">hello from bash
</pre>
</div>
<!-- /nb-output -->

## 2. Pipeline — expect `3`

```bash
printf "a\nb\nc\n" | wc -l | tr -d ' '
```
<!-- nb-output hash="a480e81a5027d338" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">3
</pre>
</div>
<!-- /nb-output -->

## 3. stderr — expect `something went to stderr` in red

```bash
echo "something went to stderr" >&2
```
<!-- nb-output hash="96ac8edba6870df7" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stderr">something went to stderr
</pre>
</div>
<!-- /nb-output -->

## 4. Mixed stdout/stderr — expect `out` normal and `err` red

```bash
echo "out"
echo "err" >&2
```
<!-- nb-output hash="9be1def3315fdd3c" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">out
</pre>
<pre class="nb-stream-stderr">err
</pre>
</div>
<!-- /nb-output -->

## 5. Failing command — expect a failed status with the red stderr and exit code persisted

```bash
ls /definitely/not/a/real/path
```
<!-- nb-output hash="cd893297b7271237" format="html" status="error" -->
<div class="nb-status-error">Execution failed</div>
<div class="nb-output">
<pre class="nb-stream-stderr">ls: /definitely/not/a/real/path: No such file or directory
</pre>
<pre class="nb-stream-stderr">Shell process exited with code 1
</pre>
</div>
<!-- /nb-output -->

## 6. No persistent state — define a variable here…

```bash
MY_VAR="i will not survive"
```
<!-- nb-output hash="cb251e07d6620f0c" format="html" -->

<!-- /nb-output -->

## 7. …expect `MY_VAR is: unset` (fresh process per cell)

```bash
echo "MY_VAR is: ${MY_VAR:-unset}"
```
<!-- nb-output hash="80085b672b0eb4c6" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">MY_VAR is: unset
</pre>
</div>
<!-- /nb-output -->

## 8. `sh` alias — expect `alias works`

```sh
echo "alias works"
```
<!-- nb-output hash="a1673818a48c8d3f" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">alias works
</pre>
</div>
<!-- /nb-output -->

## 9. `shell` alias — expect `this one too`

```shell
echo "this one too"
```
<!-- nb-output hash="3322def58498f5be" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">this one too
</pre>
</div>
<!-- /nb-output -->

## 10. PATH augmentation — expect a path (Homebrew/usr-local dirs are added for GUI-launched Obsidian)

```bash
which python3 || echo "python3 not found"
```
<!-- nb-output hash="2c032c4333c655d3" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">/usr/local/bin/python3
</pre>
</div>
<!-- /nb-output -->
