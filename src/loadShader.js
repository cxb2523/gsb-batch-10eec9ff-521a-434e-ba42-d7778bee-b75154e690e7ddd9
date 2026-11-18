import { dirname, resolve, extname, posix, sep } from 'path';
import { emitWarning, cwd } from 'process';
import { readFileSync } from 'fs';
import { platform } from 'os';

const IS_WIN32 = platform() === 'win32';

/**
 * @function
 * @name normalizePath
 * @description Normalizes a shader path into a single canonical key
 * used by every internal Set and dependency graph Map, so that the
 * same chunk written with different separators, "." / ".." segments
 * or (on win32) a different letter case is recognized as one file:
 *
 *  - separators are converted to posix ones
 *  - "." and ".." segments are folded by `posix.normalize`
 *  - on win32 the result is lowercased, as the file system is case-insensitive
 *
 * Display paths (warnings, recursion errors, `addWatchFile`) keep the
 * original, real file paths and are never derived from this key.
 *
 * @param {string} path Shader's absolute path
 *
 * @returns {string} Normalized, posix shader path
 */
function normalizePath (path) {
  const normalized = posix.normalize(path.split(sep).join(posix.sep));
  return IS_WIN32 && normalized.toLowerCase() || normalized;
}

/**
 * @name recursiveChunk
 * @type {string}
 * 
 * @description Shader chunk path
 * that caused a recursion error
 */
let recursiveChunk = '';

/**
 * @const
 * @name allChunks
 * @type {readonly Set<string>}
 *
 * @description List of all normalized shader chunk keys,
 * it's used to track included files
 */
const allChunks = new Set();

/**
 * @const
 * @name chunkPaths
 * @type {readonly Map<string, string>}
 *
 * @description Maps each normalized chunk key to the real file path
 * (posix separators, original letter case) with which the chunk was
 * first encountered. It keeps user-facing messages and watch files
 * independent from the internal, lowercased/folded normalization.
 */
const chunkPaths = new Map();

/**
 * @const
 * @name dependentChunks
 * @type {readonly Map<string, string[]>}
 * 
 * @description Map of shaders that import other chunks, it's
 * used to track included files in order to avoid recursion.
 * Keys and values are normalized chunk keys; the same keys in
 * "chunkPaths" hold the real paths for external display.
 * - Key: normalized shader path that uses other chunks as dependencies
 * - Value: normalized paths of chunks included within the shader
 */
const dependentChunks = new Map();

/**
 * @const
 * @name duplicatedChunks
 * @type {readonly Map<string, string[]>}
 * 
 * @description Map of duplicated shader imports, keyed by the
 * importing shader's normalized chunk key and holding the normalized
 * keys of chunks already warned about for that caller, so each
 * (caller, chunk) pair warns at most once
 */
const duplicatedChunks = new Map();

/**
 * @function
 * @name resetSavedChunks
 * @description Clears all lists of saved chunks
 * and resets "recursiveChunk" path to empty
 * 
 * @returns {string} Copy of "recursiveChunk" path
 */
function resetSavedChunks () {
  const chunk = recursiveChunk;
  duplicatedChunks.clear();
  dependentChunks.clear();

  recursiveChunk = '';
  chunkPaths.clear();
  allChunks.clear();
  return chunk;
}

/**
 * @function
 * @name getRecursionCaller
 * @description Gets last chunk that caused a
 * recursion error from the "dependentChunks" list
 *
 * @param {boolean} real Resolve the normalized key to its real file path
 *
 * @returns {string} Normalized key (or real path) of the chunk
 * that started a recursion
 */
function getRecursionCaller (real = true) {
  const dependencies = [...dependentChunks.keys()];
  const caller = dependencies[dependencies.length - 1];
  return real && chunkPaths.get(caller) || caller;
}

/**
 * @function
 * @name checkDuplicatedImports
 * @description Checks if shader chunk was already included
 * and adds it to the "duplicatedChunks" list if yes.
 * Both the caller and the chunk are identified by their
 * normalized keys, but the warning keeps their real paths.
 *
 * @param {string} path Shader's absolute, normalized chunk path
 * @param {string} caller Normalized path of the importing shader
 * @param {string} callerPath Real path of the importing shader
 *
 * @throws {Warning} If shader chunk was already included
 */
function checkDuplicatedImports (path, caller, callerPath) {
  const realPath = chunkPaths.get(path) ?? path;
  const chunks = duplicatedChunks.get(caller) ?? [];
  if (chunks.includes(path)) return;

  chunks.push(path);
  duplicatedChunks.set(caller, chunks);

  emitWarning(`'${realPath}' was included multiple times.`, {
    code: 'vite-plugin-glsl',
    detail: 'Please avoid multiple imports of the same chunk in order to avoid' +
    ` recursions and optimize your shader length.\nDuplicated import found in file '${callerPath}'.`
  });
}

