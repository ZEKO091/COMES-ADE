# Distribución legítima de ComesADE

Este proyecto no desactiva Microsoft Defender, SmartScreen, Gatekeeper ni
las políticas de PowerShell. La confianza se obtiene con identidad verificable,
firma de código, notarización y un canal de distribución transparente.

## Identidad del editor

El bundle usa `ComesADE Project` como etiqueta provisional de editor. Antes de
publicar, cámbiala en `src-tauri/tauri.conf.json` por el nombre legal que
corresponda al propietario del certificado. El nombre mostrado por el
certificado y el del instalador deben mantenerse consistentes entre versiones.

No uses el nombre de Microsoft, Apple, una empresa ajena ni un certificado que
no te pertenezca.

## Windows: firma Authenticode

Para distribución directa, usa un certificado de firma de código emitido por
una autoridad reconocida o Microsoft Artifact Signing. La firma no garantiza
que desaparezca la advertencia inicial de SmartScreen: la reputación también
se construye con descargas limpias y consistencia del editor.

1. Instala el certificado con su clave privada en el almacén del usuario:
   `Cert:\CurrentUser\My`.
2. Instala el Windows SDK para disponer de `signtool.exe`, o define
   `TAURI_WINDOWS_SIGNTOOL_PATH`.
3. Define la huella SHA-1 y, opcionalmente, el servidor de sellado temporal:

```powershell
$env:WINDOWS_SIGNING_CERT_THUMBPRINT = '<HUELLA_SHA1_DEL_CERTIFICADO>'
$env:WINDOWS_SIGNING_TIMESTAMP_URL = 'https://timestamp.digicert.com'
npm run build:windows:signed
```

El script de firma exige un certificado real con clave privada, usa SHA-256,
firma los artefactos que entrega Tauri y verifica cada firma antes de terminar.
No guarda el certificado ni la contraseña dentro del repositorio.

Para revisar un artefacto concreto:

```powershell
Get-AuthenticodeSignature .\src-tauri\target\release\comesade.exe |
  Format-List Status,StatusMessage,SignerCertificate
```

## Microsoft Store

La configuración `src-tauri/tauri.microsoftstore.conf.json` usa el instalador
offline de WebView2, que es el formato requerido para este flujo. El instalador
también debe estar firmado.

```powershell
npm run tauri build -- --no-bundle
npm run tauri bundle -- --config src-tauri/tauri.microsoftstore.conf.json
```

En Partner Center registra el producto como aplicación EXE/MSI y declara el
parámetro de instalación silenciosa que corresponda (`/S` para NSIS o `/quiet`
para MSI). La publicación en Store es una acción externa y requiere una cuenta
de desarrollador de Microsoft.

## macOS: Developer ID y notarización

Necesitas una cuenta Apple Developer, una identidad `Developer ID Application`
y credenciales de App Store Connect. La notarización solo se ejecuta con una
identidad Developer ID real; no se simula con una firma ad-hoc.

En un Mac con el certificado instalado en el llavero de inicio de sesión:

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: Nombre legal (TEAMID)'
export APPLE_API_KEY='KEY_ID'
export APPLE_API_ISSUER='ISSUER_ID'
export APPLE_API_KEY_PATH="$PWD/private_keys/AuthKey_${APPLE_API_KEY}.p8"
npm run build:macos:signed
```

En CI, `APPLE_CERTIFICATE` debe contener el `.p12` en Base64 y
`APPLE_CERTIFICATE_PASSWORD` su contraseña. La clave `.p8` y el certificado se
inyectan como secretos temporales; nunca se commitean. Para generar Intel y
Apple Silicon se puede definir `TAURI_TARGET` como
`x86_64-apple-darwin` o `aarch64-apple-darwin`.

## Pipeline seguro

`.github/workflows/signed-builds.yml` está preparado para ejecución manual o
por tags `v*`. Solo genera artefactos y los sube como artefactos de CI; no
publica automáticamente en una Store ni modifica equipos de usuarios.

Configura en GitHub Actions, como mínimo, estos secretos:

- Windows: `WINDOWS_SIGNING_CERTIFICATE_BASE64`,
  `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` y
  `WINDOWS_SIGNING_CERT_THUMBPRINT`.
- Apple: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER` y
  `APPLE_API_KEY_BASE64`.

El workflow importa las credenciales solo durante el job, borra los archivos
temporales y limita los permisos del job a lectura del código.

## Lista antes de publicar

- El nombre legal coincide con el certificado y el publisher del bundle.
- Todos los `.exe`, `.msi`, `.dmg` y apps están firmados.
- Las firmas se verifican después del empaquetado y antes de subir el archivo.
- No se modifica ningún artefacto después de firmarlo.
- No se añaden exclusiones de Defender ni instrucciones para desactivar
  SmartScreen.
- El usuario puede identificar la página de descarga y el editor.
- Si Microsoft Defender marca un falso positivo, se envía el archivo a la
  revisión oficial de Microsoft en lugar de intentar evadir la detección.
