const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'src', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

const skeumorphicImprovements = `

/* =========================================
   FLAT SEMI-SKEUMORPHIC V2 (Ultra-Refined)
   ========================================= */

/* 1. Paneles Principales (El "Chasis")
   Simulamos materialidad (plástico mate / aluminio oscuro)
   con un filo de luz imperceptible arriba y sombra abajo. */
.app-sidebar, .app-inspector, .app-header, .panel, .main-menu-panel {
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.03), /* Luz cenital hiper sutil */
    inset 1px 0 0 rgba(255, 255, 255, 0.01), /* Luz lateral izquierda */
    0 4px 12px rgba(0, 0, 0, 0.15) !important;
}

/* 2. Botones Secundarios y Controles Universales (Teclas físicas) */
.header-button, .secondary-button, .titlebar-action, .sidebar-new-session, .icon-button {
  /* Fondo mate con un ligerísimo gradiente convexo */
  background: linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%), var(--bg-panel-2) !important;
  border: 1px solid rgba(0, 0, 0, 0.4) !important;
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.12), /* Borde superior iluminado */
    inset 0 -1px 1px rgba(0, 0, 0, 0.2),       /* Borde inferior oscurecido */
    0 1px 2px rgba(0, 0, 0, 0.5)               /* Sombra proyectada */
    !important;
  border-radius: 6px;
  transition: all 0.1s cubic-bezier(0.4, 0.0, 0.2, 1);
}

.header-button:hover, .secondary-button:hover, .icon-button:hover {
  background: linear-gradient(180deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.04) 100%), var(--bg-panel-3) !important;
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.15),
    inset 0 -1px 1px rgba(0, 0, 0, 0.25),
    0 2px 4px rgba(0, 0, 0, 0.6)
    !important;
}

/* 3. Botones Primarios (La Gema de la Corona)
   Botón azul intenso y táctil, con su propia luz difusa proyectada (Glow físico). */
.primary-button {
  background: linear-gradient(180deg, #2E88FF 0%, #0064EB 100%) !important; 
  border: 1px solid rgba(0, 0, 0, 0.5) !important;
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.35), /* Brillo superior nítido */
    inset 0 -1px 2px rgba(0, 0, 0, 0.3),       /* Sombra inferior del botón */
    0 2px 5px rgba(19, 120, 255, 0.4),         /* Sombra proyectada azulada (física) */
    0 1px 1px rgba(0, 0, 0, 0.4)
    !important;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5) !important;
  border-radius: 6px;
}

.primary-button:hover {
  background: linear-gradient(180deg, #4596FF 0%, #1378FF 100%) !important;
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.45),
    inset 0 -1px 2px rgba(0, 0, 0, 0.3),
    0 4px 8px rgba(19, 120, 255, 0.5),
    0 2px 3px rgba(0, 0, 0, 0.5)
    !important;
}

/* 4. Efecto de Pulsación (Depresión física real para todos los botones) */
.header-button:active, .primary-button:active, .secondary-button:active, .titlebar-action:active, .icon-button:active {
  background: var(--bg-panel) !important;
  /* Al presionarlo, pierde la luz superior, gana sombra interna y la sombra exterior desaparece */
  box-shadow: 
    inset 0 2px 4px rgba(0, 0, 0, 0.4),      
    inset 0 0 0 1px rgba(0, 0, 0, 0.6),
    0 0 0 transparent
    !important;
  transform: translateY(1px) scale(0.98);
}
.primary-button:active {
  background: #0056D1 !important;
  box-shadow: 
    inset 0 2px 5px rgba(0, 0, 0, 0.5),
    inset 0 0 0 1px rgba(0, 0, 0, 0.7)
    !important;
}

/* 5. Inputs y Textareas (Agujeros tallados en la superficie) */
.sidebar-search-input, .field-input, .inspector-search-input, .command-input, #notes-input, .command-form {
  background: rgba(0, 0, 0, 0.35) !important; /* Más profundo */
  border: 1px solid rgba(0, 0, 0, 0.6) !important;
  box-shadow: 
    inset 0 2px 4px rgba(0, 0, 0, 0.5),       /* Sombra de oclusión superior interna */
    inset 0 1px 2px rgba(0, 0, 0, 0.3),
    0 1px 0 rgba(255, 255, 255, 0.05)         /* Labio inferior que atrapa la luz (clave del skeuomorphism) */
    !important;
  border-radius: 4px;
}
`;

if (!css.includes('FLAT SEMI-SKEUMORPHIC V2')) {
  css += skeumorphicImprovements;
  fs.writeFileSync(cssPath, css);
  console.log('Mejoras de Skeumorphism V2 aplicadas con éxito.');
} else {
  console.log('Skeumorphism V2 ya estaba aplicado.');
}
