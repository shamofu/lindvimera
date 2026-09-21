import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLinderaSegmenters,
  linderaDictionaryFiles,
  type LinderaAssets,
} from "../../src/word/lindera";

const runtime = vi.hoisted(() => ({
  initialize: vi.fn(),
  loadDictionary: vi.fn(),
  dictionaryFree: vi.fn(),
  builderFree: vi.fn(),
  handleFree: vi.fn(),
  tokenizerFrees: [] as ReturnType<typeof vi.fn>[],
  surfaces: ["今日", "は", "🍇", "。"],
  modes: [] as string[],
  failDecompose: false,
}));

vi.mock("lindera-wasm", () => ({
  default: runtime.initialize,
  loadDictionaryFromBytes: runtime.loadDictionary.mockImplementation(() => ({
    free: runtime.dictionaryFree,
  })),
  TokenizerBuilder: class {
    mode = "normal";
    setDictionaryInstance() {
      return { free: runtime.handleFree };
    }
    setMode(mode: string) {
      this.mode = mode;
      runtime.modes.push(mode);
      return { free: runtime.handleFree };
    }
    build() {
      if (runtime.failDecompose && this.mode === "decompose") throw new Error("build failed");
      const free = vi.fn();
      runtime.tokenizerFrees.push(free);
      return { tokenizeSurfaces: () => runtime.surfaces, free };
    }
    free = runtime.builderFree;
  },
}));

const bytes = new Uint8Array([0]);
const assets: LinderaAssets = {
  wasm: bytes,
  dictionary: Object.fromEntries(
    linderaDictionaryFiles.map((name, index) => [name, new Uint8Array([index + 1])]),
  ) as LinderaAssets["dictionary"],
};

beforeEach(() => {
  runtime.tokenizerFrees.length = 0;
  runtime.modes.length = 0;
  runtime.surfaces = ["今日", "は", "🍇", "。"];
  runtime.failDecompose = false;
});

describe("Lindera adapter", () => {
  it("preserves original UTF-16 offsets and initializes both modes once", async () => {
    const result = await createLinderaSegmenters(assets);
    expect(runtime.initialize).toHaveBeenCalledWith({ module_or_path: bytes });
    expect(linderaDictionaryFiles).toEqual([
      "metadata.json",
      "dict.trie",
      "dict.valsidx",
      "dict.vals",
      "matrix.mtx",
      "char_def.bin",
      "unk.bin",
    ]);
    expect(runtime.loadDictionary).toHaveBeenCalledTimes(1);
    expect(runtime.loadDictionary).toHaveBeenCalledWith(
      assets.dictionary["metadata.json"],
      assets.dictionary["dict.trie"],
      assets.dictionary["dict.valsidx"],
      assets.dictionary["dict.vals"],
      new Uint8Array(),
      new Uint8Array(),
      assets.dictionary["matrix.mtx"],
      assets.dictionary["char_def.bin"],
      assets.dictionary["unk.bin"],
    );
    expect(runtime.modes).toEqual(["normal", "decompose"]);
    expect(result.normal.segment("今日は🍇。")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 5 },
      { from: 5, to: 6 },
    ]);
    expect(result.normal.segment("")).toEqual([]);
    result.dispose();
  });

  it("rejects transformed or missing surfaces instead of producing shifted positions", async () => {
    const result = await createLinderaSegmenters(assets);
    runtime.surfaces = ["が"];
    expect(() => result.normal.segment("か\u3099")).toThrow("preserve");
    runtime.surfaces = ["今日"];
    expect(() => result.normal.segment("今日は")).toThrow("cover");
    result.dispose();
  });

  it("releases tokenizer ownership exactly once without freeing the consumed dictionary", async () => {
    const result = await createLinderaSegmenters(assets);
    expect(runtime.builderFree).toHaveBeenCalledTimes(1);
    expect(runtime.handleFree).toHaveBeenCalledTimes(3);
    expect(runtime.dictionaryFree).not.toHaveBeenCalled();
    result.dispose();
    result.dispose();
    for (const free of runtime.tokenizerFrees) expect(free).toHaveBeenCalledTimes(1);
    expect(() => result.normal.segment("今日")).toThrow("disposed");
  });

  it("releases the first tokenizer if building the second mode fails", async () => {
    runtime.failDecompose = true;
    await expect(createLinderaSegmenters(assets)).rejects.toThrow("build failed");
    expect(runtime.tokenizerFrees).toHaveLength(1);
    expect(runtime.tokenizerFrees[0]).toHaveBeenCalledTimes(1);
    expect(runtime.builderFree).toHaveBeenCalledTimes(1);
    expect(runtime.dictionaryFree).not.toHaveBeenCalled();
  });
});
