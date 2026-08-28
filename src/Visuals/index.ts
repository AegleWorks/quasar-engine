/**
 * DocumentEngine — Visuals
 *
 * Catálogo de estilos visuales por plataforma para la previsualización
 * de BBCode. Cada plataforma puede tener su propia apariencia sin
 * modificar el renderer HTML.
 *
 * Uso:
 *   // Desde la FUENTE, que es como lo consume el monorepo (Next.js, Vite,
 *   // Webpack): esta ruta funciona sin haber compilado nada.
 *   import '@miliastry/quasar/src/Visuals/osu.css'
 *
 *   // Desde el paquete PUBLICADO. Solo resuelve tras `npm run build`, que es
 *   // lo que copia los CSS a dist/Visuals (ver scripts/copy-css.mjs).
 *   import '@miliastry/quasar/Visuals/osu.css'
 *
 *   // Luego en el JSX: <div className="bbcode-preview" ...
 *
 * Para cambiar de tema visual, solo cambia el import del CSS.
 *
 * Temas disponibles:
 *   - osu  → Estilo visual inspirado en los foros de osu!
 *   - miliastry → Estilo por defecto de Miliastry (próximamente)
 */

export { bindBoxDrawer, toggleBoxWithDrawer } from './BoxDrawer'
export type { BoxDrawerOptions } from './BoxDrawer'

export const visualThemes = [
  {
    id: 'osu',
    name: 'osu! Forum Style',
    description: 'Estilo visual inspirado en los foros de osu!',
    cssFile: 'osu.css',
  },
  {
    id: 'lyne',
    name: 'Lyne Style',
    description: 'Estilo visual cyberpunk con cortes a 45° inspirado en Lyne',
    cssFile: 'lyne.css',
  },
] as const

export type VisualThemeId = (typeof visualThemes)[number]['id']

