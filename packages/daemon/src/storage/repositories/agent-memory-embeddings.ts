import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import type { AgentMemoryEmbedder } from './agent-memory-repository';

const MODEL = EmbeddingModel.BGESmallEN;
const DIMENSIONS = 384;

export class FastembedAgentMemoryEmbedder implements AgentMemoryEmbedder {
	model = MODEL;
	dimensions = DIMENSIONS;
	private embeddingPromise: Promise<FlagEmbedding> | null = null;

	embed(text: string): Promise<Float32Array> {
		return this.getEmbedding().then(async (embedding) =>
			Float32Array.from(await embedding.queryEmbed(text))
		);
	}

	private getEmbedding(): Promise<FlagEmbedding> {
		this.embeddingPromise ??= FlagEmbedding.init({
			model: MODEL,
			showDownloadProgress: false,
		});
		return this.embeddingPromise;
	}
}
