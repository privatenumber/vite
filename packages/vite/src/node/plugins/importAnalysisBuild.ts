import path from 'node:path'
import MagicString from 'magic-string'
import type {
  ParseError as EsModuleLexerParseError,
  ImportSpecifier,
} from 'es-module-lexer'
import { init, parse as parseImports } from 'es-module-lexer'
import type { OutputChunk, SourceMap } from 'rollup'
import type { RawSourceMap } from '@ampproject/remapping'
import convertSourceMap from 'convert-source-map'
import {
  combineSourcemaps,
  generateCodeFrame,
  isInNodeModules,
  numberToPos,
} from '../utils'
import type { Plugin } from '../plugin'
import type { ResolvedConfig } from '../config'
import { toOutputFilePathInJS } from '../build'
import { genSourceMapUrl } from '../server/sourcemap'
import type { Environment } from '../environment'
import { removedPureCssFilesCache } from './css'
import { createParseErrorInfo } from './importAnalysis'

const symbolString = (name: string) =>
  `__viteSymbol_${name}_${Math.random().toString(36).slice(2)}__`

type VitePreloadErrorEvent = Event & { payload: Error }

// Placeholder symbols for injecting helpers
export const isEsmFlag = `__VITE_IS_MODERN__` // TODO: consider moving this to the other plugin
const isEsmFlagPattern = new RegExp('\\b' + isEsmFlag + '\\b', 'g')

export const preloadMethod = `__vitePreload`
const preloadSaver = symbolString(`__vitePreloadSaver`)
const preloadSaverCallPattern = new RegExp(
  `${preloadSaver}\\(([^\\)]+)\\)`,
  'g',
)
export const preloadHelperId = '\0vite/preload-helper.js'
const chunkRegistryPlaceholder = symbolString('chunkRegistryPlaceholder')

