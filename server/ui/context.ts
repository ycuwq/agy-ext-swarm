/**
 * Tiny injected context shared by the extracted view modules.
 *
 * `tr` depends on the active locale which lives in the store; keeping the
 * translation entrypoint here (rather than importing app.ts) avoids a cycle
 * while letting pure helpers stay stateless with respect to the DOM.
 */
import { t, type I18nKey } from './i18n.js';
import { state } from './store.js';

export function tr(key: I18nKey, vars?: Record<string, string | number>): string {
  return t(state.currentLocale, key, vars);
}
