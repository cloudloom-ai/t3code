// Append-only mirror of the orchestration event log for training-data export.
// Each pass reads committed agent events after the last captured global
// sequence and appends one `OrchestrationV2StoredEventJson` line per event,
// partitioned per thread under the configured directory. Pull request links,
// checkpoints, model selection, and usage ride along as ordinary events. The
// cursor lives inside the capture directory, so a fresh directory backfills the
// full event history and a pass interrupted between append and cursor write can
// only duplicate lines, never drop them; readers dedupe by event id.
import { OrchestrationV2StoredEventJson } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EventStoreV2 from "../orchestration-v2/EventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";

const BATCH_EVENT_LIMIT = 500;
const PASS_INTERVAL = "5 seconds";
const CURSOR_VERSION = 1;

const TrainingCaptureCursor = Schema.Struct({
  version: Schema.Literal(CURSOR_VERSION),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const encodeCursorLine = Schema.encodeSync(Schema.fromJsonString(TrainingCaptureCursor));
const decodeCursorLine = Schema.decodeUnknownOption(Schema.fromJsonString(TrainingCaptureCursor));
const encodeStoredEventLine = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2StoredEventJson),
);

// Lossless filename mapping: characters outside the portable set are
// percent-encoded so distinct thread ids never share a capture file.
const threadFileStem = (threadId: string): string =>
  threadId.replace(/[^A-Za-z0-9._-]+/g, (chunk) => encodeURIComponent(chunk));

class TrainingCaptureError extends Schema.TaggedError<TrainingCaptureError>()(
  "TrainingCaptureError",
  {
    operation: Schema.Literals([
      "read-settings",
      "prepare-directory",
      "read-cursor",
      "read-events",
      "append-events",
      "write-cursor",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture training events during ${this.operation}.`;
  }
}

export class TrainingCaptureService extends Context.Service<
  TrainingCaptureService,
  {
    /** Starts the periodic capture loop; parked until server activation completes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Runs one capture pass over events committed since the cursor. */
    readonly synchronize: () => Effect.Effect<void, TrainingCaptureError>;
  }
>()("t3/trainingCapture/TrainingCaptureService") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const eventStore = yield* EventStoreV2.EventStoreV2;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const appendThreadLines = (filePath: string, contents: string) =>
    fs
      .writeFileString(filePath, contents, { flag: "a" })
      .pipe(
        Effect.mapError((cause) => new TrainingCaptureError({ operation: "append-events", cause })),
      );

  const readCursor = Effect.fn("TrainingCaptureService.readCursor")(function* (filePath: string) {
    const contents = yield* fs.readFileString(filePath).pipe(
      Effect.mapError((cause) => new TrainingCaptureError({ operation: "read-cursor", cause })),
      Effect.option,
    );
    if (Option.isNone(contents)) return 0;
    // A corrupt cursor re-captures from the start rather than skipping events.
    return Option.getOrUndefined(decodeCursorLine(contents.value))?.sequence ?? 0;
  });

  const writeCursor = (filePath: string, sequence: number) =>
    writeFileStringAtomically({
      filePath,
      contents: `${encodeCursorLine({ version: CURSOR_VERSION, sequence })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new TrainingCaptureError({ operation: "write-cursor", cause })),
    );

  const synchronize = Effect.fn("TrainingCaptureService.synchronize")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new TrainingCaptureError({ operation: "read-settings", cause })),
    );
    if (!settings.trainingCapture.enabled) return;

    const captureDirectory =
      settings.trainingCapture.directory === ""
        ? path.join(stateDir, "training-capture")
        : settings.trainingCapture.directory;
    const cursorPath = path.join(captureDirectory, "cursor.json");
    const threadsDirectory = path.join(captureDirectory, "threads");
    yield* fs
      .makeDirectory(threadsDirectory, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new TrainingCaptureError({ operation: "prepare-directory", cause }),
        ),
      );

    let sequence = yield* readCursor(cursorPath);
    for (;;) {
      const batch = yield* Stream.runCollect(
        eventStore.read({ afterSequence: sequence, limit: BATCH_EVENT_LIMIT }),
      ).pipe(
        Effect.mapError((cause) => new TrainingCaptureError({ operation: "read-events", cause })),
      );
      if (batch.length === 0) break;

      const linesByThread = new Map<string, Array<string>>();
      for (const stored of batch) {
        const lines = linesByThread.get(stored.event.threadId) ?? [];
        lines.push(encodeStoredEventLine(stored));
        linesByThread.set(stored.event.threadId, lines);
      }
      yield* Effect.forEach(
        linesByThread.entries(),
        ([threadId, lines]) =>
          appendThreadLines(
            path.join(threadsDirectory, `${threadFileStem(threadId)}.ndjson`),
            `${lines.join("\n")}\n`,
          ),
        { discard: true },
      );

      sequence = batch[batch.length - 1]!.sequence;
      yield* writeCursor(cursorPath, sequence);
      if (batch.length < BATCH_EVENT_LIMIT) break;
    }
  });

  const start: TrainingCaptureService["Service"]["start"] = Effect.fn(
    "TrainingCaptureService.start",
  )(function* () {
    yield* forkParked(
      synchronize().pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("training capture pass failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(PASS_INTERVAL)),
      ),
    );
  });

  return { start, synchronize } satisfies TrainingCaptureService["Service"];
});
