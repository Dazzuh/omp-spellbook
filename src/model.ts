/** The slice of omp's `ctx.models` Spellbook needs. */
export interface ModelQuery<M> {
	resolve(spec: string): M | undefined;
	current(): M | undefined;
}

export interface PickedModel<M> {
	model: M;
	/** Which source supplied it: the `spellbook` role, the `smol` role, or the session model as a last resort. */
	via: "spellbook" | "smol" | "session";
}

/** Model for a cast: role `spellbook`, else role `smol`, else the session's own model. */
export function pickModel<M>(models: ModelQuery<M>): PickedModel<M> | undefined {
	const spellbook = models.resolve("@spellbook");
	if (spellbook) return { model: spellbook, via: "spellbook" };
	const smol = models.resolve("@smol");
	if (smol) return { model: smol, via: "smol" };
	const session = models.current();
	return session ? { model: session, via: "session" } : undefined;
}

/** The text of an assistant message, or throws its error. */
export function replyText(message: {
	content: ReadonlyArray<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
}): string {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage || `model request ${message.stopReason}`);
	}
	return message.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("");
}
