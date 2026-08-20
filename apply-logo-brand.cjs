const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'src', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

// 1. Update the hardcoded RGB values for the old pastel blue (137, 180, 250) to the new brand blue (19, 120, 255)
css = css.replace(/137,\s*180,\s*250/g, '19, 120, 255');

// 2. Add an override at the end of the file to style .primary-button with the new Brand Blue
const brandOverrides = `

/* =========================================
   BRAND IDENTITY OVERRIDES (COMES ADE LOGO)
   ========================================= */

/* The primary buttons get the solid electric blue from the logo with a tactile glossy finish */
.primary-button {
  background: linear-gradient(180deg, #2E88FF 0%, #0064EB 100%) !important; 
  border-color: rgba(255, 255, 255, 0.25) !important;
  color: #FFFFFF !important;
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.3),   /* Stronger white top highlight for blue */
    inset 0 -1px 0 rgba(0, 0, 0, 0.2),       
    0 1px 3px rgba(0, 0, 0, 0.5)
    !important;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6) !important;
}

.primary-button:hover {
  background: linear-gradient(180deg, #4596FF 0%, #1378FF 100%) !important;
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    inset 0 -1px 0 rgba(0, 0, 0, 0.2),
    0 2px 5px rgba(0, 0, 0, 0.6)
    !important;
}

.primary-button:active {
  background: #0056D1 !important;
  box-shadow: 
    inset 0 2px 4px rgba(0, 0, 0, 0.5),      
    inset 0 0 0 1px rgba(0, 0, 0, 0.3)
    !important;
  transform: translateY(1px);
}

/* Any item explicitly declaring brand-text should be pure white or blue depending on context */
.header-button-primary,
.sidebar-runtime-button.active {
  color: var(--blue) !important;
}
`;

if (!css.includes('BRAND IDENTITY OVERRIDES')) {
  css += brandOverrides;
}

fs.writeFileSync(cssPath, css);
console.log('Brand identity (Solid Electric Blue & White) applied successfully.');
