import {
  createVueFilter,
  createVuePartRequest,
  parseVuePartRequest,
  resolveVuePart,
  isVuePartRequest,
  transformRequireToImport
} from './utils'
import {
  createDefaultCompiler,
  assemble,
  ScriptOptions,
  StyleOptions,
  TemplateOptions,
  StyleCompileResult
} from '@vue/component-compiler'
import { Plugin } from 'rollup'
import * as path from 'path'
import { parse, SFCDescriptor, SFCBlock } from '@vue/component-compiler-utils'
import debug from 'debug'
import { VueTemplateCompiler, VueTemplateCompilerParseOptions } from '@vue/component-compiler-utils/dist/types'

const templateCompiler = require('vue-template-compiler')
const hash = require('hash-sum')
const d = debug('rollup-plugin-vue')
const { version } = require('../package.json')

export interface VuePluginOptions {
  /**
   * Include files or directories.
   * @default `'.vue'`
   */
  include?: Array<string | RegExp> | string | RegExp
  /**
   * Exclude files or directories.
   * @default `undefined`
   */
  exclude?: Array<string | RegExp> | string | RegExp
  /**
   * Default language for blocks.
   *
   * @default `{}`
   * @example
   * ```js
   * VuePlugin({ defaultLang: { script: 'ts' } })
   * ```
   */
  defaultLang?: {
    [key: string]: string
  }
  /**
   * Exclude customBlocks for final build.
   * @default `['*']`
   * @example
   * ```js
   * VuePlugin({ blackListCustomBlocks: ['markdown', 'test'] })
   * ```
   */
  blackListCustomBlocks?: string[]
  /**
   * Include customBlocks for final build.
   * @default `[]`
   * @example
   * ```js
   * VuePlugin({ blackListCustomBlocks: ['markdown', 'test'] })
   * ```
   */
  whiteListCustomBlocks?: string[]
  /**
   * Inject CSS in JavaScript.
   * @default `true`
   * @example
   * ```js
   * VuePlugin({ css: false }) // to extract css
   * ```
   */
  css?: boolean
  compiler?: VueTemplateCompiler
  compilerParseOptions?: VueTemplateCompilerParseOptions
  sourceRoot?: string
  /**
   * @@vue/component-compiler [#](https://github.com/vuejs/vue-component-compiler#api) script processing options.
   */
  script?: ScriptOptions
  /**
   * @@vue/component-compiler [#](https://github.com/vuejs/vue-component-compiler#api) style processing options.
   */
  style?: StyleOptions
  /**
   * @@vue/component-compiler [#](https://github.com/vuejs/vue-component-compiler#api) template processing options.
   */
  template?: TemplateOptions
  /**
   * @@vue/component-compiler [#](https://github.com/vuejs/vue-component-compiler#api) module name or global function for custom runtime component normalizer.
   */
  normalizer?: string
  /**
   * @@vue/component-compiler [#](https://github.com/vuejs/vue-component-compiler#api) module name or global function for custom style injector factory.
   */
  styleInjector?: string
  /**
   * @@vue/component-compiler [#](https://github.com/vuejs/vue-component-compiler#api) module name or global function for custom style injector factory for SSR environment.
   */
  styleInjectorSSR?: string
}
/**
 * Rollup plugin for handling .vue files.
 */
