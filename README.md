# Twitch Ultralight

Cliente de escritorio ultraligero para ver streams de Twitch y usar el chat, construido con Tauri 2 + Vanilla JS.

## Características

- Reproducción de streams con HLS (control de rebobinado y "volver al VIVO").
- Visor de delay en tiempo real.
- Chat IRC integrado con historial, emblemas y colores de usuario.
- Posición del chat configurable (derecha, izquierda u oculto).
- Login OAuth con Twitch para chat y suscripciones.

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


## Build de instalador

```bash
npm run tauri build -- --bundles nsis
```

> Nota: el recurso `streamlink-portable.zip` es un binario de terceros que debe proveerse en `src-tauri/resources/` para empaquetar la funcionalidad de streamlink. No se distribuye en este repositorio.
