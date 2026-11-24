/**
 * Late-bound hooks that would otherwise create an import cycle between
 * `settings-view.ts` (which refreshes provider cards) and
 * `onboarding-view.ts` (which re-renders the wizard whenever provider state
 * changes). `onboarding-view.ts` registers itself here at module load; until
 * then the hook is a no-op, which matches the old "only render if visible"
 * guard because the wizard cannot be visible before it is constructed.
 */
type OnboardingRenderer = () => void;

let onboardingRenderer: OnboardingRenderer | null = null;

/** Called from onboarding-view.ts at module scope. */
export function registerOnboardingRenderer(fn: OnboardingRenderer): void {
  onboardingRenderer = fn;
}

/** Render the onboarding wizard iff a renderer is registered. */
export function renderOnboardingIfRegistered(): void {
  onboardingRenderer?.();
}
