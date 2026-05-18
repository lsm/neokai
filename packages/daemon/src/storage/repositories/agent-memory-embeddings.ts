import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import type { AgentMemoryEmbedder } from './agent-memory-repository';

const MODEL = EmbeddingModel.BGESmallEN;
const DIMENSIONS = 384;

export class FastembedAgentMemoryEmbedder implements AgentMemoryEmbedder {
	model = MODEL;
	dimensions = DIMENSIONS;
	private embeddingPromise: Promise<FlagEmbedding> | null = null;

	embedQuery(text: string): Promise<Float32Array> {
		return this.getEmbedding().then(async (embedding) =>
			Float32Array.from(await embedding.queryEmbed(text))
		);
	}

	async embedPassage(text: string): Promise<Float32Array> {
		const embedding = await this.getEmbedding();
		const batches = embedding.passageEmbed([text], 1);
		const batch = await batches.next();
		return Float32Array.from(batch.value?.[0] ?? []);
	}

	private getEmbedding(): Promise<FlagEmbedding> {
		if (!this.embeddingPromise) {
			this.embeddingPromise = FlagEmbedding.init({
				model: MODEL,
				showDownloadProgress: false,
			}).catch((error: unknown) => {
				this.embeddingPromise = null;
				throw error;
			});
		}
		return this.embeddingPromise;
	}
}
