import initialize, {
  loadDictionaryFromBytes,
  TokenizerBuilder,
  type Tokenizer,
} from "lindera-wasm";
import type { JapaneseSegmenter } from "./index";

export const linderaDictionaryFiles = [
  "metadata.json",
  "dict.trie",
  "dict.valsidx",
  "dict.vals",
  "dict.wordsidx",
  "dict.words",
  "matrix.mtx",
  "char_def.bin",
  "unk.bin",
] as const;

export interface LinderaAssets {
  wasm: Uint8Array;
  dictionary: Readonly<Record<(typeof linderaDictionaryFiles)[number], Uint8Array>>;
}

export interface LinderaSegmenters {
  normal: JapaneseSegmenter;
  decompose: JapaneseSegmenter;
  dispose(): void;
}

/** Owns one dictionary shared by both modes; callers own the asynchronous lifetime. */
export async function createLinderaSegmenters(assets: LinderaAssets): Promise<LinderaSegmenters> {
  await initialize({ module_or_path: assets.wasm });
  const data = assets.dictionary;
  const dictionary = loadDictionaryFromBytes(
    data["metadata.json"],
    data["dict.trie"],
    data["dict.valsidx"],
    data["dict.vals"],
    data["dict.wordsidx"],
    data["dict.words"],
    data["matrix.mtx"],
    data["char_def.bin"],
    data["unk.bin"],
  );
  const builder = new TokenizerBuilder();
  const tokenizers: Tokenizer[] = [];
  let dictionaryTransferred = false;
  let disposed = false;
  try {
    // Each setter returns another handle to the same builder. Release that handle,
    // and never free dictionary after setDictionaryInstance consumes its ownership.
    const handle = builder.setDictionaryInstance(dictionary);
    dictionaryTransferred = true;
    handle.free();
    const make = (mode: "normal" | "decompose"): JapaneseSegmenter => {
      builder.setMode(mode).free();
      const tokenizer = builder.build();
      tokenizers.push(tokenizer);
      return {
        id: `lindera-ipadic-6.0.0-${mode}`,
        segment(text) {
          if (disposed) throw new Error("Lindera segmenters have been disposed.");
          if (text.length === 0) return [];
          // The boundary provider passes a non-whitespace run. With all filters
          // disabled, surfaces reproduce it exactly; JS string lengths are UTF-16.
          const spans: { from: number; to: number }[] = [];
          let from = 0;
          for (const surface of tokenizer.tokenizeSurfaces(text)) {
            const to = from + surface.length;
            if (to === from || text.slice(from, to) !== surface)
              throw new Error("Lindera token surfaces do not preserve the original text.");
            spans.push({ from, to });
            from = to;
          }
          if (from !== text.length)
            throw new Error("Lindera token surfaces do not cover the original text.");
          return spans;
        },
      };
    };
    const normal = make("normal");
    const decompose = make("decompose");
    return {
      normal,
      decompose,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const tokenizer of tokenizers) tokenizer.free();
      },
    };
  } catch (error) {
    for (const tokenizer of tokenizers) tokenizer.free();
    throw error;
  } finally {
    builder.free();
    if (!dictionaryTransferred) dictionary.free();
  }
}
