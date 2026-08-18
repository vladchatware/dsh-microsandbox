//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-microsandbox`.
* @module @deepseek-ai/dsh-tool-microsandbox/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-microsandbox";
/** Cordis companion plugin name. */
const name = "tool-microsandbox-invariant";
/** Service required before reserving package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the tool returns the microVM's committed exec result
* with no independent event or cache to cross-check.
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
