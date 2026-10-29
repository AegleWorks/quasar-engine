# scan

Pushes a folder of userpages (`*.bbcode`) through Quasar and, optionally, osu!'s own pipeline, then
reports what is common. Built for thousands of pages; measured at ~450 pages/s on 6 jobs, plus ~13 s for
osu-web over 4,650 pages.

```sh
# from the monorepo root
node packages/quasar/scripts/scan/run.mjs --src ~/pages --out ~/.cache/scan/run.jsonl --osu
node packages/quasar/scripts/scan/report.mjs ~/.cache/scan/run.jsonl            # or --json
```

- `--osu` runs `~/Main Bridge/osu-harness/regenerate-goldens.sh` first (Docker), writing osu!'s HTML beside the
  output. `--goldens <dir>` uses goldens that already exist. With neither, pages are scanned without the osu!
  comparison.
- One JSON line per page: size, timings, diagnostics by code, tags used, and whether the osu! preview shows
  what osu! publishes (`match` / `diverges` / `osu-error` / `no-golden`). A divergence carries its first
  differing line, and `diffKind` is that line with the text elided so the same kind groups together.
- The output is appended to as pages finish and finished pages are skipped, so a killed run resumes. Delete the
  file to start over.
- A page that makes Quasar throw is recorded in `error`; one that makes osu-web throw, in `osuError`. Neither
  stops the run.
- The comparison is `Tests/support/visibleLines.ts`, the same one `OsuGoldens.test.ts` uses.

## severity — how bad each divergence is

```sh
node packages/quasar/scripts/scan/severity.mjs <out.jsonl> --src ~/pages --goldens ~/.cache/scan/goldens
node packages/quasar/scripts/scan/severity.mjs <out.jsonl> --src ~/pages --goldens <dir> --page osu/1234.bbcode
```

`report.mjs` counts divergences; this ranks them, because a missing word and a blank line are not the
same problem. Each page is reduced to change windows and each window to `content` / `structure` /
`style` / `spacing` (see `severity.ts`), then the pages are grouped by the SHAPE of the first
difference — one row is one cause, ordered by worst kind first and page count second, so a broken
list on 3 pages outranks a blank line on 40.

- `--page <name>` prints one page's windows with both sides' lines around each, which is what a
  minimal case for the harness gets built from.
- `knownCauses` labels the divergences already diagnosed and deliberately not reproduced
  (`.claude/rules/osu.md`), and the summary reports the ranking with and without them.
- `tags` in the scan output is a BRACKET HISTOGRAM, not a parse: difficulty names and song
  titles in brackets (`[Insane]`, `[Attend Unto the Call of Xhul ]`) are counted as tags.
  162 of the 411 diverging pages carry at least one name that is not in the BBCode
  vocabulary, so the histogram can group pages but never proves a cause.
- It warns when a page the scan called divergent compares identical here: that means `--goldens` is
  not the directory that scan used.

Keep the pages and the output outside the repo (`~/.cache/<task>/`, never `/tmp`).
