const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'src', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

const waterGlassOverrides = `

/* =========================================
   EFECTO "WATER GLASS" (Flat Semi-Skeumorphic + Glassmorphism)
   ========================================= */

/* 1. Cabecera (Titlebar / Header) - Efecto cristal esmerilado que deja ver el contenido al hacer scroll debajo */
.titlebar,
.app-header,
header {
  background: rgba(9, 10, 12, 0.65) !important; 
  backdrop-filter: blur(20px) saturate(180%) !important;
  -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.05), /* Reflejo sutil superior del cristal */
    0 4px 12px rgba(0, 0, 0, 0.3) !important;
}

/* 2. Modales, Menús Flotantes y Paneles Emergentes - Cristal puro con bordes biselados */
.modal,
.dropdown,
.context-menu,
.main-menu-panel,
.toast {
  background: rgba(16, 17, 20, 0.65) !important; /* Base semitransparente */
  backdrop-filter: blur(28px) saturate(200%) !important;
  -webkit-backdrop-filter: blur(28px) saturate(200%) !important;
  
  /* El borde brillante imita el corte biselado de un panel de vidrio grueso */
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.15),  /* Luz rebotando en el borde superior del cristal */
    inset 0 -1px 0 rgba(0, 0, 0, 0.4),        /* Sombra interna inferior */
    0 20px 40px rgba(0, 0, 0, 0.7) !important; /* Sombra pesada para separarlo del fondo */
}

/* 3. Botones Flotantes o Badges (Un toque ligero de cristal) */
.session-badge,
.branch-badge,
.floating-action {
  background: rgba(19, 120, 255, 0.15) !important; /* Tinte de tu Azul Logo */
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  border: 1px solid rgba(19, 120, 255, 0.3) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
}

/* 4. Panel lateral (Subtle Glass) - Para que se mezcle ligeramente con el fondo principal */
.app-sidebar {
  background: rgba(9, 10, 12, 0.85) !important;
  backdrop-filter: blur(16px) !important;
  -webkit-backdrop-filter: blur(16px) !important;
  border-right: 1px solid rgba(255, 255, 255, 0.05) !important;
}
`;

if (!css.includes('EFECTO "WATER GLASS"')) {
  css += waterGlassOverrides;
  fs.writeFileSync(cssPath, css);
  console.log('Efecto Water Glass aplicado exitosamente.');
} else {
  console.log('El efecto Water Glass ya estaba aplicado.');
}
