/**
 * Error raised when an embedding model cannot write to Concord's fixed-width
 * sqlite-vec indexes. Kept separate from the LLM transport errors so routes
 * can distinguish an incompatible model from an offline provider.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly model: string,
    public readonly actualDimensions: number,
    public readonly expectedDimensions: number,
  ) {
    super(
      `Embedding model "${model}" returns ${actualDimensions}-dimensional vectors, `
      + `but Concord's vector index requires ${expectedDimensions}. `
      + `Choose a ${expectedDimensions}-dimensional embedding model before indexing; `
      + "transcript and document embeddings searched together must use the same model and vector space.",
    );
    this.name = "EmbeddingDimensionMismatchError";
  }
}

/** Fail before a vector reaches sqlite-vec (and before any existing rows are
 * replaced). All vectors in a provider response are checked because a mixed
 * response would otherwise fail part-way through a database transaction. */
export function assertEmbeddingVectorDimensions(
  vectors: readonly Float32Array[],
  model: string,
  expectedDimensions: number,
): void {
  for (const vector of vectors) {
    if (vector.length !== expectedDimensions) {
      throw new EmbeddingDimensionMismatchError(
        model,
        vector.length,
        expectedDimensions,
      );
    }
  }
}
