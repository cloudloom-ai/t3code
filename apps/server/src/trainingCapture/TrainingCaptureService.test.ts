import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  OrchestrationV2StoredEventJson,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventStoreV2 from "../orchestration-v2/EventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TrainingCaptureService from "./TrainingCaptureService.ts";

const NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0);

const at = (offsetSeconds: number): DateTime.Utc =>
  DateTime.makeUnsafe(NOW_MS + offsetSeconds * 1_000);

const sessionEvent = (
  suffix: string,
  threadId: string,
  offsetSeconds: number,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${suffix}`),
  type: "provider-session.updated",
  threadId: ThreadId.make(threadId),
  occurredAt: at(offsetSeconds),
  payload: {
    id: ProviderSessionId.make(`session-${suffix}`),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    status: "running",
    cwd: "/repo",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: at(offsetSeconds),
    updatedAt: at(offsetSeconds),
    lastError: null,
  },
});

const storedEvent = (
  sequence: number,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event,
});

const eventStoreLayer = (events: Array<OrchestrationV2StoredEvent>) =>
  Layer.succeed(
    EventStoreV2.EventStoreV2,
    EventStoreV2.EventStoreV2.of({
      read: (input) =>
        Stream.fromIterable(
          events
            .filter((stored) => stored.sequence > (input?.afterSequence ?? 0))
            .slice(0, input?.limit ?? events.length),
        ),
      append: () => Effect.die("not implemented"),
      appendProjectEvent: () => Effect.die("not implemented"),
      readByCommandId: () => Stream.empty,
      latestSequence: () => Effect.succeed(events.at(-1)?.sequence ?? 0),
      latestApplicationSequence: Effect.succeed(0),
      publishCommitted: () => Effect.void,
    }),
  );

const makeServiceLayer = (options: {
  readonly events: Array<OrchestrationV2StoredEvent>;
  readonly trainingCapture: { readonly enabled: boolean; readonly directory: string };
}) =>
  Layer.effect(TrainingCaptureService.TrainingCaptureService, TrainingCaptureService.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        eventStoreLayer(options.events),
        ServerSettings.ServerSettingsService.layerTest({
          trainingCapture: options.trainingCapture,
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "training-capture-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

const synchronizeOnce = (options: Parameters<typeof makeServiceLayer>[0]) =>
  Effect.gen(function* () {
    const service = yield* TrainingCaptureService.TrainingCaptureService;
    yield* service.synchronize();
  }).pipe(Effect.provide(makeServiceLayer(options)));

const decodeStoredEventLine = Schema.decodeSync(
  Schema.fromJsonString(OrchestrationV2StoredEventJson),
);

const readCaptureLines = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(filePath);
    return contents
      .trim()
      .split("\n")
      .map((line) => decodeStoredEventLine(line));
  });

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const readCursor = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cursor = yield* decodeUnknownJson(yield* fs.readFileString(filePath));
    return (cursor as { sequence: number }).sequence;
  });

const withTempCaptureDir =
  <A, E, R>(test: (captureDir: string, path: Path.Path) => Effect.Effect<A, E, R>) =>
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const captureDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-training-capture-",
        });
        return yield* test(captureDir, path);
      }),
    ).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "skips writing when capture is disabled",
  withTempCaptureDir((captureDir, path) =>
    Effect.gen(function* () {
      const events = [storedEvent(1, sessionEvent("a", "thread:one", 0))];
      yield* synchronizeOnce({
        events,
        trainingCapture: { enabled: false, directory: captureDir },
      });

      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(path.join(captureDir, "cursor.json")));
    }),
  ),
);

it.effect(
  "appends events per thread and records the cursor",
  withTempCaptureDir((captureDir, path) =>
    Effect.gen(function* () {
      const events = [
        storedEvent(1, sessionEvent("a", "thread:one", 0)),
        storedEvent(2, sessionEvent("b", "thread:two", 1)),
        storedEvent(3, sessionEvent("c", "thread:one", 2)),
      ];
      yield* synchronizeOnce({
        events,
        trainingCapture: { enabled: true, directory: captureDir },
      });

      const one = yield* readCaptureLines(path.join(captureDir, "threads", "thread%3Aone.ndjson"));
      assert.deepEqual(
        one.map((stored) => [stored.sequence, stored.event.threadId]),
        [
          [1, "thread:one"],
          [3, "thread:one"],
        ],
      );
      const two = yield* readCaptureLines(path.join(captureDir, "threads", "thread%3Atwo.ndjson"));
      assert.deepEqual(
        two.map((stored) => stored.sequence),
        [2],
      );

      assert.equal(yield* readCursor(path.join(captureDir, "cursor.json")), 3);
    }),
  ),
);

it.effect(
  "resumes from the cursor without duplicating lines",
  withTempCaptureDir((captureDir, path) =>
    Effect.gen(function* () {
      const events = [
        storedEvent(1, sessionEvent("a", "thread:one", 0)),
        storedEvent(2, sessionEvent("b", "thread:one", 1)),
      ];
      yield* synchronizeOnce({
        events,
        trainingCapture: { enabled: true, directory: captureDir },
      });

      events.push(storedEvent(3, sessionEvent("c", "thread:one", 2)));
      yield* synchronizeOnce({
        events,
        trainingCapture: { enabled: true, directory: captureDir },
      });

      const lines = yield* readCaptureLines(
        path.join(captureDir, "threads", "thread%3Aone.ndjson"),
      );
      assert.deepEqual(
        lines.map((stored) => stored.sequence),
        [1, 2, 3],
      );
      assert.equal(yield* readCursor(path.join(captureDir, "cursor.json")), 3);
    }),
  ),
);

it.effect(
  "captures across batch boundaries",
  withTempCaptureDir((captureDir, path) =>
    Effect.gen(function* () {
      const events = Array.from({ length: 1_001 }, (_, index) =>
        storedEvent(index + 1, sessionEvent(`a-${index}`, "thread:one", index)),
      );
      yield* synchronizeOnce({
        events,
        trainingCapture: { enabled: true, directory: captureDir },
      });

      const lines = yield* readCaptureLines(
        path.join(captureDir, "threads", "thread%3Aone.ndjson"),
      );
      assert.lengthOf(lines, 1_001);
      assert.equal(lines[0]!.sequence, 1);
      assert.equal(lines[1_000]!.sequence, 1_001);
      assert.equal(yield* readCursor(path.join(captureDir, "cursor.json")), 1_001);
    }),
  ),
);

it.effect("an empty directory setting captures under the T3 state directory", () => {
  const events = [storedEvent(1, sessionEvent("a", "thread:one", 0))];
  // One shared config layer instance: the service and the assertion must see
  // the same stateDir, which two layer builds would not guarantee.
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "training-capture-default-",
  }).pipe(Layer.provideMerge(NodeServices.layer));
  const serviceLayer = Layer.effect(
    TrainingCaptureService.TrainingCaptureService,
    TrainingCaptureService.make,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        eventStoreLayer(events),
        ServerSettings.ServerSettingsService.layerTest({
          trainingCapture: { enabled: true, directory: "" },
        }),
        configLayer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* TrainingCaptureService.TrainingCaptureService;
    yield* service.synchronize();

    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    assert.equal(yield* readCursor(path.join(stateDir, "training-capture", "cursor.json")), 1);
  }).pipe(Effect.provide(Layer.mergeAll(serviceLayer, configLayer, NodeServices.layer)));
});
