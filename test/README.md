# Ink tests

`ink.test.html` drives the real `InkLayer` with synthetic pointer events and
checks that strokes are recorded, separated when the pen lifts, erased,
undone/redone, and round-tripped through the stored format unchanged. It also
prints the cost of a layout read versus a cached one.

Build the bundles it imports, then open it:

```bash
npx esbuild src/inklayer.ts --bundle --format=esm --outfile=test/inklayer.mjs
npx esbuild src/ink.ts      --bundle --format=esm --outfile=test/ink.mjs
open test/ink.test.html
```

Results appear at the top of the page. Headless, on macOS:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --allow-file-access-from-files --dump-dom \
  --virtual-time-budget=8000 "file://$PWD/test/ink.test.html"
```
