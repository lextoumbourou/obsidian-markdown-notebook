# JavaScript

Persistent Node.js kernel using a shared `vm` context. **Synchronous code only** — output from `setTimeout`/promises is not captured.

## 1. Plain output — expect `hello from node`

```javascript
console.log("hello from node");
```
<!-- nb-output hash="c9b03e3b073fc0d8" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">hello from node
</pre>
</div>
<!-- /nb-output -->

## 2. Expression display — expect pretty-printed JSON `{ "a": 1, "b": 2 }`

```javascript
const obj = { a: 1, b: 2 };
obj
```
<!-- nb-output hash="9e040d2170d97f8c" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">{
  &quot;a&quot;: 1,
  &quot;b&quot;: 2
}
</pre>
</div>
<!-- /nb-output -->

## 3. Define state for the next cell — expect no output

```javascript
let total = 40;
```
<!-- nb-output hash="c7d91289db335b0c" format="html" -->

<!-- /nb-output -->

## 4. Use state from the previous cell — expect `42`

```javascript
total + 2
```
<!-- nb-output hash="6d6417395f206c3a" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">42
</pre>
</div>
<!-- /nb-output -->

## 5. `js` alias — expect `alias works`

```js
console.log("alias works");
```
<!-- nb-output hash="8da54a3bcceb529d" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">alias works
</pre>
</div>
<!-- /nb-output -->

## 6. Error — expect a red `TypeError` stack trace (cell completes; kernel survives)

```javascript
null.someProperty
```
<!-- nb-output hash="ead953929377e631" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stderr">evalmachine.&lt;anonymous&gt;:1
null.someProperty
     ^

TypeError: Cannot read properties of null (reading 'someProperty')
    at evalmachine.&lt;anonymous&gt;:1:6
    at Script.runInContext (node:vm:149:12)
    at Object.runInContext (node:vm:301:6)
    at Socket.&lt;anonymous&gt; (/private/var/folders/m9/jlntzhk17ms42d1rwzzkrmzm0000gn/T/nb_node_1781070994717.js:34:25)
    at Socket.emit (node:events:508:28)
    at addChunk (node:internal/streams/readable:559:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:510:3)
    at Readable.push (node:internal/streams/readable:390:5)
    at Pipe.onStreamRead (node:internal/stream_base_commons:189:23)
</pre>
</div>
<!-- /nb-output -->

## 7. Kernel survived the error — expect `42` (`total` still defined)

```javascript
total + 2
```
<!-- nb-output hash="6d6417395f206c3a" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">42
</pre>
</div>
<!-- /nb-output -->

## 8. Node builtins available — expect a version string like `v22.x.x`

```javascript
process.version
```
<!-- nb-output hash="2ec3e9c850584db8" format="html" -->
<div class="nb-output">
<pre class="nb-stream-stdout">v24.12.0
</pre>
</div>
<!-- /nb-output -->
