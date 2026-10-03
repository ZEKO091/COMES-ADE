//! Language for `--preview` renders (`--preview DIR --lang en|pt|fr|de`), so the website can show
//! the screenshots in its five languages. Interface text comes from `i18n`; this table only holds
//! the synthetic desktop's sample content. Without `--lang`, previews stay in Spanish.

use std::sync::atomic::{AtomicU8, Ordering};

const CODES: [&str; 5] = ["es", "en", "pt", "fr", "de"];
static LANG: AtomicU8 = AtomicU8::new(0);

/// Selects the preview language by code. Unknown codes keep Spanish.
pub fn set(code: &str) {
    if let Some(i) = CODES.iter().position(|c| c.eq_ignore_ascii_case(code)) {
        LANG.store(i as u8, Ordering::Relaxed);
        crate::i18n::apply(CODES[i]);
    }
}

/// The preview translation of a Spanish string, or the string itself.
pub fn t(es: &'static str) -> &'static str {
    let i = LANG.load(Ordering::Relaxed) as usize;
    if i == 0 {
        return es;
    }
    TABLE.iter().find(|row| row[0] == es).map_or_else(|| crate::i18n::t(es), |row| row[i])
}

/// es, en, pt, fr, de — sample content of the synthetic desktop.
const TABLE: &[[&str; 5]] = &[
    ["Informe — Navegador", "Report — Browser", "Relatório — Navegador", "Rapport — Navigateur", "Bericht — Browser"],
    ["Panel de ventas", "Sales dashboard", "Painel de vendas", "Tableau des ventes", "Vertriebsübersicht"],
    ["Informe trimestral", "Quarterly report", "Relatório trimestral", "Rapport trimestriel", "Quartalsbericht"],
    [
        "Ventas totales: 128.400 €  ·  +12 % frente al trimestre anterior",
        "Total sales: €128,400  ·  +12 % on the previous quarter",
        "Vendas totais: 128.400 €  ·  +12 % em relação ao trimestre anterior",
        "Ventes totales : 128 400 €  ·  +12 % par rapport au trimestre précédent",
        "Gesamtumsatz: 128.400 €  ·  +12 % gegenüber dem Vorquartal",
    ],
    ["Clientes activos: 3.912", "Active customers: 3,912", "Clientes ativos: 3.912", "Clients actifs : 3 912", "Aktive Kunden: 3.912"],
    [
        "Correo de contacto: ana.garcia@ejemplo.com",
        "Contact email: ana.garcia@example.com",
        "E-mail de contato: ana.garcia@exemplo.com",
        "E-mail de contact : ana.garcia@exemple.com",
        "Kontakt-E-Mail: ana.garcia@beispiel.de",
    ],
    ["Teléfono: +34 600 123 456", "Phone: +34 600 123 456", "Telefone: +34 600 123 456", "Téléphone : +34 600 123 456", "Telefon: +34 600 123 456"],
    ["Haz clic aquí", "Click here", "Clique aqui", "Cliquez ici", "Hier klicken"],
];
