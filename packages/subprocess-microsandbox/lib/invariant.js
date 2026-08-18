//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-subprocess-microsandbox`.
* @module @deepseek-ai/dsh-subprocess-microsandbox/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-subprocess-microsandbox";
/** Cordis companion plugin name. */
const name = "subprocess-microsandbox-invariant";
/** Service required before reserving package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: every managed process/terminal returns the microVM's
* committed exit facts with no independent event or cache to cross-check.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
