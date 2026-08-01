# Twitch Ultralight

Cliente de escritorio ultraligero para ver streams de Twitch y usar el chat, construido con Tauri 2 + Vanilla JS. Alternativa liviana al cliente oficial de escritorio.

## Características

- Reproducción de streams con HLS (control de rebobinado y "volver al VIVO").
- Visor de delay en tiempo real.
- Chat IRC integrado con historial, emblemas y colores de usuario.
- Posición del chat configurable (derecha, izquierda u oculto).
- Login OAuth con Twitch para chat y suscripciones.
- Sin base de datos: los tokens se guardan localmente en tu perfil de usuario.

## Requisitos

- Node.js 18+
- Rust (edition 2021)
- Dependencias de Tauri 2 para tu sistema operativo

## Instalación y desarrollo

```bash
npm install
npm run tauri dev
```

## Scripts

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Servidor Vite de desarrollo |
| `npm test` | Tests unitarios (Node test runner) |
| `npm run e2e` | Tests end-to-end con Playwright |
| `npm run tauri dev` | Aplicación de escritorio en modo dev |
| `npm run bump:patch` / `bump:minor` / `bump:major` | Incrementar versión y crear tag git `vX.Y.Z` |
| `npm run release:patch` / `release:minor` / `release:major` | Release completo: bump + compilar instalador + push + crear GitHub Release borrador |

## Versionado

La versión tiene una única fuente de verdad (`src-tauri/tauri.conf.json`) y `bump-version.js` la propaga a todos los archivos (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`) creando un commit y un tag `vX.Y.Z`.

## Release de punta a punta

```bash
npm run release:patch   # o release:minor / release:major
```

Este comando ejecuta en orden: verificación del working tree limpio → bump de versión (commit + tag) → compilación del instalador NSIS → push del commit y del tag → creación de un **GitHub Release borrador** (para revisar antes de publicar).

- `npm run release:patch -- --dry-run` muestra la secuencia sin ejecutar nada.
- Tras el comando, revisa el borrador en GitHub (`gh release view vX.Y.Z`) y publícalo.

> Requisitos: `gh` autenticado y working tree sin cambios sin commitear.

## Build de instalador

```bash
npm run tauri build -- --bundles nsis
```

> Nota: el recurso `streamlink-portable.zip` es un binario de terceros que debe proveerse en `src-tauri/resources/` para empaquetar la funcionalidad de streamlink. No se distribuye en este repositorio.
