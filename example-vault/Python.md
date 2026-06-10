# Python

Persistent Python 3 subprocess. Variables survive between cells; the `[N]` badge increments per execution and resets on kernel restart.

> [!note] Requirements
> Cells 5–8 need `pandas` and `matplotlib`. Set the Python path in plugin settings to an interpreter that has them — settings are stored in this vault's gitignored `data.json`, so they survive resets.

## 1. Plain output — expect `hello from python`

```python
print("hello from python")
```

## 2. Expression display — expect `4` (last expression auto-displays, Jupyter-style)

```python
2 + 2
```

## 3. Define state for the next cell — expect no output

```python
counter = 41
```

## 4. Use state from the previous cell — expect `42`

```python
counter + 1
```

## 5. DataFrame — expect a rendered HTML table, not plain text

```python
import pandas as pd
pd.DataFrame({"name": ["Alice", "Bob"], "score": [92, 85]})
```

## 6. Matplotlib — expect an inline PNG plot

```python
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [2, 4, 9])
plt.title("python plot")
plt.show()
```

## 7. Plot saved to vault — expect `![[python-plot.png]]` and the file next to this note

```python {format=image id=python-plot}
import matplotlib.pyplot as plt
plt.plot([3, 1, 4, 1, 5])
plt.show()
```

## 8. Non-plot output as image — expect the table below rendered to a PNG file (browser fallback)

```python {format=image id=python-table}
import pandas as pd
pd.DataFrame({"x": [1, 2, 3], "y": ["a", "b", "c"]})
```

## 9. stderr — expect `warning: something looks off` in red, with no `>>>` or `...` prompt prefixes

```python
import sys
print("warning: something looks off", file=sys.stderr)
```

## 10. Exception — expect a red `ZeroDivisionError` traceback (cell completes; kernel survives)

```python
1 / 0
```

## 11. Kernel survived the exception — expect `still alive 42`

```python
print("still alive", counter + 1)
```
