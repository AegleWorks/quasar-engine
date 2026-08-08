# 7. Extensibility (`Plugins/`)

Sistemas que permiten expandir y modificar el comportamiento del motor sin alterar o acoplar fuertemente su núcleo.

## `PluginAPI`
El sistema de `PluginRegistry` es la piedra angular de la extensibilidad en QuasarEngine. Permite a los consumidores externos inyectar dinámicamente funcionalidades:
- **Nuevos Tags**: Implementaciones de `TagDefinition` customizadas.
- **Nuevas Validaciones**: Reglas `DiagnosticRule` adicionales para el analizador semántico.
- **Nuevos Transformadores**: Inyectar nuevos `Transformer`s en el pipeline de renderizado.

Esto asegura que el motor pueda crecer orgánicamente según los requerimientos del proyecto web, sin volverse rígido o monolítico.
