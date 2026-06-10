# R

Persistent R subprocess. Requires `knitr`, `jsonlite`, and `base64enc` for rich output; degrades to plain text without them.

## 1. Plain output — expect `answer: 42`

```r
x <- 40 + 2
cat("answer:", x, "\n")
```

## 2. Auto-print — expect `[1] 42` (visible result of last expression prints)

```r
x
```

## 3. Data frame — expect a rendered HTML table, not base64 text

```r
data.frame(name = c("Alice", "Bob"), score = c(92, 85))
```

## 4. Plot — expect an inline PNG (and no Rplots.pdf created anywhere)

```r
plot(1:10, main = "r plot")
```

## 5. Plot saved to vault — expect `![[r-plot.png]]` and the file next to this note

```r {format=image id=r-plot}
plot(cos, -pi, pi)
```

## 6. Message — expect `heads up from R` in red (R messages go to stderr)

```r
message("heads up from R")
```

## 7. Error — expect `Error: deliberate failure` in red (cell completes; kernel survives)

```r
stop("deliberate failure")
```

## 8. Kernel survived the error — expect `[1] 84` (`x` still defined)

```r
x * 2
```

> [!note] Known limitations
> Plots are captured per cell — you can't add to a previous cell's plot with `lines()`/`points()` in a later cell. If one cell draws multiple plots, only the last is kept.
