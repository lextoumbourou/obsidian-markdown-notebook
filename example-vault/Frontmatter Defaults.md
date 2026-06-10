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
<!-- nb-output hash="1e08eaff3efc0788" format="image" -->
![](../../attachments/1e08eaff3efc0788.png)
<!-- /nb-output -->

## 2. Plot with stable id — expect `![](attachments/fm-plot.png)`

```python {id=fm-plot}
import matplotlib.pyplot as plt
plt.plot([1, 4, 2, 8, 5])
plt.show()
```
<!-- nb-output id="fm-plot" hash="5a4af7189d20337e" format="image" -->
![](../../attachments/fm-plot.png)
<!-- /nb-output -->

## 3. Cell arg overrides frontmatter — expect an inline HTML table (no image file)

```python {format=html}
import pandas as pd
pd.DataFrame({"override": ["cell args beat frontmatter"]})
```
<!-- nb-output hash="9898a2e42f7e6d17" format="html" -->
<div class="nb-output">
<div class="nb-output-html"><div>
<style>.dataframe tbody tr th:only-of-type { vertical-align: middle; } .dataframe tbody tr th { vertical-align: top; } .dataframe thead th { text-align: right; }</style>
<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">
      <th></th>
      <th>override</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>0</th>
      <td>cell args beat frontmatter</td>
    </tr>
  </tbody>
</table>
</div></div>
</div>
<!-- /nb-output -->
