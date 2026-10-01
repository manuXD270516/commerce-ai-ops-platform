import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EMBEDDING_DIM, hashEmbedder, normalize, type Embedder } from '@commerce/domain';

export interface LocalModelSpec {
  /** Stored with every chunk; changing it requires re-ingesting the corpus. */
  readonly id: string;
  readonly repo: string;
  /** Pinned Hugging Face commit so the downloaded weights cannot change under the same id. */
  readonly revision: string;
  readonly license: string;
  readonly dimension: number;
  readonly queryPrefix: string;
  readonly passagePrefix: string;
}

/** Candidates evaluated in the M4 spike; all run locally on CPU through ONNX Runtime. */
export const LOCAL_EMBEDDING_MODELS = {
  'multilingual-e5-small': {
    id: 'multilingual-e5-small@761b726-q8',
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    license: 'MIT (intfloat/multilingual-e5-small)',
    dimension: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  'paraphrase-multilingual-minilm': {
    id: 'paraphrase-multilingual-MiniLM-L12-v2@2c4055b-q8',
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
    license: 'Apache-2.0 (sentence-transformers)',
    dimension: 384,
    queryPrefix: '',
    passagePrefix: '',
  },
  'all-minilm-l6': {
    id: 'all-MiniLM-L6-v2@751bff3-q8',
    repo: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    license: 'Apache-2.0',
    dimension: 384,
    queryPrefix: '',
    passagePrefix: '',
  },
} as const satisfies Record<string, LocalModelSpec>;

export type LocalModelName = keyof typeof LOCAL_EMBEDDING_MODELS;

export const DEFAULT_LOCAL_MODEL: LocalModelName = 'multilingual-e5-small';

export const EMBEDDINGS_PROVIDERS = ['hash', 'local-onnx'] as const;
export type EmbeddingsProvider = (typeof EMBEDDINGS_PROVIDERS)[number];

/**
 * Embedder selected by configuration. The default is the deterministic local hash embedder fixed
 * by the M4 spike (add-hybrid-retrieval design.md): no download, no network, no cost. The ONNX
 * models are opt-in (EMBEDDINGS_PROVIDER=local-onnx) and only download their pinned weights when
 * EMBEDDINGS_ALLOW_DOWNLOAD=true. Switching model requires re-ingesting the corpus, because chunks
 * are filtered by embedding_model.
 */
export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  const provider = env.EMBEDDINGS_PROVIDER ?? 'hash';
  if (provider === 'hash') return hashEmbedder();
  if (provider === 'local-onnx') {
    const model = env.EMBEDDINGS_MODEL ?? DEFAULT_LOCAL_MODEL;
    if (!(model in LOCAL_EMBEDDING_MODELS)) {
      throw new Error(`Unknown EMBEDDINGS_MODEL ${model}`);
    }
    return createLocalEmbedder({
      model: model as LocalModelName,
      allowDownload: env.EMBEDDINGS_ALLOW_DOWNLOAD === 'true',
    });
  }
  throw new Error(`EMBEDDINGS_PROVIDER must be one of ${EMBEDDINGS_PROVIDERS.join(', ')}`);
}

export interface LocalEmbedderOptions {
  readonly model?: LocalModelName;
  /** Where weights are cached; defaults to EMBEDDINGS_CACHE_DIR or .local/models. */
  readonly cacheDir?: string;
  /** false forbids network access, so a missing model fails instead of downloading. */
  readonly allowDownload?: boolean;
}

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * Optional open-source embedding model run in-process (off by default, see createEmbedder). No
 * text leaves the machine; the only network call would be the first download of the pinned
 * weights from Hugging Face, and it is refused unless allowDownload is true.
 */
export function createLocalEmbedder(options: LocalEmbedderOptions = {}): Embedder {
  const spec: LocalModelSpec = LOCAL_EMBEDDING_MODELS[options.model ?? DEFAULT_LOCAL_MODEL];
  if (spec.dimension !== EMBEDDING_DIM) {
    throw new Error(
      `${spec.id} has dimension ${String(spec.dimension)}, expected ${String(EMBEDDING_DIM)}`,
    );
  }
  let extractor: Promise<Extractor> | undefined;
  const load = () => {
    extractor ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.cacheDir =
        options.cacheDir ??
        process.env.EMBEDDINGS_CACHE_DIR ??
        join(workspaceRoot(), '.local/models');
      env.allowRemoteModels = options.allowDownload ?? false;
      env.allowLocalModels = false;
      const pipe: unknown = await pipeline('feature-extraction', spec.repo, {
        revision: spec.revision,
        dtype: 'q8',
      });
      return pipe as Extractor;
    })();
    return extractor;
  };
  const embed = async (texts: readonly string[], prefix: string) => {
    const run = await load();
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => `${prefix}${t}`);
      const output = await run(batch, { pooling: 'mean', normalize: true });
      vectors.push(...output.tolist().map((v) => normalize(v)));
    }
    return vectors;
  };
  return {
    model: spec.id,
    dimension: spec.dimension,
    embedDocuments: (texts) => embed(texts, spec.passagePrefix),
    embedQuery: async (text) => (await embed([text], spec.queryPrefix))[0] ?? [],
  };
}

function workspaceRoot(): string {
  let dir = resolve('.');
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve('.');
    dir = parent;
  }
  return dir;
}
