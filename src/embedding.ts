import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";

export type LocalEmbeddingProvider = {
  id: "local";
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export const DEFAULT_GH_INTEL_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

function normalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

export async function createLocalEmbeddingProvider(
  modelPath = DEFAULT_GH_INTEL_LOCAL_MODEL,
): Promise<LocalEmbeddingProvider> {
  const { getLlama, resolveModelFile, LlamaLogLevel } = await import("node-llama-cpp");

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;
  let initPromise: Promise<LlamaEmbeddingContext> | null = null;

  const ensureContext = async (): Promise<LlamaEmbeddingContext> => {
    if (embeddingContext) {
      return embeddingContext;
    }
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      try {
        if (!llama) {
          llama = await getLlama({ logLevel: LlamaLogLevel.error });
        }
        if (!embeddingModel) {
          const resolved = await resolveModelFile(modelPath);
          embeddingModel = await llama.loadModel({ modelPath: resolved });
        }
        if (!embeddingContext) {
          embeddingContext = await embeddingModel.createEmbeddingContext();
        }
        return embeddingContext;
      } catch (error) {
        initPromise = null;
        throw error;
      }
    })();
    return initPromise;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text: string) => {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      return normalizeEmbedding(Array.from(embedding.vector));
    },
    embedBatch: async (texts: string[]) => {
      const ctx = await ensureContext();
      const embeddings = await Promise.all(
        texts.map(async (text) => {
          const embedding = await ctx.getEmbeddingFor(text);
          return normalizeEmbedding(Array.from(embedding.vector));
        }),
      );
      return embeddings;
    },
  };
}
