/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subprocess-microsandbox`.
 * @module @deepseek-ai/dsh-subprocess-microsandbox/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subprocess-microsandbox'

/** Cordis companion plugin name. */
export const name = 'subprocess-microsandbox-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every managed process/terminal returns the microVM's
 * committed exit facts with no independent event or cache to cross-check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
