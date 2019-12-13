import { NexusConfig } from './nexus'
import * as Layout from './layout'
import * as Chokidar from '../watcher/chokidar'
import { logger } from '../utils/logger'
import { runSync, pog, fatal, run } from '../utils'
import { Debugger } from 'debug'
import * as fs from 'fs-jetpack'
import { stripIndent } from 'common-tags'
import prompts from 'prompts'

// TODO move to utils module
type MaybePromise<T = void> = T | Promise<T>
type CallbackRegistrar<F> = (f: F) => void
type SideEffector = () => MaybePromise

export type OnAfterBaseSetupLens = {
  database: 'SQLite' | 'MySQL' | 'PostgreSQL' | undefined
  connectionURI: string | undefined
}

export type WorkflowHooks = {
  create: {
    onAfterBaseSetup?: (lens: OnAfterBaseSetupLens) => MaybePromise
  }
  dev: {
    onStart?: SideEffector
    onFileWatcherEvent?: Chokidar.FileWatcherEventCallback
    addToSettings: {
      watchFilePatterns?: string[]
      ignoreFilePatterns?: string[]
    }
  }
  generate: {
    onStart?: SideEffector
  }
  build: {
    onStart?: SideEffector
  }
}

export type WorkflowDefiner = (
  hooks: WorkflowHooks,
  workflowContext: {
    layout: Layout.Layout
  }
) => void

/**
 * The possible things that plugins can contribute toward at runtime. Everything
 * is optional.
 */
export type RuntimeContributions<C extends {} = any> = {
  context?: {
    typeGen: {
      fields: Record<string, string>
      imports?: Array<{
        as: string
        from: string
      }>
    }
    create: (req: Express.Request) => C
  }
  nexus?: {
    plugins: NexusConfig['plugins']
  }
}

type RuntimePlugin = () => RuntimeContributions

export type Lens = {
  runtime: CallbackRegistrar<RuntimePlugin>
  workflow: CallbackRegistrar<WorkflowDefiner>
  utils: {
    log: typeof logger
    runSync: typeof runSync
    run: typeof run
    debug: Debugger
    /**
     * Check out https://github.com/terkelg/prompts for documentation
     */
    prompt: typeof prompts
  }
}

type PluginPackage = {
  create: DriverCreator
}

type Definer = (lens: Lens) => void

export type DriverCreator = (pluginName: string) => Driver

export type Driver = {
  name: string
  extendsWorkflow: boolean
  extendsRuntime: boolean
  loadWorkflowPlugin: (layout: Layout.Layout) => WorkflowHooks
  loadRuntimePlugin: () => undefined | RuntimeContributions
}

export function create(definer: Definer): DriverCreator {
  let maybeWorkflowPlugin: undefined | WorkflowDefiner
  let maybeRuntimePlugin: undefined | RuntimePlugin

  return pluginName => {
    definer({
      runtime(f) {
        maybeRuntimePlugin = f
      },
      workflow(f) {
        maybeWorkflowPlugin = f
      },
      utils: {
        log: logger,
        run,
        runSync,
        debug: pog.sub(`plugin:${pluginName}`),
        prompt: prompts,
      },
    })

    return {
      name: pluginName,
      extendsWorkflow: maybeWorkflowPlugin !== undefined,
      extendsRuntime: maybeRuntimePlugin !== undefined,
      loadWorkflowPlugin(layout) {
        const hooks = {
          create: {},
          dev: {
            addToSettings: {},
          },
          build: {},
          generate: {},
        }
        maybeWorkflowPlugin?.(hooks, { layout })
        return hooks
      },
      loadRuntimePlugin() {
        return maybeRuntimePlugin?.()
      },
    }
  }
}

// export type Plugin<C extends {} = any> = {
//   // TODO We need to enforce the invariant that plugin names are unique or
//   // adding randomization into where they are used for naming (e.g. context
//   // import alias) or derive unique identifier from plugins off something else
//   // like their package name.
//   // name: string
//   workflow?: WorkflowContributions
//   runtime?: {
//     /**
//      * Run when ... TODO
//      */
//     onInstall?: () => RuntimeContributions
//   }
// }

// export type WorkflowContributions = {
//   onBuildStart?: () => MaybePromise<void>
//   onDevStart?: () => MaybePromise<void>
//   onDevFileWatcherEvent?: Chokidar.FileWatcherEventCallback
//   watchFilePatterns?: string[]
//   ignoreFilePatterns?: string[]
//   onGenerateStart?: () => MaybePromise<void>
//   onCreateAfterScaffold?: (socket: Socket) => MaybePromise<void>
//   onCreateAfterDepInstall?: (socket: Socket) => MaybePromise<void>
// }