export default function VuePlugin(opts: VuePluginOptions = {}): Plugin {
  const isVue = createVueFilter(opts.include, opts.exclude)
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.BUILD === 'production'

  d('Version ' + version)
  d(`Build environment: ${isProduction ? 'production' : 'development'}`)
  d(`Build target: ${process.env.VUE_ENV || 'browser'}`)

  if (!opts.normalizer) opts.normalizer = '~vue-runtime-helpers/normalize-component.js'
  if (!opts.styleInjector) opts.styleInjector = '~vue-runtime-helpers/inject-style/browser.js'
  if (!opts.styleInjectorSSR) opts.styleInjectorSSR = '~vue-runtime-helpers/inject-style/server.js'

  createVuePartRequest.defaultLang = {
    ...createVuePartRequest.defaultLang,
    ...opts.defaultLang
  }

  const shouldExtractCss = opts.css === false
  const blacklisted = new Set(opts.blackListCustomBlocks || ['*'])
  const whitelisted = new Set(opts.whiteListCustomBlocks || [])

  const isAllowed = (customBlockType: string) =>
    (!blacklisted.has('*') || !blacklisted.has(customBlockType)) &&
    (whitelisted.has('*') || whitelisted.has(customBlockType))

  delete opts.css
  delete opts.blackListCustomBlocks
  delete opts.whiteListCustomBlocks
  delete opts.defaultLang
  delete opts.include
  delete opts.exclude

  opts.template = {
    transformAssetUrls: {
      video: ['src', 'poster'],
      source: 'src',
      img: 'src',
      image: 'xlink:href'
    },
    ...opts.template
  } as any
  if (opts.template && typeof opts.template.isProduction === 'undefined') {
    opts.template.isProduction = isProduction
  }
  const compiler = createDefaultCompiler(opts)
  const descriptors = new Map<string, SFCDescriptor>()

  if (opts.css === false) d('Running in CSS extract mode')

  return {
    name: 'VuePlugin',

    resolveId(id, importer) {
      if (!isVuePartRequest(id)) return
      id = path.resolve(path.dirname(importer), id)
      const ref = parseVuePartRequest(id)
      if (ref) {
        const element = resolveVuePart(descriptors, ref)
        const src = (element as SFCBlock).src
        if (ref.meta.type !== 'styles' && typeof src === 'string') {
          if (src.startsWith('.')) {
            return path.resolve(path.dirname(ref.filename), src as string)
          } else {
            return require.resolve(src, { paths: [path.dirname(ref.filename)] })
          }
        }

        return id
      }
    },

    load(id: string) {
      const request = parseVuePartRequest(id)

      if (!request) return

      const element = resolveVuePart(descriptors, request)
      const code = 'code' in element
        ? ((element as any).code as string) // .code is set when extract styles is used. { css: false }
        : element.content
      const map = element.map as any

      return { code, map }
    },

    async transform(source: string, filename: string) {
      if (isVue(filename)) {
        const descriptor: SFCDescriptor = JSON.parse(JSON.stringify(parse({
          filename,
          source,
          compiler: opts.compiler || templateCompiler,
          compilerParseOptions: opts.compilerParseOptions,
          sourceRoot: opts.sourceRoot,
          needMap: true
        })))

        const scopeId =
          'data-v-' +
          (isProduction
            ? hash(path.basename(filename) + source)
            : hash(filename + source))
        descriptors.set(filename, descriptor)

        const styles = await Promise.all(
          descriptor.styles.map(async style => {
            const compiled = await compiler.compileStyleAsync(filename, scopeId, style)
            if (compiled.errors.length > 0) throw Error(compiled.errors[0])
            return compiled
          })
        )

        const input: any = {
          scopeId,
          styles,
          customBlocks: []
        }

        if (descriptor.template) {
          input.template = compiler.compileTemplate(
            filename,
            descriptor.template
          )

          input.template.code = transformRequireToImport(
            input.template.code
          )

          if (input.template.errors && input.template.errors.length) {
            input.template.errors.map((error: Error) => this.error(error))
          }

          if (input.template.tips && input.template.tips.length) {
            input.template.tips.map((message: string) => this.warn({ message }))
          }
        }

        input.script = descriptor.script
          ? {
              code: `
            export * from '${createVuePartRequest(
              filename,
              descriptor.script.lang || 'js',
              'script'
            )}'
            import script from '${createVuePartRequest(
              filename,
              descriptor.script.lang || 'js',
              'script'
            )}'
            export default script
            `
            }
          : { code: '' }

        if (shouldExtractCss) {
          input.styles = input.styles
            .map((style: StyleCompileResult, index: number) => {
              ;(descriptor.styles[index] as any).code = style.code

              input.script.code +=
                '\n' +
                `import '${createVuePartRequest(
                  filename,
                  'css',
                  'styles',
                  index
                )}'`

              if (style.module || descriptor.styles[index].scoped) {
                return { ...style, code: '' }
              }
            })
            .filter(Boolean)
        }

        const result = assemble(compiler, filename, input, opts)

        descriptor.customBlocks.forEach((block, index) => {
          if (!isAllowed(block.type)) return
          result.code +=
            '\n' +
            `export * from '${createVuePartRequest(
              filename,
              block.attrs.lang ||
                createVuePartRequest.defaultLang[block.type] ||
                block.type,
              'customBlocks',
              index
            )}'`
        })

        return result
      }
    }
  }
}
