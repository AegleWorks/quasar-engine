# Integrar Quasar en Lyne (`line/web`)

Guía para que el foro de Lyne use el motor Quasar en vez del renderer propio
(`components/bbcode.tsx` + `bbcode.module.css`).

## 1. Publicar el paquete (una vez, desde MiliastryNova)

Quasar se publica a GitHub Packages del owner `hxovc`:

```bash
cd packages/quasar
# requiere un token con scope write:packages en NODE_AUTH_TOKEN
npm publish
```

Antes de publicar hay que resolver el **revert en progreso** y commitear el
estado actual (podas de tags, `left`, shadow/font, fix wnotice, optimización
CSS, idMode `none`, build con tsup).

## 2. Instalar en `line/web`

Crea/edita `.npmrc` en la raíz de `line/web`:

```
@miliastry:registry=https://npm.pkg.github.com/
```

y añade el paquete:

```bash
npm install @miliastry/quasar
```

## 3. Renderizar BBCode (modo foro — sin ids, sin editor)

```tsx
import { useMemo } from "react";
import { BBCodeDocumentModel, HTMLRenderer } from "@miliastry/quasar";
import "@miliastry/quasar/Visuals/lyne.css";

// Una vez al arrancar (o por request): el foro es solo lectura, no necesita
// data-node-id. 'none' quita el atributo de TODO el HTML (más pequeño y
// ligero); 'blocks' lo deja solo en contenedores si algún día lo necesitas.
HTMLRenderer.idMode = "none";

export function BBCode({ source }: { source: string }) {
  const html = useMemo(() => {
    const model = new BBCodeDocumentModel({ source, dialect: "lyne" });
    return model.toHTML();
  }, [source]);

  // El renderer de Quasar escapa todo el texto (escapeHtml) y sanea
  // atributos (color/fontSize/fontFamily + whitelist de [style] que bloquea
  // url()/javascript:). Es el mismo contrato de seguridad que el renderer
  // React de Lyne, solo que emitido como string.
  return <div className="bbcode-preview bbcode-preview-lyne" dangerouslySetInnerHTML={{ __html: html }} />;
}
```

### Alternativa sin `dangerouslySetInnerHTML` (más estricta)

Si prefieres mantener la postura actual de Lyne (React nodes, cero innerHTML),
parsea el HTML de Quasar a React con `react-dom/server` o usa el `DOMMorpher`
en el cliente. El primer paso recomendado es el `dangerouslySetInnerHTML`:
es el camino corto y el renderer ya sanea.

## 4. Dialecto y tema

- `dialect: "lyne"` → el parser acepta los tags de Lyne (canónicos + aliases
  legacy) y el renderer emite la estructura Lyne (`bb-notice`, `bb-glass`, …).
- `import "@miliastry/quasar/Visuals/lyne.css"` → los estilos del tema Lyne
  (glass, neon, cut-panels a 45°, tablas, notices…). El preview del editor de
  Miliastry usa las clases `bbcode-preview` / `bbcode-preview-lyne`.

## 5. Reemplazo progresivo

Los puntos de uso actuales de `components/bbcode.tsx`:

| Archivo | Contenido |
|---|---|
| `app/forum/t/[id]/page.tsx` | hilos del foro |
| `app/forum/c/[id]/page.tsx` | categorías |
| `app/u/[username]/page.tsx` | sección "about" del perfil |
| `app/maps/[id]/DetailClient.tsx`, `ModdingTab.tsx`, `CommentsSection.tsx` | descripciones/zonas de modding |
| `app/guilds/[tag]/page.tsx`, `GuildManage.tsx` | descripciones de gremio |
| `app/settings/profile/page.tsx` | editor del "about" |

Estrategia sugerida:

1. Crea `components/bbcode-quasar.tsx` con el componente del paso 3.
2. Switchea un lugar (p. ej. `forum/t`) y compara el HTML renderizado contra
   `components/bbcode.tsx` en los casos del foro real.
3. Cuando el look coincida, elimina `bbcode.tsx` + `bbcode.module.css` y
   sustituye el uso en el resto de páginas.

## Notas

- **Sin dependencias**: `@miliastry/quasar` tiene `dependencies: {}` — el
  bundle es autocontenido (esbuild/tsup). Cero peso añadido al foro.
- **IDs**: `HTMLRenderer.idMode` es estático a nivel de clase; en SSR hay que
  asegurarse de que el valor se fije antes de renderizar (módulo compartido o
  en el `_app`/layout).
- **Posiciones**: el renderer no emite posiciones en el HTML; los
  `sourceRange` solo existen en el modelo, que el foro no retiene.
- **Versiones**: sube `version` en `packages/quasar/package.json` en cada
  publicación para que Lyne pueda fijar la suya.
