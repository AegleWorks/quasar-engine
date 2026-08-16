/**
 * DocumentEngine — Visuals
 *
 * Catálogo de estilos visuales por plataforma para la previsualización
 * de BBCode. Cada plataforma puede tener su propia apariencia sin
 * modificar el renderer HTML.
 *
 * Uso:
 *   // Importar como CSS directo (soportado por Next.js, Vite, Webpack):
 *   import 'MiliastryPlatform/DocumentEngine/Visuals/osu.css'
 *
 *   // O desde un componente React:
 *   import 'MiliastryPlatform/DocumentEngine/Visuals/osu.css'
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

