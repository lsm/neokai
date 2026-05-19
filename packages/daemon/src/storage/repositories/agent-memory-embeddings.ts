import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { withoutAuthorization } from './agent-memory-fetch-options';
import type { AgentMemoryEmbedder } from './agent-memory-repository';

const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GITHUB_RELEASE_BASE = 'https://github.com/lsm/neokai/releases/download/embedding-models-v1';
const DIMENSIONS = 384;

const defaultFetch = env.fetch;
env.fetch = (url, options) => {
	const urlString = url.toString();
	if (urlString.includes('huggingface.co') && urlString.includes('granite-embedding-small')) {
		const filename = urlString.split('/').pop();
		return defaultFetch(`${GITHUB_RELEASE_BASE}/${filename}`, withoutAuthorization(options));
	}
	return defaultFetch(url, options);
};

type InitializedEmbedder = {
	model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
	tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
};

export class FastembedAgentMemoryEmbedder implements AgentMemoryEmbedder {
	model = MODEL_ID;
	dimensions = DIMENSIONS;
	private initPromise: Promise<InitializedEmbedder> | null = null;

	embedQuery(text: string): Promise<Float32Array> {
		return this.getInit().then(async ({ model, tokenizer }) => {
			const inputs = await tokenizer(text, { padding: true, truncation: true });
			const { sentence_embedding: sentenceEmbedding } = await model(inputs);
			return Float32Array.from(sentenceEmbedding.normalize().data);
		});
	}

	embedPassage(text: string): Promise<Float32Array> {
		return this.embedQuery(text);
	}

	private getInit(): Promise<InitializedEmbedder> {
		if (!this.initPromise) {
			this.initPromise = Promise.all([
				AutoModel.from_pretrained(MODEL_ID, { dtype: 'q4' }),
				AutoTokenizer.from_pretrained(MODEL_ID),
			])
				.then(([model, tokenizer]) => ({ model, tokenizer }))
				.catch((err) => {
					this.initPromise = null;
					throw err;
				});
		}
		return this.initPromise;
	}
}
