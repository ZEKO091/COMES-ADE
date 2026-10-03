//! Interface translations. Spanish is the source text; each entry carries
//! English, Portuguese, French and German. The language follows Windows
//! unless the user picks one in the tray menu.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use windows::Win32::Globalization::GetUserDefaultUILanguage;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Es = 0,
    En = 1,
    Pt = 2,
    Fr = 3,
    De = 4,
}

/// (config code, name shown in the menu)
pub const LANGS: [(&str, &str); 5] = [
    ("es", "Español"),
    ("en", "English"),
    ("pt", "Português"),
    ("fr", "Français"),
    ("de", "Deutsch"),
];

static CURRENT: AtomicU8 = AtomicU8::new(0);

pub fn current() -> Lang {
    match CURRENT.load(Ordering::Relaxed) {
        1 => Lang::En,
        2 => Lang::Pt,
        3 => Lang::Fr,
        4 => Lang::De,
        _ => Lang::Es,
    }
}

fn from_code(code: &str) -> Option<Lang> {
    Some(match code.to_ascii_lowercase().as_str() {
        "es" => Lang::Es,
        "en" => Lang::En,
        "pt" => Lang::Pt,
        "fr" => Lang::Fr,
        "de" => Lang::De,
        _ => return None,
    })
}

/// Windows display language; anything we don't ship falls back to English.
pub fn system() -> Lang {
    let primary = unsafe { GetUserDefaultUILanguage() } & 0x3FF;
    match primary {
        0x0A => Lang::Es,
        0x16 => Lang::Pt,
        0x0C => Lang::Fr,
        0x07 => Lang::De,
        _ => Lang::En,
    }
}

/// Applies the `language` setting: "auto" or a code from `LANGS`.
pub fn apply(setting: &str) {
    let lang = from_code(setting).unwrap_or_else(system);
    CURRENT.store(lang as u8, Ordering::Relaxed);
}

/// BCP-47 locale for DirectWrite.
pub fn locale() -> &'static str {
    ["es-es", "en-us", "pt-br", "fr-fr", "de-de"][current() as usize]
}

fn table() -> &'static HashMap<&'static str, [&'static str; 4]> {
    static MAP: OnceLock<HashMap<&'static str, [&'static str; 4]>> = OnceLock::new();
    MAP.get_or_init(|| ENTRIES.iter().map(|(es, rest)| (*es, *rest)).collect())
}

/// Translates a Spanish source string.
pub fn t(es: &'static str) -> &'static str {
    let lang = current();
    if lang == Lang::Es {
        return es;
    }
    match table().get(es) {
        Some(tr) => tr[lang as usize - 1],
        None => es,
    }
}

/// Translates and fills each `{}` in order.
pub fn tf(es: &'static str, args: &[&dyn Display]) -> String {
    let mut out = String::new();
    let mut parts = t(es).split("{}");
    if let Some(first) = parts.next() {
        out.push_str(first);
    }
    for (i, part) in parts.enumerate() {
        if let Some(a) = args.get(i) {
            out.push_str(&a.to_string());
        }
        out.push_str(part);
    }
    out
}

type Entry = (&'static str, [&'static str; 4]);