/**
 * @function
 * @name removeSourceComments
 * @description Removes comments from shader source
 * code in order to avoid including commented chunks
 * Triple-slash comments are meant to be preserved,
 * but to avoid errors, they will be removed anyway
 * when containing import keywords or block comments
 * 
 * @param {string}  source  Shader's source code
 * @param {RegExp}  pattern RegExp to import chunks
 * @param {boolean} triple  Remove triple slash comments
 * 
 * @returns {string} Shader's source code without comments
 */
function removeSourceComments (source, pattern, triple = false) {
  const lines = source.split('\n');
  const comments = /\/\*|\*\//;

  for (let l = lines.length; l--; ) {
    const index = lines[l].indexOf('//');

    if (index > -1) {
      if (
        lines[l][index + 2] === '/' &&
        !comments.test(lines[l]) &&
        !pattern.test(lines[l]) &&
        !triple
      )
        continue;

      lines[l] = lines[l].slice(0, index);
    }
  }

  source = lines.join('\n');

  while (true) {
    const startBlock = source.indexOf('/*');
    const endBlock = source.indexOf('*/', startBlock);

    if (startBlock < 0 && endBlock < 0) break;

    else if (startBlock > -1 && endBlock > -1)
      source = source.slice(0, startBlock) +
        source.slice(endBlock + 2);

    else {
      const chunk = source.slice(
        startBlock * +(endBlock === -1),
        (startBlock === -1 && endBlock + 2) || void 0
      );

      const comment = startBlock === -1 && '/*' || '*/';
      const missing = startBlock === -1 && 'open' || 'clos';

      emitWarning(`Block comment was not ${missing}ed.`, {
        code: 'vite-plugin-glsl',
        detail: `Cannot find the corresponding ${missing}ing comment (${comment}) to the one in the` +
        ` chunk below.\nMake sure it's present and not commented out by a line comment:\n\n${chunk}`
      });

      break;
    }
  }

  return source;
}

/**
 * @function
 * @name checkRecursiveImports
 * @description Checks if shader dependencies
 * have caused a recursion error or warning
 * ignoring duplicate chunks if required
 *
 * @param {string}  path Shader's normalized, absolute chunk path
 * @param {string}  real Shader's real file path
 * @param {boolean} warn Check already included chunks
 * @param {boolean} ignore  Ignore already included chunks
 *
 * @returns {boolean | null} Import recursion has occurred
 * or chunk was ignored because of `ignore` argument
 */
function checkRecursiveImports (path, real, warn, ignore) {
  // The recursion check has to run before the already-included
  // chunk is ignored or turned into a duplicate warning, otherwise
  // a cycle whose edges only differ by case or "." / ".." spelling
  // would be skipped silently in the "removeDuplicatedImports" mode.
  const recursion = checkIncludedDependencies(path, path);
  if (recursion) return true;

  if (allChunks.has(path)) {
    if (ignore) return null;

    if (warn) {
      const callerKey = getRecursionCaller(false);
      const callerPath = chunkPaths.get(callerKey) ?? real;
      checkDuplicatedImports(path, callerKey, callerPath);
    }
  }

  return false;
}

/**
 * @function
 * @name checkIncludedDependencies
 * @description Checks if included
 * chunks caused a recursion error.
 * The whole dependency graph uses normalized chunk keys,
 * so cycles written with "./" / ".." variants or different
 * letter cases are detected exactly like identical strings.
 *
 * @param {string} path Current chunk's normalized path
 * @param {string} root Main shader's normalized path that imports chunks
 *
 * @returns {boolean} Included chunk started a recursion
 */
function checkIncludedDependencies (path, root) {
  const dependencies = dependentChunks.get(path);
  let recursiveDependency = false;

  if (dependencies?.includes(root)) {
    recursiveChunk = chunkPaths.get(root) ?? root;
    return true;
  }

  dependencies?.forEach(dependency => recursiveDependency ||=
    checkIncludedDependencies(dependency, root)
  );

  return recursiveDependency;
}

/**
 * @function
 * @name minifyShader
 * @description Minifies shader source code by
 * removing unnecessary whitespace and empty lines
 * 
 * @param {string}  shader  Shader code with included chunks
 * @param {boolean} newLine Flag to require a new line for the code
 * 
 * @returns {string} Minified shader's source code
 */
export function minifyShader (shader, newLine = false) {
  return shader.replace(/\\(?:\r\n|\n\r|\n|\r)|\/\*.*?\*\/|\/\/(?:\\(?:\r\n|\n\r|\n|\r)|[^\n\r])*/g, '')
    .split(/\n+/).reduce((result, line) => {
      line = line.trim().replace(/\s{2,}|\t/g, ' ');

      if (/@(vertex|fragment|compute)/.test(line) || line.endsWith('return')) line += ' ';

      if (line[0] === '#') {
        newLine && result.push('\n');
        result.push(line, '\n');
        newLine = false;
      }

      else {
        const prev = result.at(-1) ?? '';
        !line.startsWith('{') && prev.endsWith('else') && result.push(' ');
        /\w$/.test(prev) && /^\w/.test(line) && !prev.endsWith('else') && result.push(' ');

        line = line.replace(/([+-])\s+(?=\1)/g, '$1\0')
          .replace(/\s*({|}|=|,|\+|\-|\*|\/|<|>|&|\||\[|\]|\(|\)|!|;)\s*/g, '$1')
          .replace(/\0/g, ' ');

        result.push(line);
        newLine = true;
      }

      return result;
    }, []).join('').replace(/\n+/g, '\n');
}

