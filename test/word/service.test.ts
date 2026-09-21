import { beforeEach, expect, it, vi } from "vitest";
import { budouxSegmenter } from "../../src/word";
import { JapaneseWordService } from "../../src/word/service";

const runtime = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../src/word/lindera", () => ({
  createLinderaSegmenters: runtime.create,
  linderaDictionaryFiles: ["metadata.json", "dict.trie"],
}));
beforeEach(() => {
  runtime.create.mockReset();
});

function setup() {
  const read = vi
    .fn<(path: string) => Promise<ArrayBuffer>>()
    .mockResolvedValue(new ArrayBuffer(1));
  const changed = vi.fn();
  const notify = vi.fn();
  const normal = { id: "normal", segment: vi.fn(() => [{ from: 0, to: 2 }]) };
  const decompose = {
    id: "decompose",
    segment: vi.fn(() => [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ]),
  };
  const dispose = vi.fn();
  runtime.create.mockResolvedValue({ normal, decompose, dispose });
  return {
    service: new JapaneseWordService(read, changed, notify),
    read,
    changed,
    notify,
    normal,
    decompose,
    dispose,
  };
}

it("uses BudouX during loading, shares one dictionary and exposes both modes after loading", async () => {
  const { service, read, changed } = setup();
  expect(service.segmenter("normal")).toBe(budouxSegmenter);
  await Promise.all([service.load(), service.load()]);
  expect(runtime.create).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.map(([path]) => path)).toEqual([
    "lindera/lindera_wasm_bg.wasm",
    "lindera/ipadic/metadata.json",
    "lindera/ipadic/dict.trie",
  ]);
  expect(service.segmenter("normal").segment("東京")).toEqual([{ from: 0, to: 2 }]);
  expect(service.segmenter("decompose").segment("東京")).toHaveLength(2);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("falls back and notifies only once if local asset loading fails", async () => {
  const { service, read, notify } = setup();
  read.mockRejectedValue(new Error("missing dictionary"));
  await service.load();
  await service.load();
  expect(service.segmenter("normal")).toBe(budouxSegmenter);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(runtime.create).not.toHaveBeenCalled();
});

it("keeps the current command usable and invalidates subsequent caches after an analysis failure", async () => {
  const { service, normal, changed, notify } = setup();
  await service.load();
  const captured = service.segmenter("normal");
  normal.segment.mockImplementation(() => {
    throw new Error("bad offsets");
  });
  expect(captured.segment("東京")).toEqual(budouxSegmenter.segment("東京"));
  expect(captured.segment("東京")).toEqual(budouxSegmenter.segment("東京"));
  expect(service.segmenter("decompose")).toBe(budouxSegmenter);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("releases a late initialization after unloading without refreshing editors", async () => {
  const { service, changed, notify, dispose, normal, decompose } = setup();
  let finish!: (value: unknown) => void;
  runtime.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = service.load();
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
  service.dispose();
  finish({ normal, decompose, dispose });
  await loading;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(service.segmenter("normal")).toBe(budouxSegmenter);
});

it("does not begin asset reads after an unused service has been unloaded", async () => {
  const { service, read, changed, notify } = setup();
  service.dispose();
  await service.load();
  expect(read).not.toHaveBeenCalled();
  expect(runtime.create).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("does not construct WASM when asset reading completes after unloading", async () => {
  const { service, read, changed, notify } = setup();
  let finish!: (bytes: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    finish = resolve;
  });
  read.mockReturnValue(bytes);
  const loading = service.load();
  service.dispose();
  finish(new ArrayBuffer(1));
  await loading;
  expect(runtime.create).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("disposes the initialized runtime once and keeps captured wrappers away from freed tokenizers", async () => {
  const { service, normal, dispose, changed, notify } = setup();
  await service.load();
  const captured = service.segmenter("normal");
  service.dispose();
  service.dispose();
  await service.load();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(captured.segment("東京")).toEqual(budouxSegmenter.segment("東京"));
  expect(normal.segment).not.toHaveBeenCalled();
  expect(service.segmenter("decompose")).toBe(budouxSegmenter);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
});
