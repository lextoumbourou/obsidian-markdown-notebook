---
notebook:
  format: image
  media: attachments
  markdownLinks: true
---

# Frontmatter Defaults

This note sets document-level defaults: every cell renders to an image by default, images are saved to the `attachments/` folder (created on first run), and links use standard Markdown syntax. Precedence: plugin settings → frontmatter → cell args.

## 1. Frontmatter format + media + markdown links — expect `![](attachments/<hash>.png)` showing the table as an image (no `../` in the path — this note is at the vault root)

```python
import pandas as pd
pd.DataFrame({"setting": ["format", "media", "markdownLinks"], "value": ["image", "attachments", "true"]})
```

## 2. Plot with stable id — expect `![](attachments/fm-plot.png)`

```python {id=fm-plot}
import matplotlib.pyplot as plt
plt.plot([1, 4, 2, 8, 5])
plt.show()
```

## 3. Cell arg overrides frontmatter — expect an inline HTML table (no image file)

```python {format=html}
import pandas as pd
pd.DataFrame({"override": ["cell args beat frontmatter"]})
```
