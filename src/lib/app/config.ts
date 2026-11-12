import { dirname } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'

/**
 * The app `kit app …`, `kit qa` and `kit shots` build, install and drive: `app.*` in kit.config.ts,
 * each field falling back to `release.*`. Building and installing a debug app is not a release
 * concern, but a repo that already releases has every value kit needs.
 */

export interface IosApp {
  bundleId: string
  /** Repo-relative `.xcodeproj` or `.xcworkspace`. */
  project: string
  scheme: string
  /** Kotlin toolchain module that builds the app (`iosApp`). */
  module: string
}

export interface AndroidApp {
  packageName: string
  /** Gradle project path (`:android`), or the toolchain module name (`androidApp`). */
  module: string
}

function need<T>(value: T | undefined, key: string, fallback: string): T {
  if (value === undefined || value === '') {
    throw new KitError(
      `kit.config.ts sets no ${key}`,
      `Set ${key}, or ${fallback} which it falls back to`,
      ExitCode.config,
    )
  }
  return value
}

export function iosApp(config: KitConfig): IosApp {
  const app = config.app?.ios
  const release = config.release?.ios
  const project = need(app?.project ?? release?.project, 'app.ios.project', 'release.ios.project')
  return {
    bundleId: need(app?.bundleId ?? release?.bundleIds[0], 'app.ios.bundleId', 'release.ios.bundleIds'),
    project,
    scheme: need(app?.scheme ?? release?.scheme, 'app.ios.scheme', 'release.ios.scheme'),
    module: app?.module ?? dirname(project).split('/').pop()!,
  }
}

export function androidApp(config: KitConfig): AndroidApp {
  const app = config.app?.android
  const release = config.release?.android
  return {
    packageName: need(
      app?.packageName ?? release?.packageName,
      'app.android.packageName',
      'release.android.packageName',
    ),
    module: need(app?.module ?? release?.module, 'app.android.module', 'release.android.module'),
  }
}
