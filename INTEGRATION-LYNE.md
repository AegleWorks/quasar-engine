# Integrating Quasar into Lyne (`line/web`)

A guide for the Lyne forum to use the Quasar engine instead of its own renderer
(`components/bbcode.tsx` + `bbcode.module.css`).

## 1. Publish the package (once, from MiliastryNova)

Quasar is published to GitHub Packages under the owner `hxovc`:

```bash
cd packages/quasar
# requires a token with the write:packages scope in NODE_AUTH_TOKEN
npm publish
```

Before publishing, you must resolve the **revert in progress** and commit the
current state (tag prunes, `left`, shadow/font, wnotice fix, CSS
optimization, idMode `none`, tsup build).

## 2. Install in `line/web`

Create/edit `.npmrc` at the root of `line/web`:

```
@miliastry:registry=https://npm.pkg.github.com/
```

and add the package:

```bash
npm install @miliastry/quasar
```

## 3. Render BBCode (forum mode: no ids, no editor)

```tsx
import { useMemo } from "react";
import { BBCodeDocumentModel, HTMLRenderer } from "@miliastry/quasar";
import "@miliastry/quasar/Visuals/lyne.css";

// Once at startup (or per request): the forum is read-only, it does not need
// data-node-id. 'none' removes the attribute from ALL the HTML (smaller and
// lighter); 'blocks' keeps it only on containers if you ever need it.
HTMLRenderer.idMode = "none";

export function BBCode({ source }: { source: string }) {
  const html = useMemo(() => {
    const model = new BBCodeDocumentModel({ source, dialect: "lyne" });
    return model.toHTML();
  }, [source]);

  // The Quasar renderer escapes all text (escapeHtml) and sanitizes
  // attributes (color/fontSize/fontFamily + a [style] whitelist that blocks
  // url()/javascript:). It is the same security contract as Lyne's React
  // renderer, only emitted as a string.
  return <div className="bbcode-preview bbcode-preview-lyne" dangerouslySetInnerHTML={{ __html: html }} />;
}
```

### Alternative without `dangerouslySetInnerHTML` (stricter)

If you prefer to keep Lyne's current stance (React nodes, zero innerHTML),
parse Quasar's HTML into React with `react-dom/server` or use the `DOMMorpher`
on the client. The recommended first step is `dangerouslySetInnerHTML`:
it is the short path and the renderer already sanitizes.

## 4. Dialect and theme

- `dialect: "lyne"` → the parser accepts Lyne's tags (canonical + legacy
  aliases) and the renderer emits the Lyne structure (`bb-notice`, `bb-glass`, …).
- `import "@miliastry/quasar/Visuals/lyne.css"` → the Lyne theme styles
  (glass, neon, 45° cut-panels, tables, notices…). The Miliastry editor
  preview uses the `bbcode-preview` / `bbcode-preview-lyne` classes.

## 5. Progressive replacement

The current places that use `components/bbcode.tsx`:

| File | Content |
|---|---|
| `app/forum/t/[id]/page.tsx` | forum threads |
| `app/forum/c/[id]/page.tsx` | categories |
| `app/u/[username]/page.tsx` | the "about" section of the profile |
| `app/maps/[id]/DetailClient.tsx`, `ModdingTab.tsx`, `CommentsSection.tsx` | modding descriptions/zones |
| `app/guilds/[tag]/page.tsx`, `GuildManage.tsx` | guild descriptions |
| `app/settings/profile/page.tsx` | the "about" editor |

Suggested strategy:

1. Create `components/bbcode-quasar.tsx` with the component from step 3.
2. Switch one place (e.g. `forum/t`) and compare the rendered HTML against
   `components/bbcode.tsx` on real forum cases.
3. When the look matches, delete `bbcode.tsx` + `bbcode.module.css` and
   replace the usage in the remaining pages.

## Notes

- **No dependencies**: `@miliastry/quasar` has `dependencies: {}`. The
  bundle is self-contained (esbuild/tsup). Zero added weight for the forum.
- **IDs**: `HTMLRenderer.idMode` is static at class level. In SSR, make
  sure the value is set before rendering (shared module or in the
  `_app`/layout).
- **Positions**: the renderer does not emit positions in the HTML; the
  `sourceRange`s only exist in the model, which the forum does not retain.
- **Versions**: bump `version` in `packages/quasar/package.json` on every
  publish so that Lyne can pin its own.