/**
 * Cutely named, this is just the handle that plugins get access to aid
 * integration. Includes utilities for logging, and access to project layout data.
 */
// export type Socket = {
//   // TODO something richer
//   log: typeof console.log
//   layout: Layout.Layout
// }

/**
 * Load all pumpkins plugins installed into the project
 */
export async function loadAllFromPackageJson(): Promise<Driver[]> {
  const packageJson: undefined | Record<string, any> = await fs.readAsync(
    'package.json',
    'json'
  )
  return __doLoadAllFromPackageJson(packageJson)
}

/**
 * Load all pumpkins plugins installed into the project
 */
export function loadAllFromPackageJsonSync(): Driver[] {
  const packageJson: undefined | Record<string, any> = fs.read(
    'package.json',
    'json'
  )
  return __doLoadAllFromPackageJson(packageJson)
}

/**
 * Logic shared between sync/async variants.
 */
function __doLoadAllFromPackageJson(
  packageJson: undefined | Record<string, any>
): Driver[] {
  if (packageJson === undefined) return []

  const deps: Record<string, string> = packageJson?.dependencies ?? {}

  const depNames = Object.keys(deps)
  if (depNames.length === 0) return []

  const pumpkinsPluginDepNames = depNames.filter(depName =>
    depName.match(/^pumpkins-plugin-.+/)
  )
  if (pumpkinsPluginDepNames.length === 0) return []

  const instantiatedPlugins: Driver[] = pumpkinsPluginDepNames.map(depName => {
    const pluginName = parsePluginName(depName)! // filter above guarantees

    let SomePlugin: PluginPackage
    try {
      SomePlugin = require(depName)
    } catch (error) {
      fatal(
        stripIndent`
        An error occured while importing the plugin ${pluginName}:

        ${error}
      `
      )
    }

    if (typeof SomePlugin.create !== 'function') {
      // TODO add link to issue tracker extracted from plugin's package.json
      fatal(
        `The plugin "${pluginName}" you are attempting to use does not export a "create" value.`
      )
    }

    // Do symbol check to improve feedback upon install failure

    let instantiatedPlugin: Driver
    try {
      instantiatedPlugin = SomePlugin.create(pluginName)
    } catch (error) {
      fatal(
        stripIndent`
          An error occured while loading the plugin "${pluginName}":

          ${error}
        `
      )
    }
    return instantiatedPlugin
  })

  return instantiatedPlugins
}

/**
 * Parse a pumpkins plugin package name to just the plugin name.
 */
export function parsePluginName(packageName: string): null | string {
  const matchResult = packageName.match(/^pumpkins-plugin-(.+)/)

  if (matchResult === null) return null

  const pluginName = matchResult[1]

  return pluginName
}

/**
 * Load all workflow plugins that are installed into the project.
 */
export async function loadAllWorkflowPluginsFromPackageJson(
  layout: Layout.Layout
): Promise<WorkflowHooks[]> {
  const plugins = await loadAllFromPackageJson()
  const workflowHooks = plugins
    .filter(driver => driver.extendsWorkflow)
    .map(driver => {
      let workflowComponent: WorkflowHooks
      try {
        workflowComponent = driver.loadWorkflowPlugin(layout)
      } catch (error) {
        fatal(
          stripIndent`
          Error while trying to load the workflow component of plugin "${driver.name}":
          
          ${error}
        `
        )
      }
      return workflowComponent
    })

  return workflowHooks
}

/**
 * Load all runtime plugins that are installed into the project.
 */
export async function loadAllRuntimePluginsFromPackageJson(): Promise<
  RuntimeContributions[]
> {
  const plugins = await loadAllFromPackageJson()
  return __doLoadAllRuntimePluginsFromPackageJson(plugins)
}

/**
 * Load all runtime plugins that are installed into the project.
 */
export function loadAllRuntimePluginsFromPackageJsonSync(): RuntimeContributions[] {
  const plugins = loadAllFromPackageJsonSync()
  return __doLoadAllRuntimePluginsFromPackageJson(plugins)
}

/**
 * Logic shared between sync/async variants.
 */
export function __doLoadAllRuntimePluginsFromPackageJson(
  plugins: Driver[]
): RuntimeContributions[] {
  const workflowHooks = plugins
    .filter(driver => driver.extendsRuntime)
    .map(driver => {
      let runtimeContributions: RuntimeContributions
      try {
        runtimeContributions = driver.loadRuntimePlugin()! // guaranteed by above filter
      } catch (error) {
        fatal(
          stripIndent`
          Error while trying to load the runtime component of plugin "${driver.name}":
          
          ${error}
        `
        )
      }
      return runtimeContributions
    })

  return workflowHooks
}
