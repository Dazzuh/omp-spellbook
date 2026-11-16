/** A model and the thinking level it is configured with. */
export interface Configured<M, T> {
	model: M;
	thinkingLevel?: T;
}

export interface PickedModel<M, T> extends Configured<M, T> {
	/** Which source supplied it: the `spellbook` role, the `smol` role, or the session model as a last resort. */
	via: "spellbook" | "smol" | "session";
}

/** How Spellbook reads omp's roles and the session's model; omp's `resolveRoleSelection` and the session in practice. */
export interface ModelSources<M, T> {
	/** The first role in `roles` that resolves, with its model and thinking level. */
	role(roles: readonly string[]): (Configured<M, T> & { role: string }) | undefined;
	/** The session's own model and thinking level. */
	session(): Configured<M, T> | undefined;
}

/** Model for a cast, run as configured: role `spellbook`, else role `smol`, else the session's model. */
export function pickModel<M, T>(sources: ModelSources<M, T>): PickedModel<M, T> | undefined {
	const role = sources.role(["spellbook", "smol"]);
	if (role) return { model: role.model, thinkingLevel: role.thinkingLevel, via: role.role === "spellbook" ? "spellbook" : "smol" };
	const session = sources.session();
	return session?.model ? { model: session.model, thinkingLevel: session.thinkingLevel, via: "session" } : undefined;
}
