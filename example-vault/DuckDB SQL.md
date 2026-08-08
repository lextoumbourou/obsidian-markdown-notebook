# DuckDB SQL

Install the DuckDB CLI (`brew install duckdb` on macOS), then click **Run all
cells**. SQL cells share one in-memory DuckDB session for this note.

## 1. Create session state

```sql
CREATE OR REPLACE TEMP TABLE sales AS
SELECT * FROM (VALUES
    ('books', 12.50),
    ('coffee', 4.25),
    ('books', 8.00)
) AS t(category, amount);
```
<!-- nb-output hash="c371b761059e6bf6" format="html" -->

<!-- /nb-output -->

## 2. Query the temporary table

```sql
SELECT category, round(sum(amount), 2) AS total
FROM sales
GROUP BY category
ORDER BY total DESC;
```
<!-- nb-output hash="f578b306c855a172" format="html" -->
<div class="nb-output">
<div class="nb-output-html"><table class="nb-table"><tr><th>category</th>
<th>total</th>
</tr>
<tr><td>books</td>
<td>20.50</td>
</tr>
<tr><td>coffee</td>
<td>4.25</td>
</tr></table></div>
</div>
<!-- /nb-output -->

The result should render as an HTML table. This cell proves that temporary
tables persist between SQL cells.

## 3. Create and reuse a macro

```sql
CREATE OR REPLACE MACRO with_tax(value) AS round(value * 1.1, 2);
```
<!-- nb-output hash="3139cea3a8844ed7" format="html" -->

<!-- /nb-output -->

```duckdb
SELECT category, with_tax(sum(amount)) AS total_with_tax
FROM sales
GROUP BY category
ORDER BY total_with_tax DESC;
```
<!-- nb-output hash="0f8d700ca9de0bf3" format="html" -->
<div class="nb-output">
<div class="nb-output-html"><table class="nb-table"><tr><th>category</th>
<th>total_with_tax</th>
</tr>
<tr><td>books</td>
<td>22.55</td>
</tr>
<tr><td>coffee</td>
<td>4.68</td>
</tr></table></div>
</div>
<!-- /nb-output -->

`duckdb` is an alias for the `sql` fence language.

## 4. Query a file relative to this note

```sql
SELECT species, sum(seen) AS sightings
FROM read_csv_auto('data/duckdb-birds.csv')
GROUP BY species
ORDER BY sightings DESC;
```
<!-- nb-output hash="f12fe55e4496477c" format="html" -->
<div class="nb-output">
<div class="nb-output-html"><table class="nb-table"><tr><th>species</th>
<th>sightings</th>
</tr>
<tr><td>duck</td>
<td>12</td>
</tr>
<tr><td>goose</td>
<td>3</td>
</tr>
<tr><td>heron</td>
<td>2</td>
</tr></table></div>
</div>
<!-- /nb-output -->

The final result should show 12 ducks, 3 geese and 2 herons.
