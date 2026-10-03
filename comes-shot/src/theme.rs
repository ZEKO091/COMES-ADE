//! Comes Shot colours. Charcoal surfaces with ComesADE blue as the one
//! active colour, taken from the ComesADE logo (white C + blue bolt).

pub const BLUE: u32 = 0x1A7DFF;
pub const BLUE_HOVER: u32 = 0x3D92FF;
pub const BG: u32 = 0x0B0C0F;
pub const PANEL: u32 = 0x141619;
pub const PANEL_2: u32 = 0x1C1F24;
pub const PANEL_3: u32 = 0x262A31;
pub const HAIRLINE: u32 = 0x2C3038;
pub const TEXT: u32 = 0xEDEFF3;
pub const MUTED: u32 = 0x8D94A1;
pub const WHITE: u32 = 0xFFFFFF;
pub const BLACK: u32 = 0x000000;

pub const FONT: &str = "Segoe UI";

/// Annotation palette offered in the editor.
pub const PALETTE: [u32; 7] = [
    0xFF3B30, // rojo
    0xFF9F0A, // naranja
    0xFFD60A, // amarillo
    0x30D158, // verde
    0x1A7DFF, // azul ComesADE
    0xFFFFFF, // blanco
    0x111317, // negro
];