#[rustfmt::skip]
const ENTRIES: &[Entry] = &[
    // ---- tray, notifications
    ("Comes Shot {} a las {}", ["Comes Shot {} at {}", "Comes Shot {} às {}", "Comes Shot {} à {}", "Comes Shot {} um {}"]),
    ("Comes Shot está listo  ·  {} para capturar", ["Comes Shot is ready  ·  {} to capture", "Comes Shot está pronto  ·  {} para capturar", "Comes Shot est prêt  ·  {} pour capturer", "Comes Shot ist bereit  ·  {} zum Aufnehmen"]),
    ("Clic en la bandeja", ["Click the tray icon", "Clique no ícone da bandeja", "Cliquez sur l'icône de notification", "Klick auf das Infobereich-Symbol"]),
    ("Atajo en uso por otra app: {}", ["Shortcut used by another app: {}", "Atalho em uso por outro app: {}", "Raccourci utilisé par une autre app : {}", "Tastenkürzel wird von einer anderen App verwendet: {}"]),
    ("Comes Shot — capturas de pantalla", ["Comes Shot — screenshots", "Comes Shot — capturas de tela", "Comes Shot — captures d'écran", "Comes Shot — Bildschirmfotos"]),
    ("No se pudo abrir la imagen", ["Couldn't open the image", "Não foi possível abrir a imagem", "Impossible d'ouvrir l'image", "Das Bild konnte nicht geöffnet werden"]),
    ("No se pudo capturar la pantalla", ["Couldn't capture the screen", "Não foi possível capturar a tela", "Impossible de capturer l'écran", "Der Bildschirm konnte nicht aufgenommen werden"]),
    ("Captura copiada y guardada", ["Screenshot copied and saved", "Captura copiada e salva", "Capture copiée et enregistrée", "Bildschirmfoto kopiert und gespeichert"]),
    ("Captura copiada", ["Screenshot copied", "Captura copiada", "Capture copiée", "Bildschirmfoto kopiert"]),
    ("Captura guardada", ["Screenshot saved", "Captura salva", "Capture enregistrée", "Bildschirmfoto gespeichert"]),
    ("Captura lista", ["Screenshot ready", "Captura pronta", "Capture prête", "Bildschirmfoto bereit"]),
    ("Reconociendo texto…", ["Recognizing text…", "Reconhecendo texto…", "Reconnaissance du texte…", "Text wird erkannt…"]),
    ("No se pudo guardar: {}", ["Couldn't save: {}", "Não foi possível salvar: {}", "Échec de l'enregistrement : {}", "Speichern fehlgeschlagen: {}"]),
    ("Texto copiado  ·  {} caracteres", ["Text copied  ·  {} characters", "Texto copiado  ·  {} caracteres", "Texte copié  ·  {} caractères", "Text kopiert  ·  {} Zeichen"]),
    ("No se encontró texto en la selección", ["No text found in the selection", "Nenhum texto encontrado na seleção", "Aucun texte trouvé dans la sélection", "Kein Text in der Auswahl gefunden"]),
    ("OCR no disponible: {}", ["OCR unavailable: {}", "OCR indisponível: {}", "OCR indisponible : {}", "OCR nicht verfügbar: {}"]),
    ("instala un idioma con reconocimiento de texto en Configuración de Windows", ["install a language with text recognition in Windows Settings", "instale um idioma com reconhecimento de texto nas Configurações do Windows", "installez une langue avec reconnaissance de texte dans les Paramètres Windows", "installiere eine Sprache mit Texterkennung in den Windows-Einstellungen"]),
    ("Carpeta de capturas actualizada", ["Screenshots folder updated", "Pasta de capturas atualizada", "Dossier des captures mis à jour", "Ordner für Bildschirmfotos aktualisiert"]),
    ("Ajustes recargados", ["Settings reloaded", "Ajustes recarregados", "Réglages rechargés", "Einstellungen neu geladen"]),
    ("Comes Shot ya está abierto en la bandeja", ["Comes Shot is already running in the tray", "Comes Shot já está aberto na bandeja", "Comes Shot est déjà ouvert dans la zone de notification", "Comes Shot läuft bereits im Infobereich"]),
    ("Copiado al portapapeles", ["Copied to clipboard", "Copiado para a área de transferência", "Copié dans le presse-papiers", "In die Zwischenablage kopiert"]),
    ("Copiado y guardado", ["Copied and saved", "Copiado e salvo", "Copié et enregistré", "Kopiert und gespeichert"]),
    ("Guardado", ["Saved", "Salvo", "Enregistré", "Gespeichert"]),
    ("Imagen guardada", ["Image saved", "Imagem salva", "Image enregistrée", "Bild gespeichert"]),
    ("Color {} copiado", ["Color {} copied", "Cor {} copiada", "Couleur {} copiée", "Farbe {} kopiert"]),
    // ---- tray menu
    ("Capturar área", ["Capture area", "Capturar área", "Capturer une zone", "Bereich aufnehmen"]),
    ("Capturar ventana", ["Capture window", "Capturar janela", "Capturer une fenêtre", "Fenster aufnehmen"]),
    ("Capturar pantalla completa", ["Capture full screen", "Capturar tela inteira", "Capturer tout l'écran", "Ganzen Bildschirm aufnehmen"]),
    ("Repetir área anterior", ["Repeat previous area", "Repetir área anterior", "Répéter la zone précédente", "Vorherigen Bereich wiederholen"]),
    ("Capturar texto (OCR)", ["Capture text (OCR)", "Capturar texto (OCR)", "Capturer du texte (OCR)", "Text erfassen (OCR)"]),
    ("Anotar última captura", ["Annotate last screenshot", "Anotar última captura", "Annoter la dernière capture", "Letztes Bildschirmfoto bearbeiten"]),
    ("Fijar última captura en pantalla", ["Pin last screenshot to screen", "Fixar última captura na tela", "Épingler la dernière capture à l'écran", "Letztes Bildschirmfoto anheften"]),
    ("Abrir imagen para anotar…", ["Open image to annotate…", "Abrir imagem para anotar…", "Ouvrir une image à annoter…", "Bild zum Bearbeiten öffnen…"]),
    ("Abrir carpeta de capturas", ["Open screenshots folder", "Abrir pasta de capturas", "Ouvrir le dossier des captures", "Ordner mit Bildschirmfotos öffnen"]),
    ("Después de capturar", ["After capture", "Depois de capturar", "Après la capture", "Nach der Aufnahme"]),
    ("Copiar al portapapeles", ["Copy to clipboard", "Copiar para a área de transferência", "Copier dans le presse-papiers", "In die Zwischenablage kopieren"]),
    ("Guardar automáticamente", ["Save automatically", "Salvar automaticamente", "Enregistrer automatiquement", "Automatisch speichern"]),
    ("Mostrar vista rápida", ["Show quick preview", "Mostrar visualização rápida", "Afficher l'aperçu rapide", "Schnellvorschau anzeigen"]),
    ("Sonido al capturar (Chimes)", ["Capture sound (Chimes)", "Som ao capturar (Chimes)", "Son de capture (Chimes)", "Aufnahmeton (Chimes)"]),
    ("Preferencias", ["Preferences", "Preferências", "Préférences", "Einstellungen"]),
    ("Formato PNG (sin pérdida)", ["PNG format (lossless)", "Formato PNG (sem perdas)", "Format PNG (sans perte)", "PNG-Format (verlustfrei)"]),
    ("Formato JPG (calidad {})", ["JPG format (quality {})", "Formato JPG (qualidade {})", "Format JPG (qualité {})", "JPG-Format (Qualität {})"]),
    ("Lupa de píxeles", ["Pixel magnifier", "Lupa de pixels", "Loupe de pixels", "Pixel-Lupe"]),
    ("Guías en cruz", ["Crosshair guides", "Guias em cruz", "Repères en croix", "Fadenkreuz"]),
    ("Pantalla completa: todos los monitores", ["Full screen: all displays", "Tela inteira: todos os monitores", "Plein écran : tous les écrans", "Vollbild: alle Bildschirme"]),
    ("Cambiar carpeta de capturas…", ["Change screenshots folder…", "Alterar pasta de capturas…", "Changer le dossier des captures…", "Ordner für Bildschirmfotos ändern…"]),
    ("Editar atajos y ajustes…", ["Edit shortcuts and settings…", "Editar atalhos e ajustes…", "Modifier les raccourcis et réglages…", "Tastenkürzel und Einstellungen bearbeiten…"]),
    ("Iniciar con Windows", ["Start with Windows", "Iniciar com o Windows", "Lancer avec Windows", "Mit Windows starten"]),
    ("Idioma", ["Language", "Idioma", "Langue", "Sprache"]),
    ("Automático (sistema)", ["Automatic (system)", "Automático (sistema)", "Automatique (système)", "Automatisch (System)"]),
    ("Salir", ["Quit", "Sair", "Quitter", "Beenden"]),
    // ---- main window
    ("Repetir área", ["Repeat area", "Repetir área", "Répéter la zone", "Bereich wiederholen"]),
    ("Abrir imagen…", ["Open image…", "Abrir imagem…", "Ouvrir une image…", "Bild öffnen…"]),
    ("Abrir carpeta", ["Open folder", "Abrir pasta", "Ouvrir le dossier", "Ordner öffnen"]),
    ("Opciones", ["Options", "Opções", "Options", "Optionen"]),
    ("Captura", ["Capture", "Captura", "Capture", "Aufnahme"]),
    ("Formato", ["Format", "Formato", "Format", "Format"]),
    ("Pantalla completa", ["Full screen", "Tela inteira", "Plein écran", "Ganzer Bildschirm"]),
    ("Texto (OCR)", ["Text (OCR)", "Texto (OCR)", "Texte (OCR)", "Text (OCR)"]),
    ("Fijar", ["Pin", "Fixar", "Épingler", "Anheften"]),
    ("Abrir en el editor", ["Open in the editor", "Abrir no editor", "Ouvrir dans l'éditeur", "Im Editor öffnen"]),
    ("Aún no hay capturas", ["No screenshots yet", "Ainda não há capturas", "Aucune capture pour l'instant", "Noch keine Bildschirmfotos"]),
    ("Pulsa {} y arrastra sobre la pantalla", ["Press {} and drag over the screen", "Pressione {} e arraste sobre a tela", "Appuyez sur {} et faites glisser sur l'écran", "Drücke {} und ziehe über den Bildschirm"]),
    ("Elige un modo de captura a la derecha", ["Pick a capture mode on the right", "Escolha um modo de captura à direita", "Choisissez un mode de capture à droite", "Wähle rechts einen Aufnahmemodus"]),
    ("Ahora mismo", ["Just now", "Agora mesmo", "À l'instant", "Gerade eben"]),
    ("Hace {} min", ["{} min ago", "Há {} min", "Il y a {} min", "Vor {} Min."]),
    ("Hace {} h", ["{} h ago", "Há {} h", "Il y a {} h", "Vor {} Std."]),
    ("Guardando en: {}", ["Saving to: {}", "Salvando em: {}", "Enregistrement dans : {}", "Speichert in: {}"]),
    // ---- overlay
    ("C copia", ["C copies", "C copia", "C copie", "C kopiert"]),
    ("Selecciona el texto que quieres copiar   ·   Esc cancela", ["Select the text you want to copy   ·   Esc cancels", "Selecione o texto que deseja copiar   ·   Esc cancela", "Sélectionnez le texte à copier   ·   Échap annule", "Text zum Kopieren auswählen   ·   Esc bricht ab"]),
    ("Clic en una ventana para capturarla   ·   Espacio: área   ·   Esc cancela", ["Click a window to capture it   ·   Space: area   ·   Esc cancels", "Clique em uma janela para capturá-la   ·   Espaço: área   ·   Esc cancela", "Cliquez sur une fenêtre pour la capturer   ·   Espace : zone   ·   Échap annule", "Fenster anklicken zum Aufnehmen   ·   Leertaste: Bereich   ·   Esc bricht ab"]),
    ("Arrastra para capturar   ·   Clic: ventana   ·   F: pantalla   ·   Flechas: 1 px   ·   Esc cancela", ["Drag to capture   ·   Click: window   ·   F: screen   ·   Arrows: 1 px   ·   Esc cancels", "Arraste para capturar   ·   Clique: janela   ·   F: tela   ·   Setas: 1 px   ·   Esc cancela", "Faites glisser pour capturer   ·   Clic : fenêtre   ·   F : écran   ·   Flèches : 1 px   ·   Échap annule", "Ziehen zum Aufnehmen   ·   Klick: Fenster   ·   F: Bildschirm   ·   Pfeile: 1 px   ·   Esc bricht ab"]),
    // ---- quick access, pins
    ("Copiar", ["Copy", "Copiar", "Copier", "Kopieren"]),
    ("Guardar", ["Save", "Salvar", "Enregistrer", "Speichern"]),
    ("Mostrar", ["Show", "Mostrar", "Afficher", "Anzeigen"]),
    ("Comes Shot · Fijada", ["Comes Shot · Pinned", "Comes Shot · Fixada", "Comes Shot · Épinglée", "Comes Shot · Angeheftet"]),
    ("Guardar como…", ["Save as…", "Salvar como…", "Enregistrer sous…", "Speichern unter…"]),
    ("Anotar", ["Annotate", "Anotar", "Annoter", "Bearbeiten"]),
    ("Tamaño original (100 %)", ["Original size (100 %)", "Tamanho original (100 %)", "Taille d'origine (100 %)", "Originalgröße (100 %)"]),
    ("Opacidad", ["Opacity", "Opacidade", "Opacité", "Deckkraft"]),
    ("Cerrar", ["Close", "Fechar", "Fermer", "Schließen"]),
    // ---- editor
    ("Comes Shot — Editor", ["Comes Shot — Editor", "Comes Shot — Editor", "Comes Shot — Éditeur", "Comes Shot — Editor"]),
    ("Seleccionar y mover", ["Select and move", "Selecionar e mover", "Sélectionner et déplacer", "Auswählen und verschieben"]),
    ("Flecha", ["Arrow", "Seta", "Flèche", "Pfeil"]),
    ("Rectángulo", ["Rectangle", "Retângulo", "Rectangle", "Rechteck"]),
    ("Elipse", ["Ellipse", "Elipse", "Ellipse", "Ellipse"]),
    ("Línea", ["Line", "Linha", "Ligne", "Linie"]),
    ("Lápiz", ["Pen", "Lápis", "Crayon", "Stift"]),
    ("Resaltador", ["Highlighter", "Marca-texto", "Surligneur", "Textmarker"]),
    ("Texto", ["Text", "Texto", "Texte", "Text"]),
    ("Contador de pasos", ["Step counter", "Contador de passos", "Compteur d'étapes", "Schrittzähler"]),
    ("Pixelar (ocultar datos)", ["Pixelate (hide data)", "Pixelizar (ocultar dados)", "Pixeliser (masquer des données)", "Verpixeln (Daten verbergen)"]),
    ("Recortar", ["Crop", "Recortar", "Rogner", "Zuschneiden"]),
    ("anotada", ["annotated", "anotada", "annotée", "bearbeitet"]),
    ("Listo", ["Done", "Pronto", "Terminé", "Fertig"]),
    ("Color", ["Color", "Cor", "Couleur", "Farbe"]),
    ("Fino", ["Thin", "Fino", "Fin", "Dünn"]),
    ("Medio", ["Medium", "Médio", "Moyen", "Mittel"]),
    ("Grueso", ["Thick", "Grosso", "Épais", "Dick"]),
    ("Deshacer  (Ctrl+Z)", ["Undo  (Ctrl+Z)", "Desfazer  (Ctrl+Z)", "Annuler  (Ctrl+Z)", "Rückgängig  (Strg+Z)"]),
    ("Rehacer  (Ctrl+Y)", ["Redo  (Ctrl+Y)", "Refazer  (Ctrl+Y)", "Rétablir  (Ctrl+Y)", "Wiederholen  (Strg+Y)"]),
    ("Copiar  (Ctrl+C)", ["Copy  (Ctrl+C)", "Copiar  (Ctrl+C)", "Copier  (Ctrl+C)", "Kopieren  (Strg+C)"]),
    ("Guardar  (Ctrl+S) · Guardar como  (Ctrl+Mayús+S)", ["Save  (Ctrl+S) · Save as  (Ctrl+Shift+S)", "Salvar  (Ctrl+S) · Salvar como  (Ctrl+Shift+S)", "Enregistrer  (Ctrl+S) · Enregistrer sous  (Ctrl+Maj+S)", "Speichern  (Strg+S) · Speichern unter  (Strg+Umschalt+S)"]),
    ("Copiar, guardar y cerrar  (Enter)", ["Copy, save and close  (Enter)", "Copiar, salvar e fechar  (Enter)", "Copier, enregistrer et fermer  (Entrée)", "Kopieren, speichern und schließen  (Eingabe)"]),
    ("Ajustar / 100 %  (Ctrl+0 / Ctrl+1)", ["Fit / 100 %  (Ctrl+0 / Ctrl+1)", "Ajustar / 100 %  (Ctrl+0 / Ctrl+1)", "Ajuster / 100 %  (Ctrl+0 / Ctrl+1)", "Einpassen / 100 %  (Strg+0 / Strg+1)"]),
    ("recortado de {} × {}", ["cropped from {} × {}", "recortado de {} × {}", "rogné depuis {} × {}", "zugeschnitten aus {} × {}"]),
    ("ajustado", ["fit", "ajustado", "ajusté", "eingepasst"]),
    ("Clic para seleccionar · arrastra para mover · Supr borra", ["Click to select · drag to move · Delete removes", "Clique para selecionar · arraste para mover · Delete apaga", "Cliquez pour sélectionner · glissez pour déplacer · Suppr efface", "Klicken zum Auswählen · ziehen zum Verschieben · Entf löscht"]),
    ("Arrastra para dibujar · Mayús: ángulos de 45°", ["Drag to draw · Shift: 45° angles", "Arraste para desenhar · Shift: ângulos de 45°", "Glissez pour dessiner · Maj : angles de 45°", "Ziehen zum Zeichnen · Umschalt: 45°-Winkel"]),
    ("Arrastra para dibujar · Mayús: proporción 1:1", ["Drag to draw · Shift: 1:1 ratio", "Arraste para desenhar · Shift: proporção 1:1", "Glissez pour dessiner · Maj : proportion 1:1", "Ziehen zum Zeichnen · Umschalt: Verhältnis 1:1"]),
    ("Dibuja a mano alzada · Mayús: línea recta", ["Draw freehand · Shift: straight line", "Desenhe à mão livre · Shift: linha reta", "Dessinez à main levée · Maj : ligne droite", "Freihand zeichnen · Umschalt: gerade Linie"]),
    ("Clic para escribir · Enter termina · Mayús+Enter nueva línea", ["Click to type · Enter finishes · Shift+Enter new line", "Clique para escrever · Enter termina · Shift+Enter nova linha", "Cliquez pour écrire · Entrée termine · Maj+Entrée nouvelle ligne", "Klicken zum Schreiben · Eingabe beendet · Umschalt+Eingabe neue Zeile"]),
    ("Clic para numerar pasos", ["Click to number steps", "Clique para numerar passos", "Cliquez pour numéroter les étapes", "Klicken, um Schritte zu nummerieren"]),
    ("Arrastra sobre datos sensibles para ocultarlos", ["Drag over sensitive data to hide it", "Arraste sobre dados sensíveis para ocultá-los", "Glissez sur les données sensibles pour les masquer", "Über sensible Daten ziehen, um sie zu verbergen"]),
    ("Arrastra el área a conservar · Ctrl+Z deshace", ["Drag the area to keep · Ctrl+Z undoes", "Arraste a área a manter · Ctrl+Z desfaz", "Glissez la zone à conserver · Ctrl+Z annule", "Zu behaltenden Bereich ziehen · Strg+Z macht rückgängig"]),
    ("¿Quieres guardar los cambios de esta captura?", ["Save changes to this screenshot?", "Deseja salvar as alterações desta captura?", "Enregistrer les modifications de cette capture ?", "Änderungen an diesem Bildschirmfoto speichern?"]),
    // ---- file dialogs
    ("Imagen PNG (sin pérdida)", ["PNG image (lossless)", "Imagem PNG (sem perdas)", "Image PNG (sans perte)", "PNG-Bild (verlustfrei)"]),
    ("Imagen JPG", ["JPG image", "Imagem JPG", "Image JPG", "JPG-Bild"]),
    ("Carpeta para las capturas", ["Folder for screenshots", "Pasta para as capturas", "Dossier des captures", "Ordner für Bildschirmfotos"]),
    ("Imágenes", ["Images", "Imagens", "Images", "Bilder"]),
    ("Abrir imagen para anotar", ["Open image to annotate", "Abrir imagem para anotar", "Ouvrir une image à annoter", "Bild zum Bearbeiten öffnen"]),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Every literal passed to t()/tf() in the source must have a translation.
    #[test]
    fn every_string_is_translated() {
        let keys: std::collections::HashSet<&str> = ENTRIES.iter().map(|e| e.0).collect();
        assert_eq!(keys.len(), ENTRIES.len(), "duplicate entries");
        let mut missing = Vec::new();
        for entry in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src")).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().unwrap() == "i18n.rs" {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            for pat in ["t(\"", "tf(\""] {
                for (i, _) in src.match_indices(pat) {
                    // Only whole calls: t( must not be the tail of another identifier.
                    let prev = src[..i].chars().last().unwrap_or(' ');
                    if prev.is_alphanumeric() || prev == '_' {
                        continue;
                    }
                    // Sample content of the --preview desktop lives in plang.rs.
                    if src[..i].ends_with("plang::") {
                        continue;
                    }
                    let rest = &src[i + pat.len()..];
                    let end = rest.find('"').unwrap();
                    let lit = &rest[..end];
                    if !keys.contains(lit) {
                        missing.push(format!("{}: {lit}", path.display()));
                    }
                }
            }
        }
        assert!(missing.is_empty(), "missing translations:\n{}", missing.join("\n"));
    }

    #[test]
    fn placeholders_match() {
        for (es, tr) in ENTRIES {
            for t in tr {
                assert_eq!(es.matches("{}").count(), t.matches("{}").count(), "{es} -> {t}");
            }
        }
    }

    #[test]
    fn formats() {
        CURRENT.store(Lang::En as u8, Ordering::Relaxed);
        assert_eq!(tf("Color {} copiado", &[&"#FFFFFF"]), "Color #FFFFFF copied");
        CURRENT.store(Lang::Es as u8, Ordering::Relaxed);
        assert_eq!(tf("Color {} copiado", &[&"#FFFFFF"]), "Color #FFFFFF copiado");
    }
}
