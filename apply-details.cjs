const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'src', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

const detailOverrides = `

/* =========================================
   DETALLES DE INTERFAZ & SCROLL (LOGO BRAND)
   ========================================= */

/* 1. Scrollbars (Barras de desplazamiento) - Color sólido al pasar el mouse */
::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
::-webkit-scrollbar-track {
  background: var(--bg-sidebar); 
}
::-webkit-scrollbar-thumb {
  background: #26292E; 
  border-radius: 6px;
  border: 3px solid var(--bg-sidebar); /* Efecto de padding invisible */
}
::-webkit-scrollbar-thumb:hover {
  background: #1378FF; /* Azul sólido eléctrico de tu logo */
}

/* 2. Selección de Texto (Highlight) */
::selection {
  background: rgba(19, 120, 255, 0.35); /* Azul translúcido */
  color: #FFFFFF;
}

/* 3. El "Pequeño Neón" - Brillo sutil y elegante en Inputs seleccionados */
.sidebar-search-input:focus, 
.field-input:focus, 
.inspector-search-input:focus, 
.command-input:focus, 
#notes-input:focus {
  background: rgba(0, 0, 0, 0.4) !important;
  border-color: #1378FF !important; /* Borde sólido azul */
  box-shadow: 
    inset 0 2px 5px rgba(0, 0, 0, 0.6),       /* Profundidad interna */
    0 0 0 1px #1378FF,                        /* Anillo sólido exterior */
    0 0 10px rgba(19, 120, 255, 0.35) !important; /* <--- EL PEQUEÑO NEÓN */
}

/* 4. Pestañas activas (Tabs) - Línea sólida Azul */
.workspace-tab.active,
.panel-tab.active,
.tab.active {
  border-bottom: 2px solid #1378FF !important;
  color: #FFFFFF !important;
  background: linear-gradient(to top, rgba(19, 120, 255, 0.05) 0%, transparent 100%);
}
`;

if (!css.includes('DETALLES DE INTERFAZ & SCROLL')) {
  css += detailOverrides;
  fs.writeFileSync(cssPath, css);
  console.log('Detalles aplicados exitosamente (Scroll, Tabs, Selección y pequeño Neón).');
} else {
  console.log('Los detalles ya habían sido aplicados.');
}
