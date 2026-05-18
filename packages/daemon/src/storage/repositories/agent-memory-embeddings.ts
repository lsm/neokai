import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { AgentMemoryEmbedder } from './agent-memory-repository';

const MODEL = 'BAAI/bge-small-en-v1.5';
const DIMENSIONS = 384;

export class FastembedAgentMemoryEmbedder implements AgentMemoryEmbedder {
	model = MODEL;
	dimensions = DIMENSIONS;
	private pipePromise: Promise<FeatureExtractionPipeline> | null = null;

	embedQuery(text: string): Promise<Float32Array> {
		return this.getPipeline().then(async (pipe) => {
			const output = await pipe(text, { pooling: 'mean', normalize: true });
			return Float32Array.from(output.data);
		});
	}

	embedPassage(text: string): Promise<Float32Array> {
		return this.embedQuery(text);
	}

	private getPipeline(): Promise<FeatureExtractionPipeline> {
		if (!this.pipePromise) {
			this.pipePromise = pipeline('feature-extraction', MODEL).catch((err) => {
				this.pipePromise = null;
				throw err;
			});
		}
		return this.pipePromise;
	}
}
