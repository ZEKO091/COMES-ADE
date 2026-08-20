import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      throw new Error(`Argumento inesperado: ${value}`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Falta el valor de --${key}.`);
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = options[key];
  if (!value) throw new Error(`Falta --${key}.`);
  return value;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function detectCandidate(signaturePath, bundlePath) {
  const filename = basename(bundlePath);
  const context = `${signaturePath} ${filename}`.toLowerCase();

  if (filename.endsWith('.exe') || filename.endsWith('.msi')) {
    const installer = filename.endsWith('.msi') ? 'msi' : 'nsis';
    return {
      platform: 'windows-x86_64',
      installer,
      priority: installer === 'nsis' ? 20 : 10,
    };
  }

  if (!filename.endsWith('.app.tar.gz')) return null;
  const architecture = context.includes('aarch64') || context.includes('arm64')
    ? 'aarch64'
    : context.includes('x86_64') || context.includes('x64')
      ? 'x86_64'
      : context.includes('universal')
        ? 'universal'
        : null;
  if (!architecture) return null;
  return {
    platform: `darwin-${architecture}`,
    installer: 'app',
    priority: 10,
  };
}

function releaseUrl(repository, tag, filename) {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo || repository.split('/').length !== 2) {
    throw new Error(`Repositorio invalido: ${repository}. Usa owner/repo.`);
  }
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
}

const options = parseArguments(process.argv.slice(2));
const inputDirectory = resolve(required(options, 'input'));
const outputPath = resolve(required(options, 'output'));
const repository = required(options, 'repository');
const tag = required(options, 'tag');
if (!statSync(inputDirectory, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`No existe el directorio de artefactos: ${inputDirectory}`);
}

const version = tag.replace(/^v/, '');
const candidates = [];
for (const signaturePath of walk(inputDirectory).filter((path) => path.endsWith('.sig'))) {
  const bundlePath = signaturePath.slice(0, -'.sig'.length);
  if (!statSync(bundlePath, { throwIfNoEntry: false })?.isFile()) continue;
  const detected = detectCandidate(signaturePath, bundlePath);
  if (!detected) continue;
  candidates.push({
    ...detected,
    signature: readFileSync(signaturePath, 'utf8').trim(),
    filename: basename(bundlePath),
  });
}

if (candidates.length === 0) {
  throw new Error('No se encontraron paquetes de updater con firma .sig.');
}

const filenames = new Map();
for (const candidate of candidates) {
  const previousPlatform = filenames.get(candidate.filename);
  if (previousPlatform && previousPlatform !== candidate.platform) {
    throw new Error(`El asset ${candidate.filename} se repite para ${previousPlatform} y ${candidate.platform}. Renombra los bundles antes de publicarlos.`);
  }
  filenames.set(candidate.filename, candidate.platform);
}

const platforms = {};
for (const candidate of candidates) {
  const entry = {
    signature: candidate.signature,
    url: releaseUrl(repository, tag, candidate.filename),
  };
  const primary = platforms[candidate.platform];
  if (!primary || candidate.priority > primary.priority) {
    platforms[candidate.platform] = { ...entry, priority: candidate.priority };
  }
  platforms[`${candidate.platform}-${candidate.installer}`] = entry;
}

for (const value of Object.values(platforms)) delete value.priority;
const manifest = {
  version,
  notes: `Actualizacion ComesADE ${version}`,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(
    Object.entries(platforms).sort(([left], [right]) => left.localeCompare(right)),
  ),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Manifest updater generado: ${outputPath}`);
console.log(`Plataformas: ${Object.keys(manifest.platforms).join(', ')}`);
