import type { EngineController, EngineStatus } from "./controller";
import type { EngineId } from "./selection";

/** Shared diagnostics contain no concrete engine implementation or state. */
export interface RuntimeFacade {
  readonly version: 2;
  readonly engine: {
    requested: EngineId;
    active: EngineId;
    available: readonly EngineId[];
    status: EngineStatus;
  };
  readonly backend: object | undefined;
}

export function createRuntimeFacade(
  controller: EngineController,
  requested: () => EngineId,
  available: readonly EngineId[],
): RuntimeFacade {
  return Object.freeze({
    version: 2 as const,
    get engine() {
      return {
        requested: requested(),
        active: controller.id,
        available: [...available],
        status: controller.status,
      };
    },
    get backend() {
      return controller.runtime;
    },
  });
}