/**
 * @function
 * @name loadChunks
 * @description Includes shader's dependencies
 * and removes comments from the source code
 * 
 * @param {string}  source  Shader's source code
 * @param {string}  path    Shader's absolute path
 * @param {RegExp}  pattern RegExp to import chunks
 * @param {Options} options Shader loading config object
 * 
 * @throws {Error} If shader chunks started a recursion loop
 * 
 * @returns {string} Shader's source code without external chunks
 */
function loadChunks (source, path, pattern, options) {
  const unixPath = path.split(sep).join(posix.sep);
  const chunkPath = normalizePath(path);

  const recursion = checkRecursiveImports(
    chunkPath, unixPath,
    options.warnDuplicatedImports,
    options.removeDuplicatedImports
  );

  if (recursion) return recursiveChunk;
  else if (recursion === null) return '';

  source = removeSourceComments(source, pattern);
  let directory = dirname(unixPath);
  allChunks.add(chunkPath);
  chunkPaths.get(chunkPath) ?? chunkPaths.set(chunkPath, unixPath);

  if (pattern.test(source)) {
    dependentChunks.set(chunkPath, []);
    const currentDirectory = directory;
    const ext = options.defaultExtension;

    source = source.replace(pattern, (_, ...[, importPath]) => {
      importPath = importPath.trim().replace(/^(?:"|')?|(?:"|')?;?$/gi, '');

      if (!importPath.indexOf('/')) {
        const base = cwd().split(sep).join(posix.sep);
        importPath = base + options.root + importPath;
      }

      const directoryIndex = importPath.lastIndexOf('/');
      directory = currentDirectory;

      if (directoryIndex !== -1) {
        directory = resolve(directory, importPath.slice(0, directoryIndex + 1));
        importPath = importPath.slice(directoryIndex + 1, importPath.length);
      }

      let shader = resolve(directory, importPath);
      if (!extname(shader)) shader = `${shader}.${ext}`;

      const shaderPath = shader.split(sep).join(posix.sep);
      const shaderKey = normalizePath(shader);

      chunkPaths.get(shaderKey) ?? chunkPaths.set(shaderKey, shaderPath);
      dependentChunks.get(chunkPath)?.push(shaderKey);

      return loadChunks(
        readFileSync(shader, 'utf8'),
        shader, pattern, options
      );
    });
  }

  if (recursiveChunk) {
    const caller = getRecursionCaller();
    const recursiveChunk = resetSavedChunks();

    throw new Error(
      `Recursion detected when importing "${recursiveChunk}" in "${caller}".`
    );
  }

  return source.trim().replace(/(\r\n|\r|\n){3,}/g, '$1\n');
}

/**
 * @function
 * @name getWatchFiles
 * @description Flattens the normalized dependency graph into a
 * deduplicated list of real chunk paths, so `addWatchFile` receives
 * every dependency exactly once even when it was imported through
 * different spellings ("./"/".." segments or letter case variants).
 *
 * @returns {string[]} Unique, real (posix) shader dependency paths
 */
export function getWatchFiles () {
  const keys = new Set([...dependentChunks.values()].flat());
  return [...keys].map(key => chunkPaths.get(key) ?? key);
}

/**
 * @function
 * @name loadShader
 * @description Iterates through all external chunks, includes them
 * into the shader's source code and optionally minifies the output
 * 
 * @typedef {import('./types').LoadingOptions} Options
 * @typedef {import('./types').LoadingOutput} Output
 * 
 * @param {string}  source  Shader's source code
 * @param {string}  shader  Shader's absolute path
 * @param {Options} options Configuration object to define:
 * 
 *  - Shader suffix to use when no extension is specified
 *  - Warn if the same chunk was imported multiple times
 *  - Automatically remove an already imported chunk
 *  - Optional function to call with output shader
 *  - Keywords used to import shader chunks
 *  - Directory for root imports
 *  - Minify output shader code
 * 
 * @returns {Promise<Output>} Loaded, parsed (and minified)
 * shader output and Map of shaders that import other chunks
 */
export default async function (source, shader, options) {
  const pattern = new RegExp(String.raw`(${
    options.importKeywords.join('|')
  })(\s+([^\s<>]+));?`, 'gi');

  resetSavedChunks();

  let outputShader = loadChunks(source, shader, pattern, options);

  options.minify && (outputShader = minifyShader(
    removeSourceComments(outputShader, pattern, true))
  );

  outputShader = await options.onComplete?.(outputShader, shader) ?? outputShader;

  return { dependentChunks, outputShader };
}