const dynamicImportPrefixRE = /import\s*\(/

function toRelativePath(filename: string, importer: string) {
  const relPath = path.posix.relative(path.posix.dirname(importer), filename)
  return relPath[0] === '.' ? relPath : `./${relPath}`
}

/**
 * Helper for preloading CSS and direct imports of async chunks in parallel to
 * the async chunk itself.
 */

function detectScriptRel() {
  const relList =
    typeof document !== 'undefined' && document.createElement('link').relList
  return relList && relList.supports && relList.supports('modulepreload')
    ? 'modulepreload'
    : 'preload'
}

declare const scriptRel: string
declare const seen: Record<string, boolean>
function preload(
  baseModule: () => Promise<unknown>,
  deps?: string[],
  importerUrl?: string,
) {
  let promise: Promise<PromiseSettledResult<unknown>[] | void> =
    Promise.resolve()
  if (
    // @ts-expect-error __VITE_IS_MODERN__ will be replaced with boolean later
    __VITE_IS_MODERN__ &&
    deps &&
    deps.length > 0
  ) {
    const links = document.getElementsByTagName('link')
    const cspNonceMeta = document.querySelector<HTMLMetaElement>(
      'meta[property=csp-nonce]',
    )
    // `.nonce` should be used to get along with nonce hiding (https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/nonce#accessing_nonces_and_nonce_hiding)
    // Firefox 67-74 uses modern chunks and supports CSP nonce, but does not support `.nonce`
    // in that case fallback to getAttribute
    const cspNonce = cspNonceMeta?.nonce || cspNonceMeta?.getAttribute('nonce')

    promise = Promise.allSettled(
      deps.map((dep) => {
        // @ts-expect-error chunkRegistry is declared before preload.toString()
        dep = chunkRegistry[dep]

        // @ts-expect-error assetsURL is declared before preload.toString()
        dep = assetsURL(dep, importerUrl)
        if (dep in seen) return
        seen[dep] = true
        const isCss = dep.endsWith('.css')
        const cssSelector = isCss ? '[rel="stylesheet"]' : ''
        const isBaseRelative = !!importerUrl

        // check if the file is already preloaded by SSR markup
        if (isBaseRelative) {
          // When isBaseRelative is true then we have `importerUrl` and `dep` is
          // already converted to an absolute URL by the `assetsURL` function
          for (let i = links.length - 1; i >= 0; i--) {
            const link = links[i]
            // The `links[i].href` is an absolute URL thanks to browser doing the work
            // for us. See https://html.spec.whatwg.org/multipage/common-dom-interfaces.html#reflecting-content-attributes-in-idl-attributes:idl-domstring-5
            if (link.href === dep && (!isCss || link.rel === 'stylesheet')) {
              return
            }
          }
        } else if (
          document.querySelector(`link[href="${dep}"]${cssSelector}`)
        ) {
          return
        }

        const link = document.createElement('link')
        link.rel = isCss ? 'stylesheet' : scriptRel
        if (!isCss) {
          link.as = 'script'
        }
        link.crossOrigin = ''
        link.href = dep
        if (cspNonce) {
          link.setAttribute('nonce', cspNonce)
        }
        document.head.appendChild(link)
        if (isCss) {
          return new Promise((res, rej) => {
            link.addEventListener('load', res)
            link.addEventListener('error', () =>
              rej(new Error(`Unable to preload CSS for ${dep}`)),
            )
          })
        }
      }),
    )
  }

  function handlePreloadError(err: Error) {
    const e = new Event('vite:preloadError', {
      cancelable: true,
    }) as VitePreloadErrorEvent
    e.payload = err
    window.dispatchEvent(e)
    if (!e.defaultPrevented) {
      throw err
    }
  }

  return promise.then((res) => {
    for (const item of res || []) {
      if (item.status !== 'rejected') continue
      handlePreloadError(item.reason)
    }
    return baseModule().catch(handlePreloadError)
  })
}

/**
 * Build only. During serve this is performed as part of ./importAnalysis.
 */
export function buildImportAnalysisPlugin(config: ResolvedConfig): Plugin {
  const shouldInsertPreload = (environment: Environment) =>
    environment.config.consumer === 'client' &&
    !config.isWorker &&
    !config.build.lib

  const renderBuiltUrl = config.experimental.renderBuiltUrl
  const isRelativeBase = config.base === './' || config.base === ''

  return {
    name: 'vite:build-import-analysis',
    resolveId: {
      handler(id) {
        if (id === preloadHelperId) {
          return id
        }
      },
    },

    load: {
      handler(id) {
        if (id === preloadHelperId) {
          const { modulePreload } = this.environment.config.build

          const scriptRel =
            modulePreload && modulePreload.polyfill
              ? `'modulepreload'`
              : `/* @__PURE__ */ (${detectScriptRel.toString()})()`

          // There are two different cases for the preload list format in __vitePreload
          //
          // __vitePreload(() => import(asyncChunk), [ ...deps... ])
          //
          // This is maintained to keep backwards compatibility as some users developed plugins
          // using regex over this list to workaround the fact that module preload wasn't
          // configurable.
          const assetsURL =
            renderBuiltUrl || isRelativeBase
              ? // If `experimental.renderBuiltUrl` is used, the dependencies might be relative to the current chunk.
                // If relative base is used, the dependencies are relative to the current chunk.
                // The importerUrl is passed as third parameter to __vitePreload in this case
                `(dep, importerUrl) => new URL(dep, importerUrl).href`
              : // If the base isn't relative, then the deps are relative to the projects `outDir` and the base
                // is appended inside __vitePreload too.
                `(dep) => ${JSON.stringify(config.base)}+dep`
          const code = [
            `const chunkRegistry = ${chunkRegistryPlaceholder}`,
            `const scriptRel = ${scriptRel}`,
            `const assetsURL = ${assetsURL}`,
            `const seen = {}`,
            `export const ${preloadMethod} = ${preload.toString()}`,
          ].join(';')

          return {
            code,
            moduleSideEffects: false,
          }
        }
      },
    },

    transform: {
      async handler(source, importer) {
        if (isInNodeModules(importer) && !dynamicImportPrefixRE.test(source)) {
          return
        }

        await init

        let imports: readonly ImportSpecifier[] = []
        try {
          imports = parseImports(source)[0]
        } catch (_e: unknown) {
          const e = _e as EsModuleLexerParseError
          const { message, showCodeFrame } = createParseErrorInfo(
            importer,
            source,
          )
          this.error(message, showCodeFrame ? e.idx : undefined)
        }

        if (imports.length === 0) {
          return null
        }

        const willInsertPreload = shouldInsertPreload(this.environment)

        const s = new MagicString(source)
        let importedPreloadHelper = false

        for (const imp of imports) {
          const { s: start, e: end, se: expEnd } = imp

          const isDynamicImport = imp.d > -1
          const hasAttributes = imp.a > -1

          // strip import attributes as we process them ourselves
          if (!isDynamicImport && hasAttributes) {
            s.remove(end + 1, expEnd)
          }

          if (
            isDynamicImport &&
            willInsertPreload &&
            // Only preload static urls
            (source[start] === '"' ||
              source[start] === "'" ||
              source[start] === '`')
          ) {
            if (!importedPreloadHelper) {
              s.prepend(`
                import { ${preloadMethod} } from "${preloadHelperId}";
  
                // To prevent dead code elimination. Will properly remove in generateBundle
                // It's referenced twice so it doesn't get inlined by the minifier
                ${preloadSaver}(${preloadMethod},${preloadMethod});
              `)
              importedPreloadHelper = true
            }
          }
        }

        if (s.hasChanged()) {
          return {
            code: s.toString(),
            map: this.environment.config.build.sourcemap
              ? s.generateMap({ hires: 'boundary' })
              : null,
          }
        }
      },
    },

    // TODO: Move isEsmFlag logic out of this plugin. It's no longer used by the plugin but is used by the modulePreloadPolyfill plugin
    renderChunk(code, _, { format }) {
      const s = new MagicString(code)

      // make sure we only perform the preload logic in modern builds.
      if (code.includes(isEsmFlag)) {
        const isEsmFormat = String(format === 'es')
        let match: RegExpExecArray | null
        while ((match = isEsmFlagPattern.exec(code))) {
          s.update(match.index, match.index + isEsmFlag.length, isEsmFormat)
        }
      }

      if (format !== 'es') {
        if (code.includes(chunkRegistryPlaceholder)) {
          s.overwrite(
            code.indexOf(chunkRegistryPlaceholder),
            code.indexOf(chunkRegistryPlaceholder) +
              chunkRegistryPlaceholder.length,
            '""',
          )
        }

        if (code.includes(preloadSaver)) {
          let match: RegExpExecArray | null
          while ((match = preloadSaverCallPattern.exec(code))) {
            s.remove(match.index, match.index + match[0].length)
          }
        }
      }

      return {
        code: s.toString(),
        map: this.environment.config.build.sourcemap
          ? s.generateMap({ hires: 'boundary' })
          : null,
      }
    },

    generateBundle({ format }, bundle) {
      if (format !== 'es') {
        return
      }

      // If preload is not enabled, we parse through each imports and remove any imports to pure CSS chunks
      // as they are removed from the bundle
      if (!shouldInsertPreload(this.environment)) {
        const removedPureCssFiles = removedPureCssFilesCache.get(config)
        if (removedPureCssFiles && removedPureCssFiles.size > 0) {
          for (const file in bundle) {
            const chunk = bundle[file]
            if (chunk.type === 'chunk' && chunk.code.includes('import')) {
              const code = chunk.code
              let imports!: ImportSpecifier[]
              try {
                imports = parseImports(code)[0].filter((i) => i.d > -1)
              } catch (e: any) {
                const loc = numberToPos(code, e.idx)
                this.error({
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                  cause: e.cause,
                  pos: e.idx,
                  loc: { ...loc, file: chunk.fileName },
                  frame: generateCodeFrame(code, loc),
                })
              }

              for (const imp of imports) {
                const {
                  n: name,
                  s: start,
                  e: end,
                  ss: expStart,
                  se: expEnd,
                } = imp
                let url = name
                if (!url) {
                  const rawUrl = code.slice(start, end)
                  if (rawUrl[0] === `"` && rawUrl.endsWith(`"`))
                    url = rawUrl.slice(1, -1)
                }
                if (!url) continue

                const normalizedFile = path.posix.join(
                  path.posix.dirname(chunk.fileName),
                  url,
                )
                if (removedPureCssFiles.has(normalizedFile)) {
                  // remove with Promise.resolve({}) while preserving source map location
                  chunk.code =
                    chunk.code.slice(0, expStart) +
                    `Promise.resolve({${''.padEnd(expEnd - expStart - 19, ' ')}})` +
                    chunk.code.slice(expEnd)
                }
              }
            }
          }
        }
        return
      }
      const buildSourcemap = this.environment.config.build.sourcemap
      const { modulePreload } = this.environment.config.build

      const chunkRegistry: string[] = []
      const getChunkId = (url: string, runtime: boolean = false) => {
        if (!runtime) {
          url = JSON.stringify(url)
        }
        const index = chunkRegistry.indexOf(url)
        return index > -1 ? index : chunkRegistry.push(url) - 1
      }

      for (const chunkName in bundle) {
        const chunk = bundle[chunkName]
        if (chunk.type !== 'chunk') {
          continue
        }

        const { code, fileName: parentChunkName } = chunk

        // can't use chunk.dynamicImports.length here since some modules e.g.
        // dynamic import to constant json may get inlined.
        if (!code.includes(preloadSaver)) {
          continue
        }

        const s = new MagicString(code)

        let preloadMethodImportedAs: string | undefined
        let match: RegExpExecArray | null
        while ((match = preloadSaverCallPattern.exec(code))) {
          preloadMethodImportedAs = match[1].split(',')[0].trim()

          // Overwrite with no-op
          s.overwrite(match.index, match.index + match[0].length, '0')
        }

        let dynamicImports!: ImportSpecifier[]
        try {
          dynamicImports = parseImports(code)[0].filter((i) => i.d !== -1)
        } catch (e: any) {
          const loc = numberToPos(code, e.idx)
          this.error({
            name: e.name,
            message: e.message,
            stack: e.stack,
            cause: e.cause,
            pos: e.idx,
            loc: {
              ...loc,
              file: parentChunkName,
            },
            frame: generateCodeFrame(code, loc),
          })
        }

        for (const dynamicImport of dynamicImports) {
          // To handle escape sequences in specifier strings, the .n field will be provided where possible.
          const { s: start, e: end, ss: expStart, se: expEnd } = dynamicImport

          // check the chunk being imported
          let importUrl = dynamicImport.n

          // TODO: Why would it be empty?
          if (!importUrl) {
            const rawUrl = code.slice(start, end)

            // TODO: Why not check single quotes too?
            if (rawUrl[0] === `"` && rawUrl.endsWith(`"`)) {
              importUrl = rawUrl.slice(1, -1)
            }
          }

          const dependencies = new Set<string>()
          let hasRemovedPureCssChunk = false

          let importUrlResolved: string | undefined = undefined

          if (importUrl) {
            // Resolve import target path
            importUrlResolved = path.posix.join(
              path.posix.dirname(parentChunkName),
              importUrl, // What if it's ../../ ?
            )

            // TODO: Dedupe across ssrManifestPlugin.ts
            // Track traversed to prevent loops
            const traversed = new Set<string>()
            ;(function traverseChunkDependencies(chunkName: string) {
              if (chunkName === parentChunkName) return
              if (traversed.has(chunkName)) return
              traversed.add(chunkName)
              const chunk = bundle[chunkName]
              if (chunk) {
                dependencies.add(chunk.fileName)
                if (chunk.type === 'chunk') {
                  chunk.imports.forEach(traverseChunkDependencies)
                  // Ensure that the css imported by current chunk is loaded after the dependencies.
                  // So the style of current chunk won't be overwritten unexpectedly.
                  chunk.viteMetadata!.importedCss.forEach((file) =>
                    dependencies.add(file),
                  )
                }
              } else {
                const removedPureCssFiles =
                  removedPureCssFilesCache.get(config)!
                const chunk = removedPureCssFiles.get(chunkName)
                if (chunk) {
                  if (chunk.viteMetadata!.importedCss.size) {
                    chunk.viteMetadata!.importedCss.forEach((file) =>
                      dependencies.add(file),
                    )
                    hasRemovedPureCssChunk = true
                  }

                  s.update(expStart, expEnd, 'Promise.resolve({})')
                }
              }
            })(importUrlResolved)
          }

          // the dep list includes the main chunk, so only need to reload when there are actual other deps.
          let depsArray =
            dependencies.size > 1 ||
            // main chunk is removed
            (hasRemovedPureCssChunk && dependencies.size > 0)
              ? modulePreload === false
                ? // CSS deps use the same mechanism as module preloads, so even if disabled,
                  // we still need to pass these deps to the preload helper in dynamic imports.
                  [...dependencies].filter((d) => d.endsWith('.css'))
                : [...dependencies]
              : []

          const resolveDependencies = modulePreload
            ? modulePreload.resolveDependencies
            : undefined
          if (resolveDependencies && importUrlResolved) {
            // We can't let the user remove css deps as these aren't really preloads, they are just using
            // the same mechanism as module preloads for this chunk
            const cssDeps: string[] = []
            const otherDeps: string[] = []
            for (const dep of depsArray) {
              ;(dep.endsWith('.css') ? cssDeps : otherDeps).push(dep)
            }
            depsArray = [
              ...resolveDependencies(importUrlResolved, otherDeps, {
                hostId: chunkName,
                hostType: 'js',
              }),
              ...cssDeps,
            ]
          }

          let chunkDependencies: number[]
          if (renderBuiltUrl) {
            chunkDependencies = depsArray.map((dep) => {
              const replacement = toOutputFilePathInJS(
                this.environment,
                dep,
                'asset',
                chunk.fileName,
                'js',
                toRelativePath,
              )

              if (typeof replacement === 'string') {
                return getChunkId(replacement)
              }

              return getChunkId(replacement.runtime, true)
            })
          } else {
            chunkDependencies = depsArray.map((d) =>
              // Don't include the assets dir if the default asset file names
              // are used, the path will be reconstructed by the import preload helper
              isRelativeBase
                ? getChunkId(toRelativePath(d, chunkName))
                : getChunkId(d),
            )
          }

          // Preload util is only injected if there's dependencies to preload
          if (chunkDependencies.length > 0) {
            s.prependLeft(expStart, `${preloadMethodImportedAs}(() => `)
            s.appendRight(
              expEnd,
              `,[${chunkDependencies.join(',')}]${
                renderBuiltUrl || isRelativeBase ? ',import.meta.url' : ''
              })`,
            )
          }
        }

        if (s.hasChanged()) {
          patchChunkWithMagicString(chunk, s)
        }
      }

      const chunkToPatchWithRegistry = Object.values(bundle).find(
        (chunk) =>
          chunk.type === 'chunk' &&
          chunk.code.includes(chunkRegistryPlaceholder),
      ) as OutputChunk | undefined
      if (chunkToPatchWithRegistry) {
        const chunkRegistryCode = `[${chunkRegistry.join(',')}]`
        const s = new MagicString(chunkToPatchWithRegistry.code)
        s.overwrite(
          chunkToPatchWithRegistry.code.indexOf(chunkRegistryPlaceholder),
          chunkToPatchWithRegistry.code.indexOf(chunkRegistryPlaceholder) +
            chunkRegistryPlaceholder.length,
          chunkRegistryCode,
        )

        patchChunkWithMagicString(chunkToPatchWithRegistry, s)
      }

      function patchChunkWithMagicString(chunk: OutputChunk, s: MagicString) {
        chunk.code = s.toString()

        if (!buildSourcemap || !chunk.map) {
          return
        }

        const { debugId } = chunk.map
        const map = combineSourcemaps(chunk.fileName, [
          s.generateMap({
            source: chunk.fileName,
            hires: 'boundary',
          }) as RawSourceMap,
          chunk.map as RawSourceMap,
        ]) as SourceMap
        map.toUrl = () => genSourceMapUrl(map)
        chunk.map = map

        if (buildSourcemap === 'inline') {
          chunk.code = chunk.code.replace(
            convertSourceMap.mapFileCommentRegex,
            '',
          )
          chunk.code += `\n//# sourceMappingURL=${genSourceMapUrl(map)}`
        } else {
          if (debugId) {
            map.debugId = debugId
          }
          const mapAsset = bundle[chunk.fileName + '.map']
          if (mapAsset && mapAsset.type === 'asset') {
            mapAsset.source = map.toString()
          }
        }
      }
    },
  }
}
