import fs from 'node:fs';

const path = new URL('../src/i18n.ts', import.meta.url);
let src = fs.readFileSync(path, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';
if (src.includes("'menu.githubPressRefresh'")) {
  console.log('already present');
  process.exit(0);
}
const withNl = (block) => block.replaceAll('\n', nl);

const enInsert = `  'menu.githubPublic': 'PUBLIC',
  'menu.githubPressRefresh': 'Press refresh to load repositories for this account.',
  'menu.githubUserFallback': 'user',
  'composer.manageAccounts': 'Manage accounts',
  'composer.manageAccountsHint': 'Connect or disconnect providers',
  'composer.connectModel': 'Connect an account to choose a model',
  'chrome.filterSessionsLive': 'Filters: live sessions only',
  'chrome.sortByName': 'Sort by name',
  'chrome.sortByType': 'Sort by type',
  'chrome.emptyFolder': 'Empty folder.',
  'chrome.closeFile': 'Close file',
  'chrome.openExternal': 'Open externally',
  'chrome.gitInstallDiff': 'Install Git to see real diffs.',
  'chrome.gitDiffFail': 'Could not read the real diff: {error}',
  'chrome.noDiffFile': 'No diff for this file.',
  'usage.resetNow': 'available now',
  'usage.resetInSec': 'in {seconds} s',
  'usage.resetInMin': 'in {minutes} min',
  'usage.resetInHours': 'in {hours} h',
  'usage.resetInHoursMin': 'in {hours} h {minutes} min',
  'usage.resetInDays': 'in {days} d',
  'session.unavailable': 'Unavailable',
  'session.unavailableError': 'Unavailable: {error}',
  'session.workingDir': 'Current working directory',
  'session.mainRepo': 'Main repository',
  'session.processLog': 'Process record',
  'session.gitReal': 'Calculated from real Git',
  'session.labelAgent': 'AGENT / SHELL',
  'session.labelStatus': 'STATUS / PID',
  'session.labelDirectory': 'DIRECTORY',
  'session.labelWorktree': 'WORKTREE / BRANCH',
  'session.labelStarted': 'STARTED',
  'session.labelFiles': 'FILES CHANGED',
  'window.controls': 'Window controls',
  'window.close': 'Close ComesADE',
  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize or restore',
  'toast.windowMinimizeFail': 'Could not minimize',
  'toast.windowMaximizeFail': 'Could not maximize',
  'toast.windowCloseFail': 'Could not close',
  'toast.windowMoveFail': 'Could not move the window',
  'toast.sttFail': 'Could not transcribe audio in ComesADE.',
  'toast.sttTimeout': 'Speech transcription in ComesADE timed out.',
  'search.title': 'Search files',
  'search.copy': 'Search real workspace files. Excludes .git, node_modules, target and dist.',
  'search.placeholder': 'text to find',
  'search.empty': 'Type a query.',
  'search.searching': 'Searching the filesystem…',
  'search.noMatches': 'No real matches found.',
  'search.close': 'Close search',
  'search.options': 'Search options',
  'search.content': 'Search content',
  'search.files': 'Files',
  'search.regex': 'Regex',
  'search.case': 'Case sensitive',
  'search.whole': 'Whole word',
  'search.submit': 'Search',
  'search.eyebrow': 'PROJECT / SEARCH',
  'design.capture': 'Capture',
  'design.captureN': 'Capture {n}',
  'design.remove': 'Remove',
  'design.removeCapture': 'Remove capture',
  'design.dragHint': 'Drag a region of the preview to capture it',
  'prompt.designCapture': 'Change the UI in this capture in the real workspace code.',
  'prompt.editSelection': 'Edit {file}{range}. Keep the rest of the file and apply only this change.\\n\\nSelection:\\n\`\`\`\\n{selection}\\n\`\`\`\\n\\nInstruction: ',
  'prompt.editFile': 'Edit {file}. Apply the change with write_file.\\n\\nInstruction: ',
  'prompt.workspaceFallback': 'the workspace',
  'prompt.linesRange': ' lines {start}-{end}',
  'model.hint.detailReasoning': 'Detail and reasoning',
  'model.hint.daily': 'Daily work',
  'model.hint.fastClear': 'Fast and clear',
  'model.hint.previousFamily': 'Previous family',
  'model.hint.untilAug31': 'Until Aug 31',
  'model.hint.reasoning': 'Reasoning',
  'model.hint.fastReasoning': 'Fast reasoning',
  'model.hint.noVariants': 'No variants',
  'model.hint.current': 'Current',
  'model.hint.previous': 'Previous',
  'model.hint.speed': 'Speed',
  'model.hint.stable': 'Stable',
  'model.hint.light': 'Light',
  'model.hint.fast': 'Fast',
  'model.hint.classic': 'Classic',
  'model.hint.maxCapacity': 'Maximum capacity',
  'model.hint.newBalance': 'New balance',
  'model.hint.previousOpus': 'Previous Opus',
  'model.hint.classicThinking': 'Classic thinking',
  'model.hint.currentFast': 'Current fast',
  'model.hint.previousPro': 'Previous Pro',
  'model.hint.previousFlash': 'Previous Flash',
  'model.hint.minimum': 'Minimum',
  'model.hint.legacy': 'Legacy',
  'model.hint.general': 'General',
  'model.hint.internalReasoning': 'Internal reasoning',
  'model.hint.longContext': 'Long context',
  'model.hint.standard': 'Standard',
  'model.hint.balance': 'Balance',
  'model.hint.code': 'Code',
  'model.hint.pickProvider': 'Pick provider',`;

const esInsert = `  'menu.githubPublic': 'PÚBLICO',
  'menu.githubPressRefresh': 'Pulsa actualizar para cargar los repositorios de esta cuenta.',
  'menu.githubUserFallback': 'usuario',
  'composer.manageAccounts': 'Administrar cuentas',
  'composer.manageAccountsHint': 'Conectar o desconectar proveedores',
  'composer.connectModel': 'Conecta una cuenta para elegir modelo',
  'chrome.filterSessionsLive': 'Filtros: solo sesiones activas',
  'chrome.sortByName': 'Ordenar por nombre',
  'chrome.sortByType': 'Ordenar por tipo',
  'chrome.emptyFolder': 'Carpeta vacía.',
  'chrome.closeFile': 'Cerrar archivo',
  'chrome.openExternal': 'Abrir externo',
  'chrome.gitInstallDiff': 'Instala Git para ver diffs reales.',
  'chrome.gitDiffFail': 'No se pudo leer el diff real: {error}',
  'chrome.noDiffFile': 'No hay diff para este archivo.',
  'usage.resetNow': 'ya disponible',
  'usage.resetInSec': 'en {seconds} s',
  'usage.resetInMin': 'en {minutes} min',
  'usage.resetInHours': 'en {hours} h',
  'usage.resetInHoursMin': 'en {hours} h {minutes} min',
  'usage.resetInDays': 'en {days} d',
  'session.unavailable': 'No disponible',
  'session.unavailableError': 'No disponible: {error}',
  'session.workingDir': 'Directorio de trabajo actual',
  'session.mainRepo': 'Repositorio principal',
  'session.processLog': 'Registro del proceso',
  'session.gitReal': 'Calculado con Git real',
  'session.labelAgent': 'AGENTE / SHELL',
  'session.labelStatus': 'ESTADO / PID',
  'session.labelDirectory': 'DIRECTORIO',
  'session.labelWorktree': 'WORKTREE / RAMA',
  'session.labelStarted': 'INICIO',
  'session.labelFiles': 'ARCHIVOS CAMBIADOS',
  'window.controls': 'Controles de ventana',
  'window.close': 'Cerrar ComesADE',
  'window.minimize': 'Minimizar',
  'window.maximize': 'Maximizar o restaurar',
  'toast.windowMinimizeFail': 'No se pudo minimizar',
  'toast.windowMaximizeFail': 'No se pudo maximizar',
  'toast.windowCloseFail': 'No se pudo cerrar',
  'toast.windowMoveFail': 'No se pudo mover la ventana',
  'toast.sttFail': 'No se pudo transcribir el audio en ComesADE.',
  'toast.sttTimeout': 'La transcripción en ComesADE tardó demasiado.',
  'search.title': 'Buscar archivos',
  'search.copy': 'Busca en los archivos reales del workspace. Se excluyen .git, node_modules, target y dist.',
  'search.placeholder': 'texto a buscar',
  'search.empty': 'Escribe una consulta.',
  'search.searching': 'Buscando en el filesystem…',
  'search.noMatches': 'No se encontraron coincidencias reales.',
  'search.close': 'Cerrar búsqueda',
  'search.options': 'Opciones de búsqueda',
  'search.content': 'Buscar contenido',
  'search.files': 'Archivos',
  'search.regex': 'Regex',
  'search.case': 'Mayúsculas/minúsculas',
  'search.whole': 'Palabra completa',
  'search.submit': 'Buscar',
  'search.eyebrow': 'PROYECTO / BÚSQUEDA',
  'design.capture': 'Captura',
  'design.captureN': 'Captura {n}',
  'design.remove': 'Quitar',
  'design.removeCapture': 'Quitar captura',
  'design.dragHint': 'Arrastra una zona del preview para capturarla',
  'prompt.designCapture': 'Cambia el UI de esta captura en el código real del workspace.',
  'prompt.editSelection': 'Edita {file}{range}. Conserva el resto del archivo y aplica solo este cambio.\\n\\nSelección:\\n\`\`\`\\n{selection}\\n\`\`\`\\n\\nInstrucción: ',
  'prompt.editFile': 'Edita {file}. Aplica el cambio con write_file.\\n\\nInstrucción: ',
  'prompt.workspaceFallback': 'el workspace',
  'prompt.linesRange': ' líneas {start}-{end}',
  'model.hint.detailReasoning': 'Detalle y razonamiento',
  'model.hint.daily': 'Trabajo diario',
  'model.hint.fastClear': 'Rápido y claro',
  'model.hint.previousFamily': 'Familia anterior',
  'model.hint.untilAug31': 'Hasta el 31 ago',
  'model.hint.reasoning': 'Razonamiento',
  'model.hint.fastReasoning': 'Razonamiento rápido',
  'model.hint.noVariants': 'Sin variantes',
  'model.hint.current': 'Actual',
  'model.hint.previous': 'Anterior',
  'model.hint.speed': 'Velocidad',
  'model.hint.stable': 'Estable',
  'model.hint.light': 'Ligero',
  'model.hint.fast': 'Rápido',
  'model.hint.classic': 'Clásico',
  'model.hint.maxCapacity': 'Máxima capacidad',
  'model.hint.newBalance': 'Equilibrio nuevo',
  'model.hint.previousOpus': 'Opus anterior',
  'model.hint.classicThinking': 'Thinking clásico',
  'model.hint.currentFast': 'Actual rápido',
  'model.hint.previousPro': 'Pro anterior',
  'model.hint.previousFlash': 'Flash anterior',
  'model.hint.minimum': 'Mínimo',
  'model.hint.legacy': 'Legacy',
  'model.hint.general': 'General',
  'model.hint.internalReasoning': 'Razonamiento interno',
  'model.hint.longContext': 'Contexto largo',
  'model.hint.standard': 'Estándar',
  'model.hint.balance': 'Equilibrio',
  'model.hint.code': 'Código',
  'model.hint.pickProvider': 'Elige proveedor',`;

const ptInsert = esInsert
  .replace('Pulsa actualizar para cargar los repositorios de esta cuenta.', 'Carrega atualizar para listar os repositórios desta conta.')
  .replace("'usuario'", "'utilizador'")
  .replace('Administrar cuentas', 'Gerir contas')
  .replace('Conectar o desconectar proveedores', 'Ligar ou desligar fornecedores')
  .replace('Conecta una cuenta para elegir modelo', 'Liga uma conta para escolher o modelo')
  .replace('Filtros: solo sesiones activas', 'Filtros: só sessões ativas')
  .replace('Ordenar por nombre', 'Ordenar por nome')
  .replace('Ordenar por tipo', 'Ordenar por tipo')
  .replace('Carpeta vacía.', 'Pasta vazia.')
  .replace('Cerrar archivo', 'Fechar ficheiro')
  .replace('Instala Git para ver diffs reales.', 'Instala o Git para ver diffs reais.')
  .replace('No se pudo leer el diff real: {error}', 'Não foi possível ler o diff real: {error}')
  .replace('No hay diff para este archivo.', 'Não há diff para este ficheiro.')
  .replace('ya disponible', 'já disponível')
  .replaceAll('No disponible', 'Indisponível')
  .replace('Directorio de trabajo actual', 'Diretório de trabalho atual')
  .replace('Repositorio principal', 'Repositório principal')
  .replace('Registro del proceso', 'Registo do processo')
  .replace('Calculado con Git real', 'Calculado com Git real')
  .replace('Controles de ventana', 'Controlos da janela')
  .replace('Cerrar ComesADE', 'Fechar ComesADE')
  .replace('Maximizar o restaurar', 'Maximizar ou restaurar')
  .replace('No se pudo minimizar', 'Não foi possível minimizar')
  .replace('No se pudo maximizar', 'Não foi possível maximizar')
  .replace('No se pudo cerrar', 'Não foi possível fechar')
  .replace('No se pudo mover la ventana', 'Não foi possível mover a janela')
  .replace('No se pudo transcribir el audio en ComesADE.', 'Não foi possível transcrever o áudio no ComesADE.')
  .replace('La transcripción en ComesADE tardó demasiado.', 'A transcrição no ComesADE demorou demasiado.')
  .replace('Buscar archivos', 'Pesquisar ficheiros')
  .replace('Busca en los archivos reales del workspace. Se excluyen .git, node_modules, target y dist.', 'Pesquisa nos ficheiros reais do workspace. Exclui .git, node_modules, target e dist.')
  .replace('texto a buscar', 'texto a pesquisar')
  .replace('Escribe una consulta.', 'Escreve uma consulta.')
  .replace('Buscando en el filesystem…', 'A pesquisar no filesystem…')
  .replace('No se encontraron coincidencias reales.', 'Não foram encontradas coincidências reais.')
  .replace('Cerrar búsqueda', 'Fechar pesquisa')
  .replace('Opciones de búsqueda', 'Opções de pesquisa')
  .replace('Buscar contenido', 'Pesquisar conteúdo')
  .replace("'search.files': 'Archivos'", "'search.files': 'Ficheiros'")
  .replace('Mayúsculas/minúsculas', 'Maiúsculas/minúsculas')
  .replace('Palabra completa', 'Palavra completa')
  .replace("'search.submit': 'Buscar'", "'search.submit': 'Pesquisar'")
  .replace('PROYECTO / BÚSQUEDA', 'PROJETO / PESQUISA')
  .replace('Quitar captura', 'Remover captura')
  .replace("'design.remove': 'Quitar'", "'design.remove': 'Remover'")
  .replace('Arrastra una zona del preview para capturarla', 'Arrasta uma zona do preview para a capturar');

const frInsert = enInsert
  .replace('Manage accounts', 'Gérer les comptes')
  .replace('Connect or disconnect providers', 'Connecter ou déconnecter des fournisseurs')
  .replace('Connect an account to choose a model', 'Connectez un compte pour choisir un modèle')
  .replace('Filters: live sessions only', 'Filtres : sessions actives uniquement')
  .replace('Sort by name', 'Trier par nom')
  .replace('Sort by type', 'Trier par type')
  .replace('Empty folder.', 'Dossier vide.')
  .replace('Close file', 'Fermer le fichier')
  .replace('Open externally', 'Ouvrir à l’extérieur')
  .replace('Install Git to see real diffs.', 'Installez Git pour voir les vrais diffs.')
  .replace('Could not read the real diff: {error}', 'Impossible de lire le vrai diff : {error}')
  .replace('No diff for this file.', 'Aucun diff pour ce fichier.')
  .replace('available now', 'déjà disponible')
  .replaceAll('Unavailable', 'Indisponible')
  .replace('Current working directory', 'Répertoire de travail actuel')
  .replace('Main repository', 'Dépôt principal')
  .replace('Process record', 'Journal du processus')
  .replace('Calculated from real Git', 'Calculé avec Git réel')
  .replace('Window controls', 'Contrôles de fenêtre')
  .replace('Close ComesADE', 'Fermer ComesADE')
  .replace("'window.minimize': 'Minimize'", "'window.minimize': 'Réduire'")
  .replace('Maximize or restore', 'Agrandir ou restaurer')
  .replace('Could not minimize', 'Impossible de réduire')
  .replace('Could not maximize', 'Impossible d’agrandir')
  .replace('Could not close', 'Impossible de fermer')
  .replace('Could not move the window', 'Impossible de déplacer la fenêtre')
  .replace('Could not transcribe audio in ComesADE.', 'Impossible de transcrire l’audio dans ComesADE.')
  .replace('Speech transcription in ComesADE timed out.', 'La transcription dans ComesADE a expiré.')
  .replace("'search.title': 'Search files'", "'search.title': 'Rechercher des fichiers'")
  .replace('Search real workspace files. Excludes .git, node_modules, target and dist.', 'Recherche dans les fichiers réels du workspace. Exclut .git, node_modules, target et dist.')
  .replace('text to find', 'texte à trouver')
  .replace('Type a query.', 'Saisissez une requête.')
  .replace('Searching the filesystem…', 'Recherche dans le filesystem…')
  .replace('No real matches found.', 'Aucune concordance réelle trouvée.')
  .replace('Close search', 'Fermer la recherche')
  .replace('Search options', 'Options de recherche')
  .replace('Search content', 'Rechercher dans le contenu')
  .replace('Case sensitive', 'Sensible à la casse')
  .replace('Whole word', 'Mot entier')
  .replace("'search.submit': 'Search'", "'search.submit': 'Rechercher'")
  .replace('PROJECT / SEARCH', 'PROJET / RECHERCHE')
  .replace('Remove capture', 'Retirer la capture')
  .replace("'design.remove': 'Remove'", "'design.remove': 'Retirer'")
  .replace('Drag a region of the preview to capture it', 'Faites glisser une zone de l’aperçu pour la capturer')
  .replace('Press refresh to load repositories for this account.', 'Appuyez sur actualiser pour charger les dépôts de ce compte.')
  .replace("'menu.githubUserFallback': 'user'", "'menu.githubUserFallback': 'utilisateur'");

const deInsert = enInsert
  .replace('Manage accounts', 'Konten verwalten')
  .replace('Connect or disconnect providers', 'Anbieter verbinden oder trennen')
  .replace('Connect an account to choose a model', 'Konto verbinden, um ein Modell zu wählen')
  .replace('Filters: live sessions only', 'Filter: nur aktive Sitzungen')
  .replace('Sort by name', 'Nach Name sortieren')
  .replace('Sort by type', 'Nach Typ sortieren')
  .replace('Empty folder.', 'Leerer Ordner.')
  .replace('Close file', 'Datei schließen')
  .replace('Open externally', 'Extern öffnen')
  .replace('Install Git to see real diffs.', 'Git installieren, um echte Diffs zu sehen.')
  .replace('Could not read the real diff: {error}', 'Echter Diff konnte nicht gelesen werden: {error}')
  .replace('No diff for this file.', 'Kein Diff für diese Datei.')
  .replace('available now', 'jetzt verfügbar')
  .replaceAll('Unavailable', 'Nicht verfügbar')
  .replace('Current working directory', 'Aktuelles Arbeitsverzeichnis')
  .replace('Main repository', 'Haupt-Repository')
  .replace('Process record', 'Prozessprotokoll')
  .replace('Calculated from real Git', 'Mit echtem Git berechnet')
  .replace('Window controls', 'Fenstersteuerung')
  .replace('Close ComesADE', 'ComesADE schließen')
  .replace("'window.minimize': 'Minimize'", "'window.minimize': 'Minimieren'")
  .replace('Maximize or restore', 'Maximieren oder wiederherstellen')
  .replace('Could not minimize', 'Minimieren fehlgeschlagen')
  .replace('Could not maximize', 'Maximieren fehlgeschlagen')
  .replace('Could not close', 'Schließen fehlgeschlagen')
  .replace('Could not move the window', 'Fenster konnte nicht verschoben werden')
  .replace('Could not transcribe audio in ComesADE.', 'Audio konnte in ComesADE nicht transkribiert werden.')
  .replace('Speech transcription in ComesADE timed out.', 'Transkription in ComesADE ist abgelaufen.')
  .replace("'search.title': 'Search files'", "'search.title': 'Dateien suchen'")
  .replace('Search real workspace files. Excludes .git, node_modules, target and dist.', 'Durchsucht echte Workspace-Dateien. Schließt .git, node_modules, target und dist aus.')
  .replace('text to find', 'Suchtext')
  .replace('Type a query.', 'Suchbegriff eingeben.')
  .replace('Searching the filesystem…', 'Dateisystem wird durchsucht…')
  .replace('No real matches found.', 'Keine echten Treffer gefunden.')
  .replace('Close search', 'Suche schließen')
  .replace('Search options', 'Suchoptionen')
  .replace('Search content', 'Inhalt suchen')
  .replace('Case sensitive', 'Groß-/Kleinschreibung')
  .replace('Whole word', 'Ganzes Wort')
  .replace("'search.submit': 'Search'", "'search.submit': 'Suchen'")
  .replace('PROJECT / SEARCH', 'PROJEKT / SUCHE')
  .replace('Remove capture', 'Aufnahme entfernen')
  .replace("'design.remove': 'Remove'", "'design.remove': 'Entfernen'")
  .replace('Drag a region of the preview to capture it', 'Ziehen Sie einen Bereich der Vorschau zum Aufnehmen')
  .replace('Press refresh to load repositories for this account.', 'Aktualisieren tippen, um Repositories dieses Kontos zu laden.')
  .replace("'menu.githubUserFallback': 'user'", "'menu.githubUserFallback': 'Benutzer'");

const replacements = [
  [
    withNl(`  'menu.githubPublic': 'PUBLIC',\n\n  'settings.eyebrow': 'This PC',\n  'settings.title': 'Settings',`),
    withNl(`${enInsert}\n\n  'settings.eyebrow': 'This PC',\n  'settings.title': 'Settings',`),
  ],
  [
    withNl(`  'menu.githubPublic': 'PÚBLICO',\n  'menu.createGithubCopy':`),
    withNl(`${esInsert}\n  'menu.createGithubCopy':`),
  ],
  [
    withNl(`  'menu.githubPublic': 'PÚBLICO',\n  'menu.createGithubCopy': 'Crea un repositóriou`),
    withNl(`${ptInsert}\n  'menu.createGithubCopy': 'Crea un repositóriou`),
  ],
  [
    withNl(`  'menu.githubPublic': 'PUBLIC',\n  'menu.createGithubCopy': 'Créers un private`),
    withNl(`${frInsert}\n  'menu.createGithubCopy': 'Créers un private`),
  ],
  [
    withNl(`  'menu.githubPublic': 'PUBLIC',\n  'menu.createGithubCopy': 'Erstellens ein private`),
    withNl(`${deInsert}\n  'menu.createGithubCopy': 'Erstellens ein private`),
  ],
];

for (const [find, replace] of replacements) {
  if (!src.includes(find)) throw new Error(`find failed: ${find.slice(0, 90)}`);
  src = src.replace(find, replace);
  console.log('ok');
}

fs.writeFileSync(path, src);
console.log('written', src.length);
