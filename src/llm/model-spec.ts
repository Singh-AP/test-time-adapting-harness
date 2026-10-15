/** Model references: "provider/model-id" (any pi-ai provider), or a bare model id of Amazon Bedrock. */
export const DEFAULT_PROVIDER = "amazon-bedrock";

export interface ModelLookup<M> {
	getProviders(): readonly { id: string }[];
	getModel(provider: string, id: string): M | undefined;
}

/**
 * Splits at the first slash when the prefix names a known provider, so router ids such as
 * "openrouter/anthropic/claude-sonnet-5.5" keep their own slash. Anything else, including Bedrock inference-profile
 * ARNs, is a model of the default provider.
 */
export function parseModelSpec(spec: string, providers: readonly string[]): { provider: string; id: string } {
	const slash = spec.indexOf("/");
	const prefix = spec.slice(0, slash);
	if (slash > 0 && providers.includes(prefix)) return { provider: prefix, id: spec.slice(slash + 1) };
	return { provider: DEFAULT_PROVIDER, id: spec };
}

export function resolveModel<M>(lookup: ModelLookup<M>, spec: string): M {
	const { provider, id } = parseModelSpec(
		spec,
		lookup.getProviders().map((p) => p.id),
	);
	const model = lookup.getModel(provider, id);
	if (!model) {
		throw new Error(
			`Unknown ${provider} model "${id}". Use provider/model, for example anthropic/claude-sonnet-5-5 or ` +
				"amazon-bedrock/global.anthropic.claude-sonnet-5-5 (a bare id is an Amazon Bedrock model).",
		);
	}
	return model;
}
