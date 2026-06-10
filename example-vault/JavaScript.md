# JavaScript

Persistent Node.js kernel using a shared `vm` context. **Synchronous code only** — output from `setTimeout`/promises is not captured.

## 1. Plain output — expect `hello from node`

```javascript
console.log("hello from node");
```

## 2. Expression display — expect pretty-printed JSON `{ "a": 1, "b": 2 }`

```javascript
const obj = { a: 1, b: 2 };
obj
```

## 3. Define state for the next cell — expect no output

```javascript
let total = 40;
```

## 4. Use state from the previous cell — expect `42`

```javascript
total + 2
```

## 5. `js` alias — expect `alias works`

```js
console.log("alias works");
```

## 6. Error — expect a red `TypeError` stack trace (cell completes; kernel survives)

```javascript
null.someProperty
```

## 7. Kernel survived the error — expect `42` (`total` still defined)

```javascript
total + 2
```

## 8. Node builtins available — expect a version string like `v22.x.x`

```javascript
process.version
```
