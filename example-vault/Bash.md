# Bash

Fresh `bash -c` process per cell — **no state persists between cells** (by design).

## 1. Plain output — expect `hello from bash`

```bash
echo "hello from bash"
```

## 2. Pipeline — expect `3`

```bash
printf "a\nb\nc\n" | wc -l | tr -d ' '
```

## 3. stderr — expect `something went to stderr` in red

```bash
echo "something went to stderr" >&2
```

## 4. Mixed stdout/stderr — expect `out` normal and `err` red

```bash
echo "out"
echo "err" >&2
```

## 5. Failing command — expect a red `No such file or directory` error (cell still completes)

```bash
ls /definitely/not/a/real/path
```

## 6. No persistent state — define a variable here…

```bash
MY_VAR="i will not survive"
```

## 7. …expect `MY_VAR is: unset` (fresh process per cell)

```bash
echo "MY_VAR is: ${MY_VAR:-unset}"
```

## 8. `sh` alias — expect `alias works`

```sh
echo "alias works"
```

## 9. `shell` alias — expect `this one too`

```shell
echo "this one too"
```

## 10. PATH augmentation — expect a path (Homebrew/usr-local dirs are added for GUI-launched Obsidian)

```bash
which python3 || echo "python3 not found"
```
