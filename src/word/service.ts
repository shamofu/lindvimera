import { budouxSegmenter, type JapaneseSegmenter } from "./index";
import {
  createLinderaSegmenters,
  linderaDictionaryFiles,
  type LinderaAssets,
  type LinderaSegmenters,
} from "./lindera";

export type LinderaMode = "normal" | "decompose";

/** One asynchronous dictionary lifetime per plugin, shared by all editors/cells. */
export class JapaneseWordService {
  private loading?: Promise<void>;
  private engines?: LinderaSegmenters;
  private guarded?: Record<LinderaMode, JapaneseSegmenter>;
  private disposed = false;
  private failed = false;

  constructor(
    private readonly read: (path: string) => Promise<ArrayBuffer>,
    private readonly changed: () => void,
    private readonly notifyFailure: (error: unknown) => void,
  ) {}

  segmenter(mode: LinderaMode): JapaneseSegmenter {
    return this.guarded?.[mode] ?? budouxSegmenter;
  }

  load(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return (this.loading ??= this.initialize());
  }

  private fail(error: unknown): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.guarded = undefined;
    this.notifyFailure(error);
    this.changed();
  }

  private async initialize(): Promise<void> {
    try {
      const [wasm, ...buffers] = await Promise.all(
        [
          "lindera/lindera_wasm_bg.wasm",
          ...linderaDictionaryFiles.map((name) => `lindera/ipadic/${name}`),
        ].map(async (path) => new Uint8Array(await this.read(path))),
      );
      if (this.disposed) return;
      const dictionary = Object.fromEntries(
        linderaDictionaryFiles.map((name, i) => [name, buffers[i]]),
      ) as LinderaAssets["dictionary"];
      const engines = await createLinderaSegmenters({ wasm, dictionary });
      if (this.disposed) {
        engines.dispose();
        return;
      }
      this.engines = engines;
      const wrap = (mode: LinderaMode): JapaneseSegmenter => ({
        id: engines[mode].id,
        segment: (text) => {
          if (this.failed || this.disposed) return budouxSegmenter.segment(text);
          try {
            return engines[mode].segment(text);
          } catch (error) {
            this.fail(error);
            return budouxSegmenter.segment(text);
          }
        },
      });
      this.guarded = { normal: wrap("normal"), decompose: wrap("decompose") };
      this.changed();
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.guarded = undefined;
    this.engines?.dispose();
    this.engines = undefined;
  }
}
