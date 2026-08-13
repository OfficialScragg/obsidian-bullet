# Tests

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

## Icons

`icons.test.html` renders every icon through the real `bulletIcon` and checks
each one produces an actual shape. It exists because the priority star was
added as bare path data rather than markup, which sets text inside the SVG and
draws nothing — invisible in the plugin while the preview harness, which had
its own copy of the star, looked fine.

```bash
npx esbuild src/icons.ts --bundle --format=esm --outfile=test/icons.mjs
open test/icons.test.html
```

## Logic tests

Plain node, no browser. Bundle the module beside the test, then run it:

```bash
npx esbuild src/date.ts      --bundle --format=esm --platform=node --outfile=test/date.mjs
npx esbuild src/serialize.ts --bundle --format=esm --platform=node --external:obsidian --outfile=test/bundle.mjs
node test/time.test.mjs        # time parsing and meeting order
node test/date.test.mjs        # ISO weeks and filenames
node test/serialize.test.mjs   # note round-tripping
```
