# Comes Shot

Capturas de pantalla rápidas y precisas para Windows, de la familia ComesADE.
Rust nativo (Win32 + Direct2D + WIC), sin runtime ni navegador incrustado:
un solo `.exe` de ~650 KB.

## Qué hace

- **App con ventana propia**: al abrir Comes Shot aparece su ventana (y su icono en la
  barra de tareas) con botones para cada tipo de captura y su atajo. Los atajos funcionan
  mientras la app esté abierta, aunque esté minimizada; cerrar la ventana cierra la app.
  Durante la captura la ventana se oculta para no salir en la foto.
- **Captura de área** con la pantalla congelada, lupa de píxeles (posición y color),
  guías en cruz y medidas en píxeles reales. Flechas = mover el cursor 1 px (Mayús: 10 px).
- **Captura de ventana** (clic sobre la ventana resaltada) y **pantalla completa**.
- **Repetir el área anterior** y **capturar texto (OCR)** con el motor de Windows.
- **Vista rápida** tras cada captura: Copiar, Guardar/Mostrar, Anotar, Fijar, cerrar,
  o arrástrala directamente a Explorer, Discord, el navegador, Word…
- **Editor**: flecha, rectángulo, elipse, línea, lápiz, resaltador, texto, contador de
  pasos, pixelado y recorte; deshacer/rehacer; exporta a la resolución original.
- **Fijar en pantalla**: ventana siempre visible, rueda = zoom, Ctrl+rueda = opacidad.

## Idiomas

Español, English, Português, Français y Deutsch, los mismos que ComesADE y con la misma
regla automática (dispositivo + IP): si Windows y el país de tu IP coinciden, ese idioma;
si Windows está en inglés pero tu IP es de un país de otro idioma, gana el de la IP; si
no, el de Windows. El país se consulta a la API de ComesADE (o al trace de Cloudflare) y
se guarda 6 horas. Se cambia en *Opciones → Idioma*, o con
`language = "en"` en `config.toml`. Los textos están en `src/i18n.rs` y un test falla si
algún texto de la interfaz no tiene traducción.

## Calidad

El proceso es *per-monitor DPI aware v2*: todo se mide en píxeles físicos. Un monitor
1080p da 1920×1080, uno 1440p da 2560×1440 y uno 4K da 3840×2160, aunque Windows use
escalado (125 %, 150 %…). PNG sin pérdida por defecto; JPG opcional (calidad 95).

La captura usa **DXGI Desktop Duplication**: lee el fotograma que la GPU ya compuso, con
la duplicación preparada al arrancar y solo los píxeles pedidos viajando de vuelta. Si
no está disponible (pantalla girada, escritorio seguro, sin GPU), usa GDI.

En el equipo de desarrollo (2 × 1080p), con `--bench`:

| | GDI (antes) | DXGI (ahora) |
|---|---|---|
| Escritorio completo 3840×1080 | ~38 ms | **~4,6 ms** (peor 6 ms) |
| Un monitor 1920×1080 | — | ~3,8 ms |

Los píxeles coinciden con GDI. El PNG se guarda en segundo plano (~75 ms, no bloquea).

## Atajos por defecto

| Acción | Atajo |
|---|---|
| Capturar área | F4 (Fn+4) |
| Capturar ventana | F5 (Fn+5) |
| Pantalla completa | F3 (Fn+3) |
| Repetir área anterior | F6 (Fn+6) |
| Capturar texto (OCR) | F2 (Fn+2) |

Windows no ve la tecla Fn: en teclados compactos Fn+4 envía F4, y en portátiles Fn+F4
envía F4. Mientras Comes Shot está abierto, F2–F6 quedan reservadas para él (por
ejemplo, F5 deja de recargar el navegador y F2 de renombrar en Explorer).

En el overlay: `Espacio` alterna área/ventana, `F` captura el monitor, `C` copia el color,
`M` oculta la lupa, `Enter` confirma, `Esc` o clic derecho cancela.

Se cambian en `%APPDATA%\ComesShot\config.toml` (*Opciones → Preferencias → Editar atajos y
ajustes…*); la app recarga el archivo sola al guardarlo. Ejemplo: `area = "PrintScreen"`.

## Actualizaciones automáticas

Publicar una versión nueva:

1. Cambia el código en `comes-shot/` y sube la versión en `Cargo.toml` (`version = "0.3.0"`).
2. Haz push a `main`. El workflow *Comes Shot release* compila, pasa los tests y publica
   la release `comes-shot-v0.3.0` con `ComesShot.exe` y su `ComesShot.exe.sha256`.
   Si la versión no cambió, solo compila y prueba.

   Sin GitHub Actions (por ejemplo, con la facturación de la cuenta bloqueada), publica
   desde el PC con `powershell -ExecutionPolicy Bypass -File publicar.ps1`, que hace lo
   mismo: tests, compilación y release.

Las copias instaladas consultan esas releases 15 s después de abrirse y luego cada 6 horas.
Si hay una versión nueva, la descargan, comprueban su SHA-256, sustituyen el `.exe` y se
reinician solas. Si estás capturando o tienes el editor abierto, esperan a que termines.
Se puede desactivar en *Opciones → Actualizar automáticamente*.

Las releases de Comes Shot usan tags `comes-shot-v*` y nunca se marcan como *Latest*,
para no interferir con el actualizador de ComesADE ni con sus compilaciones firmadas (`v*`).

## Compilar

```
cargo build --release
target\release\ComesShot.exe
```

Línea de comandos (también reenvía a la instancia abierta):
`--area`, `--window`, `--fullscreen`, `--previous`, `--text`, `--open`, `--folder`, `--quit`,
`--background` (arranque silencioso, lo usa *Iniciar con Windows*).

Herramientas de desarrollo: `--bench` (mide captura y guardado), `--preview DIR`
(renderiza overlay, vista rápida y editor sobre un escritorio sintético),
`--export-icon resources\comesshot.ico` (regenera el icono).

Las capturas se guardan en la carpeta *Capturas de pantalla* de Windows de cada usuario (`Imágenes\Screenshots`, también si está en OneDrive).
