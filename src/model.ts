/** A model and the thinking level it is configured with. */
export interface Configured<M, T> {
	model: M;
	thinkingLevel?: T;
}

/** What the `model` setting resolved to for one cast. */
export interface CastModel<M, T> extends Configured<M, T> {
	/** The `model` setting as configured: `@smol`, `anthropic/claude-haiku-5-5:low`. */
	selector: string;
	/** Set when the setting did not resolve and the cast runs on the session's model instead: why. */
	fallback?: string;
}

/** How Spellbook resolves a selector and reads the session's model; omp's `resolveCliModel` and the session in practice. */
export interface ModelSources<M, T> {
	/** The selector as omp resolves prewalk targets: role aliases, `provider/id`, a `:thinking` suffix. */
	resolve(selector: string): { model?: M; thinkingLevel?: T; error?: string };
	/** Why `model` can't be used (no credentials, disabled provider), or undefined when it can. */
	unusable(model: M): string | undefined;
	/** The session's own model and thinking level. */
	session(): Configured<M, T> | undefined;
}

/**
 * The model a cast runs on: the `model` setting with its thinking level, or, when it doesn't
 * resolve to a usable model, the session's model and thinking level with the reason in `fallback`.
 * Throws when neither is available.
 */
export function castModel<M, T>(selector: string, sources: ModelSources<M, T>): CastModel<M, T> {
	let reason: string;
	try {
		const resolved = sources.resolve(selector);
		const unusable = resolved.model === undefined ? undefined : sources.unusable(resolved.model);
		if (resolved.model !== undefined && unusable === undefined) {
			return { model: resolved.model, thinkingLevel: resolved.thinkingLevel, selector };
		}
		reason = unusable ?? resolved.error ?? `model "${selector}" not found`;
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
	}
	const session = sources.session();
	if (!session) throw new Error(`model setting "${selector}": ${reason}; the session has no model to fall back to`);
	return { model: session.model, thinkingLevel: session.thinkingLevel, selector, fallback: reason };
}
