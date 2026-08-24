/**
 * Rebuilds pt/fr/de catalogs in src/i18n.ts from en+es so every key is localized.
 * pt is adapted from Spanish; fr/de from English with UI phrase maps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'i18n.ts');
let source = fs.readFileSync(file, 'utf8');

function extractObject(name) {
  const marker = `const ${name}: Messages = {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${name}`);
  let i = start + marker.length;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  const body = source.slice(start + marker.length, i - 1);
  const obj = {};
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = re.exec(body))) {
    obj[match[1]] = match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  // Spread references like ...en are not captured; fill later.
  return { start, end: i, obj };
}

function escapeValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function serialize(name, baseSpread, obj) {
  const lines = [`const ${name}: Messages = {`, `  ...${baseSpread},`];
  for (const [key, value] of Object.entries(obj)) {
    lines.push(`  '${key}': '${escapeValue(value)}',`);
  }
  lines.push('};');
  return lines.join('\n');
}

function applyPairs(text, pairs) {
  let out = text;
  for (const [from, to] of pairs) {
    out = out.split(from).join(to);
  }
  return out;
}

const esToPt = [
  ['Espacio de trabajo', 'Espaço de trabalho'],
  ['espacio de trabajo', 'espaço de trabalho'],
  ['Configuración', 'Definições'],
  ['configuración', 'definições'],
  ['Archivo', 'Ficheiro'],
  ['archivo', 'ficheiro'],
  ['Archivos', 'Ficheiros'],
  ['archivos', 'ficheiros'],
  ['Carpeta', 'Pasta'],
  ['carpeta', 'pasta'],
  ['Sesión', 'Sessão'],
  ['sesión', 'sessão'],
  ['Sesiones', 'Sessões'],
  ['sesiones', 'sessões'],
  ['Guardar', 'Guardar'],
  ['guardar', 'guardar'],
  ['Cancelar', 'Cancelar'],
  ['Abrir', 'Abrir'],
  ['Cerrar', 'Fechar'],
  ['cerrar', 'fechar'],
  ['Eliminar', 'Eliminar'],
  ['eliminar', 'eliminar'],
  ['Descartar', 'Descartar'],
  ['Renombrar', 'Mudar o nome'],
  ['renombrar', 'mudar o nome'],
  ['Mover', 'Mover'],
  ['Crear', 'Criar'],
  ['crear', 'criar'],
  ['Buscar', 'Procurar'],
  ['buscar', 'procurar'],
  ['Actualizar', 'Atualizar'],
  ['actualizar', 'atualizar'],
  ['Instalar', 'Instalar'],
  ['Conectar', 'Ligar'],
  ['conectar', 'ligar'],
  ['Desconectar', 'Desligar'],
  ['Idioma', 'Idioma'],
  ['Micrófono', 'Microfone'],
  ['micrófono', 'microfone'],
  ['Terminal', 'Terminal'],
  ['Navegador', 'Navegador'],
  ['Agente', 'Agente'],
  ['Agentes', 'Agentes'],
  ['Cuenta', 'Conta'],
  ['cuenta', 'conta'],
  ['Cuentas', 'Contas'],
  ['cuentas', 'contas'],
  ['Contraseña', 'Palavra-passe'],
  ['correo', 'email'],
  ['Correo', 'Email'],
  ['también', 'também'],
  ['aquí', 'aqui'],
  ['está', 'está'],
  ['están', 'estão'],
  ['tienes', 'tens'],
  ['puedes', 'podes'],
  ['quiere', 'quer'],
  ['quieres', 'queres'],
  ['selecciona', 'seleciona'],
  ['Selecciona', 'Seleciona'],
  ['seleccione', 'selecione'],
  ['disponible', 'disponível'],
  ['Disponible', 'Disponível'],
  ['disponibles', 'disponíveis'],
  ['configuración', 'definições'],
  ['información', 'informação'],
  ['aplicación', 'aplicação'],
  ['transcripción', 'transcrição'],
  ['dictado', 'ditado'],
  ['Dictado', 'Ditado'],
  ['grabación', 'gravação'],
  ['¿', ''],
  ['¡', ''],
  [' todavía', ' ainda'],
  [' también', ' também'],
  [' ningún', ' nenhum'],
  [' ninguna', ' nenhuma'],
  ['No hay', 'Não há'],
  ['no hay', 'não há'],
  ['No se', 'Não se'],
  ['no se', 'não se'],
  ['No se pudo', 'Não foi possível'],
  ['No se pudo ', 'Não foi possível '],
  ['Este PC', 'Este PC'],
  ['este PC', 'este PC'],
  ['real', 'real'],
  ['locales', 'locais'],
  ['local', 'local'],
  ['proyecto', 'projeto'],
  ['Proyecto', 'Projeto'],
  ['proyectos', 'projetos'],
  ['cambios', 'alterações'],
  ['Cambios', 'Alterações'],
  ['sin guardar', 'por guardar'],
  ['Sin ', 'Sem '],
  ['sin ', 'sem '],
  ['Hace falta', 'É preciso'],
  ['hace falta', 'é preciso'],
  ['Abre ', 'Abre '],
  ['abre ', 'abre '],
  ['Pulsa ', 'Prima '],
  ['pulsa ', 'prima '],
  ['mensaje', 'mensagem'],
  ['Mensaje', 'Mensagem'],
  ['mensajes', 'mensagens'],
  ['error', 'erro'],
  ['Error', 'Erro'],
  ['espera', 'espera'],
  ['Esperando', 'A aguardar'],
  ['esperando', 'a aguardar'],
  ['Cargando', 'A carregar'],
  ['cargando', 'a carregar'],
  ['Consultando', 'A consultar'],
  ['Instalando', 'A instalar'],
  ['Descargando', 'A transferir'],
  ['Actualización', 'Atualização'],
  ['actualización', 'atualização'],
  ['actualizaciones', 'atualizações'],
  ['versión', 'versão'],
  ['Versión', 'Versão'],
  ['rama', 'ramo'],
  ['Rama', 'Ramo'],
  ['ramas', 'ramos'],
  ['confirmación', 'confirmação'],
  ['Continuar', 'Continuar'],
  ['Aceptar', 'OK'],
  ['Listo', 'Pronto'],
  ['listo', 'pronto'],
  ['Ayuda', 'Ajuda'],
  ['ayuda', 'ajuda'],
  ['Atajos', 'Atalhos'],
  ['atajos', 'atalhos'],
  ['Vista previa', 'Pré-visualização'],
  ['vista previa', 'pré-visualização'],
  ['Nueva ', 'Nova '],
  ['Nuevo ', 'Novo '],
  ['nueva ', 'nova '],
  ['nuevo ', 'novo '],
  ['Nombre', 'Nome'],
  ['nombre', 'nome'],
  ['Ruta', 'Caminho'],
  ['ruta', 'caminho'],
  ['carpeta local', 'pasta local'],
  ['repositorio', 'repositório'],
  ['Repositorio', 'Repositório'],
  ['repositorios', 'repositórios'],
  ['privado', 'privado'],
  ['público', 'público'],
  ['descripción', 'descrição'],
  ['Descripción', 'Descrição'],
  ['vacío', 'vazio'],
  ['Vacío', 'Vazio'],
  ['vacía', 'vazia'],
  ['limpio', 'limpo'],
  ['Limpio', 'Limpo'],
  ['fusionar', 'fundir'],
  ['Fusionar', 'Fundir'],
  ['quitar', 'remover'],
  ['Quitar', 'Remover'],
  ['añadir', 'adicionar'],
  ['Añadir', 'Adicionar'],
  ['agregar', 'adicionar'],
  ['opcional', 'opcional'],
  ['Obligatorio', 'Obrigatório'],
  ['predeterminado', 'predefinido'],
  ['Predeterminado', 'Predefinido'],
  ['fuente', 'tipo de letra'],
  ['Fuente', 'Tipo de letra'],
  ['tamaño', 'tamanho'],
  ['Tamaño', 'Tamanho'],
  ['historial', 'histórico'],
  ['Historial', 'Histórico'],
  ['variable', 'variável'],
  ['variables', 'variáveis'],
  ['entorno', 'ambiente'],
  ['Acerca de', 'Acerca de'],
  ['suscripción', 'subscrição'],
  ['Suscripción', 'Subscrição'],
  ['plan', 'plano'],
  ['Plan', 'Plano'],
  ['uso', 'utilização'],
  ['Uso', 'Utilização'],
  ['tokens', 'tokens'],
  ['voz', 'voz'],
  ['Voz', 'Voz'],
  ['habla', 'fala'],
  ['Habla', 'Fala'],
  ['transcribir', 'transcrever'],
  ['Transcribir', 'Transcrever'],
  ['Transcribiendo', 'A transcrever'],
  ['grabar', 'gravar'],
  ['Grabación', 'Gravação'],
  ['dispositivo', 'dispositivo'],
  ['Dispositivo', 'Dispositivo'],
  ['sistema', 'sistema'],
  ['Sistema', 'Sistema'],
  ['Windows', 'Windows'],
  ['Explorador', 'Explorador'],
  ['explorador', 'explorador'],
  ['portapapeles', 'área de transferência'],
  ['Portapapeles', 'Área de transferência'],
  ['copiar', 'copiar'],
  ['Copiar', 'Copiar'],
  ['pegar', 'colar'],
  ['Pegar', 'Colar'],
  ['enviar', 'enviar'],
  ['Enviar', 'Enviar'],
  ['detener', 'parar'],
  ['Detener', 'Parar'],
  ['iniciar', 'iniciar'],
  ['Iniciar', 'Iniciar'],
  ['sesión de', 'sessão de'],
  ['proceso', 'processo'],
  ['Proceso', 'Processo'],
  ['procesos', 'processos'],
  ['servidor', 'servidor'],
  ['Servidor', 'Servidor'],
  ['navegador integrado', 'navegador integrado'],
  ['vista local', 'vista local'],
  ['dirección', 'endereço'],
  ['Dirección', 'Endereço'],
  ['búsqueda', 'pesquisa'],
  ['Búsqueda', 'Pesquisa'],
  ['resultado', 'resultado'],
  ['Resultado', 'Resultado'],
  ['resultados', 'resultados'],
  ['filtro', 'filtro'],
  ['Filtro', 'Filtro'],
  ['ordenar', 'ordenar'],
  ['Ordenar', 'Ordenar'],
  ['contenido', 'conteúdo'],
  ['Contenido', 'Conteúdo'],
  ['nombres', 'nomes'],
  ['Nombres', 'Nomes'],
  ['padre', 'pai'],
  ['relativa', 'relativa'],
  ['absoluta', 'absoluta'],
  ['disco', 'disco'],
  ['continuar', 'continuar'],
  ['¿Continuar?', 'Continuar?'],
  ['¿Descartarlos', 'Descartá-los'],
  ['¿Abrir', 'Abrir'],
  ['¿Cerrar', 'Fechar'],
  ['¿Eliminar', 'Eliminar'],
  ['esto ', 'isto '],
  ['Esto ', 'Isto '],
  ['del ', 'do '],
  ['de la ', 'da '],
  ['de los ', 'dos '],
  ['de las ', 'das '],
  ['una ', 'uma '],
  ['Un ', 'Um '],
  ['Una ', 'Uma '],
  ['el ', 'o '],
  ['El ', 'O '],
  ['la ', 'a '],
  ['La ', 'A '],
  ['los ', 'os '],
  ['Los ', 'Os '],
  ['las ', 'as '],
  ['Las ', 'As '],
  ['al ', 'ao '],
  ['Al ', 'Ao '],
  ['y ', 'e '],
  ['Y ', 'E '],
  ['o ', 'ou '],
  ['O ', 'Ou '],
  ['para ', 'para '],
  ['con ', 'com '],
  ['Con ', 'Com '],
  ['sin ', 'sem '],
  ['por ', 'por '],
  ['en ', 'em '],
  ['En ', 'Em '],
  ['desde ', 'desde '],
  ['hasta ', 'até '],
  ['más ', 'mais '],
  ['Más ', 'Mais '],
  ['menos ', 'menos '],
  ['muy ', 'muito '],
  ['también', 'também'],
  ['después', 'depois'],
  ['antes', 'antes'],
  ['ahora', 'agora'],
  ['siempre', 'sempre'],
  ['nunca', 'nunca'],
  ['solo', 'só'],
  ['Sólo', 'Só'],
  ['sólo', 'só'],
  ['todos', 'todos'],
  ['todas', 'todas'],
  ['otro', 'outro'],
  ['otra', 'outra'],
  ['otros', 'outros'],
  ['otras', 'outras'],
  ['este', 'este'],
  ['esta', 'esta'],
  ['estos', 'estes'],
  ['estas', 'estas'],
  ['ese', 'esse'],
  ['esa', 'essa'],
  ['aquella', 'aquela'],
  ['aquel', 'aquele'],
];

const enToFr = [
  ['Workspace', 'Espace de travail'],
  ['workspace', 'espace de travail'],
  ['Settings', 'Réglages'],
  ['settings', 'réglages'],
  ['Account', 'Compte'],
  ['Accounts', 'Comptes'],
  ['Sign in', 'Connexion'],
  ['Sign out', 'Déconnexion'],
  ['Cancel', 'Annuler'],
  ['Continue', 'Continuer'],
  ['Close', 'Fermer'],
  ['Save', 'Enregistrer'],
  ['Delete', 'Supprimer'],
  ['Rename', 'Renommer'],
  ['Move', 'Déplacer'],
  ['Create', 'Créer'],
  ['Open', 'Ouvrir'],
  ['Search', 'Rechercher'],
  ['Refresh', 'Actualiser'],
  ['Install', 'Installer'],
  ['Update', 'Mettre à jour'],
  ['Language', 'Langue'],
  ['Microphone', 'Microphone'],
  ['Terminal', 'Terminal'],
  ['Browser', 'Navigateur'],
  ['Agents', 'Agents'],
  ['Agent', 'Agent'],
  ['Files', 'Fichiers'],
  ['File', 'Fichier'],
  ['Folder', 'Dossier'],
  ['Sessions', 'Sessions'],
  ['Session', 'Session'],
  ['Password', 'Mot de passe'],
  ['Email', 'E-mail'],
  ['Error', 'Erreur'],
  ['Loading', 'Chargement'],
  ['Waiting', 'En attente'],
  ['Ready', 'Prêt'],
  ['Help', 'Aide'],
  ['Back', 'Retour'],
  ['New ', 'Nouveau '],
  ['No ', 'Aucun '],
  ['not ', 'pas '],
  ['and ', 'et '],
  ['or ', 'ou '],
  ['to ', 'pour '],
  ['from ', 'depuis '],
  ['with ', 'avec '],
  ['without ', 'sans '],
  ['this ', 'ce '],
  ['your ', 'votre '],
  ['the ', 'le '],
  ['a ', 'un '],
  ['an ', 'un '],
];

const enToDe = [
  ['Workspace', 'Workspace'],
  ['workspace', 'Workspace'],
  ['Settings', 'Einstellungen'],
  ['settings', 'Einstellungen'],
  ['Account', 'Konto'],
  ['Accounts', 'Konten'],
  ['Sign in', 'Anmelden'],
  ['Sign out', 'Abmelden'],
  ['Cancel', 'Abbrechen'],
  ['Continue', 'Weiter'],
  ['Close', 'Schließen'],
  ['Save', 'Speichern'],
  ['Delete', 'Löschen'],
  ['Rename', 'Umbenennen'],
  ['Move', 'Verschieben'],
  ['Create', 'Erstellen'],
  ['Open', 'Öffnen'],
  ['Search', 'Suchen'],
  ['Refresh', 'Aktualisieren'],
  ['Install', 'Installieren'],
  ['Update', 'Aktualisieren'],
  ['Language', 'Sprache'],
  ['Microphone', 'Mikrofon'],
  ['Terminal', 'Terminal'],
  ['Browser', 'Browser'],
  ['Agents', 'Agenten'],
  ['Agent', 'Agent'],
  ['Files', 'Dateien'],
  ['File', 'Datei'],
  ['Folder', 'Ordner'],
  ['Sessions', 'Sitzungen'],
  ['Session', 'Sitzung'],
  ['Password', 'Passwort'],
  ['Email', 'E-Mail'],
  ['Error', 'Fehler'],
  ['Loading', 'Laden'],
  ['Waiting', 'Warten'],
  ['Ready', 'Bereit'],
  ['Help', 'Hilfe'],
  ['Back', 'Zurück'],
  ['New ', 'Neu '],
  ['No ', 'Kein '],
  ['not ', 'nicht '],
  ['and ', 'und '],
  ['or ', 'oder '],
  ['to ', 'zu '],
  ['from ', 'von '],
  ['with ', 'mit '],
  ['without ', 'ohne '],
  ['this ', 'dieses '],
  ['your ', 'Ihr '],
  ['the ', 'die '],
  ['a ', 'ein '],
  ['an ', 'ein '],
];

function translateMap(base, pairs, manual = {}) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (manual[key]) {
      out[key] = manual[key];
      continue;
    }
    out[key] = applyPairs(value, pairs);
  }
  return out;
}

const enBlock = extractObject('en');
const esBlock = extractObject('es');
const en = enBlock.obj;
const es = { ...en, ...esBlock.obj };

// Ensure es has every en key (fill gaps with en for lang names etc., then override)
for (const key of Object.keys(en)) {
  if (!(key in esBlock.obj) && key.startsWith('lang.')) es[key] = en[key];
  if (!(key in esBlock.obj) && key === 'chrome.ai') es[key] = 'IA';
  if (!(key in esBlock.obj) && key === 'chrome.runtime') es[key] = 'Runtime';
  if (!(key in esBlock.obj) && key === 'chrome.path') es[key] = 'Ruta';
}

const ptManual = {
  'lang.auto': 'Automático (dispositivo + IP)',
  'lang.section': 'Idioma',
  'common.settings': 'Definições',
  'common.signIn': 'Iniciar sessão',
  'common.signOut': 'Terminar sessão',
  'auth.title': 'Iniciar sessão',
  'auth.password': 'Palavra-passe',
  'menu.title': 'Onde quer trabalhar?',
  'settings.title': 'Definições',
  'chrome.files': 'Ficheiros',
  'chrome.newTerminal': 'Novo terminal',
  'chrome.noWorkspace': 'Sem workspace',
};

const frManual = {
  'lang.auto': 'Automatique (appareil + IP)',
  'lang.section': 'Langue',
  'common.settings': 'Réglages',
  'common.signIn': 'Connexion',
  'common.signOut': 'Déconnexion',
  'auth.title': 'Connexion',
  'auth.password': 'Mot de passe',
  'menu.title': 'Où voulez-vous travailler ?',
  'settings.title': 'Réglages',
  'chrome.files': 'Fichiers',
  'chrome.newTerminal': 'Nouveau terminal',
  'chrome.noWorkspace': 'Aucun workspace',
};

const deManual = {
  'lang.auto': 'Automatisch (Gerät + IP)',
  'lang.section': 'Sprache',
  'common.settings': 'Einstellungen',
  'common.signIn': 'Anmelden',
  'common.signOut': 'Abmelden',
  'auth.title': 'Anmelden',
  'auth.password': 'Passwort',
  'menu.title': 'Wo möchten Sie arbeiten?',
  'settings.title': 'Einstellungen',
  'chrome.files': 'Dateien',
  'chrome.newTerminal': 'Neues Terminal',
  'chrome.noWorkspace': 'Kein Workspace',
};

const pt = translateMap(es, esToPt, ptManual);
const fr = translateMap(en, enToFr, frManual);
const de = translateMap(en, enToDe, deManual);

const ptStart = source.indexOf('const pt: Messages = {');
const catalogsStart = source.indexOf('const catalogs:');
if (ptStart < 0 || catalogsStart < 0) throw new Error('Could not find pt/catalogs markers');

const rebuilt = [
  serialize('pt', 'en', pt),
  '',
  serialize('fr', 'en', fr),
  '',
  serialize('de', 'en', de),
  '',
].join('\n');

source = source.slice(0, ptStart) + rebuilt + source.slice(catalogsStart);
fs.writeFileSync(file, source);
console.log(`Filled pt=${Object.keys(pt).length} fr=${Object.keys(fr).length} de=${Object.keys(de).length}`);
