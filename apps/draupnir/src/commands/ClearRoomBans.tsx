// SPDX-FileCopyrightText: 2025 Your Name <your@email.com>
//
// SPDX-License-Identifier: AFL-3.0

import {
  ActionError,
  ActionResult,
  Logger,
  Membership,
  Ok,
  PowerLevelPermission,
  PowerLevelsMirror,
  RoomEvent,
  Task,
  isError,
} from "matrix-protection-suite";
import {
  MatrixRoomID,
  MatrixRoomReference,
  StringEventID,
  StringRoomAlias,
  StringRoomID,
  StringUserID,
  isStringRoomAlias,
} from "@the-draupnir-project/matrix-basic-types";
import {
  DeadDocumentJSX,
  MatrixRoomReferencePresentationSchema,
  StringPresentationType,
  describeCommand,
  tuple,
  union,
} from "@the-draupnir-project/interface-manager";
import { Draupnir } from "../Draupnir";
import { DraupnirInterfaceAdaptor } from "./DraupnirCommandPrerequisites";
import {
  renderRoomPill,
  sendMatrixEventsFromDeadDocument,
} from "@the-draupnir-project/mps-interface-adaptor";

const log = new Logger("ClearRoomBans");

const CLEAR_BANS_PROMPT_LISTENER =
  "ge.applied-langua.ge.draupnir.clear_room_bans";

// ─── Internal types ───────────────────────────────────────────────────────────

/** Pre-computed snapshot of a single room's ban list. */
interface RoomBanInfo {
  room: MatrixRoomID;
  /** Canonical alias for display, if set in room state. */
  alias: StringRoomAlias | undefined;
  bannedUserIDs: StringUserID[];
}

/**
 * Stored inside the Matrix event annotation. Contains the full snapshot so the
 * reaction listener can execute without re-querying the server.
 */
interface ClearBansAnnotationContext extends Record<string, unknown> {
  rooms: Array<{ roomID: StringRoomID; userIDs: StringUserID[] }>;
}

// ─── Lazy reaction listener registration ─────────────────────────────────────

/**
 * Tracks which Draupnir instances already have the clear-bans reaction listener
 * registered, preventing duplicate registrations across command invocations.
 */
const registeredInstances = new WeakSet<Draupnir>();

function ensureListenerRegistered(draupnir: Draupnir): void {
  if (registeredInstances.has(draupnir)) {
    return;
  }
  registeredInstances.add(draupnir);

  draupnir.reactionHandler.on(
    CLEAR_BANS_PROMPT_LISTENER,
    (
      _key: string,
      item: string,
      context: ClearBansAnnotationContext,
      _reactionMap: Map<string, string>,
      annotatedEvent: RoomEvent
    ) => {
      void Task(onClearBansReaction(draupnir, item, context, annotatedEvent));
    }
  );
}

async function onClearBansReaction(
  draupnir: Draupnir,
  item: string,
  context: ClearBansAnnotationContext,
  annotatedEvent: RoomEvent
): Promise<void> {
  if (item === "confirm") {
    const unbanner = draupnir.clientPlatform.toRoomUnbanner();
    let totalQueued = 0;

    for (const { roomID, userIDs } of context.rooms) {
      for (const userID of userIDs) {
        draupnir.taskQueue.push(async () => {
          return await unbanner.unbanUser(roomID, userID);
        });
        totalQueued++;
      }
    }

    log.info(
      `Queued ${totalQueued} unban(s) across ${context.rooms.length} room(s).`
    );

    // ── Send success message ───────────────────────────────────────────
    void Task(
      sendMatrixEventsFromDeadDocument(
        draupnir.clientPlatform.toRoomMessageSender(),
        draupnir.managementRoomID,
        <root>
          ✅ Removing {totalQueued} ban{totalQueued !== 1 ? "s" : ""} across{" "}
          {context.rooms.length} room{context.rooms.length !== 1 ? "s" : ""}.
        </root>,
        {}
      )
    );
  } else if (item === "cancel") {
    void Task(
      sendMatrixEventsFromDeadDocument(
        draupnir.clientPlatform.toRoomMessageSender(),
        draupnir.managementRoomID,
        <root>❌ Clear bans cancelled.</root>,
        {}
      )
    );
  }

  // Always clean up the reaction buttons regardless of which reaction was used.
  const completeResult = await draupnir.reactionHandler.completePrompt(
    annotatedEvent.room_id,
    annotatedEvent.event_id
  );
  if (isError(completeResult)) {
    log.error(
      `Failed to clean up clear-bans prompt ${annotatedEvent.event_id}`,
      completeResult.error
    );
  }
}

// ─── Room inspection helper ───────────────────────────────────────────────────

/**
 * Inspects a room and returns its ban list.
 *
 * Returns `null` (not an error) when the bot lacks permission to unban in the
 * room, allowing the caller to silently skip it while still reporting it.
 */
async function inspectRoom(
  draupnir: Draupnir,
  room: MatrixRoomID
): Promise<ActionResult<RoomBanInfo | null>> {
  const stateResult =
    await draupnir.roomStateManager.getRoomStateRevisionIssuer(room);
  if (isError(stateResult)) {
    return stateResult;
  }

  const revision = stateResult.ok.currentRevision;

  // Power-level check
  const powerLevelsContent = revision.getStateEvent(
    "m.room.power_levels",
    ""
  )?.content;

  if (
    !PowerLevelsMirror.isUserAbleToUse(
      draupnir.clientUserID,
      PowerLevelPermission.Ban,
      powerLevelsContent
    )
  ) {
    return Ok(null); // no permission — caller skips this room
  }

  // Canonical alias for nicer display
  const rawAlias = (
    revision.getStateEvent("m.room.canonical_alias", "")?.content as
      | { alias?: string }
      | undefined
  )?.alias;
  const alias =
    rawAlias !== undefined && isStringRoomAlias(rawAlias)
      ? rawAlias
      : undefined;

  // Ban list from tracked membership
  const membershipRevision =
    draupnir.protectedRoomsSet.setRoomMembership.getRevision(
      room.toRoomIDOrAlias()
    );
  if (membershipRevision === undefined) {
    return ActionError.Result(
      `Membership data unavailable for ${room.toRoomIDOrAlias()}`
    );
  }

  const bannedUserIDs = [
    ...membershipRevision.membersOfMembership(Membership.Ban),
  ].map((m) => m.userID);

  return Ok({ room, alias, bannedUserIDs });
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const DraupnirClearRoomBansCommand = describeCommand({
  summary:
    "Preview and remove all room-level bans from a room or all protected rooms. " +
    "Sends a per-room ban count to the management room and requires " +
    "confirmation via a reaction before executing. " +
    'Usage: !rooms clear-bans <room>  |  !rooms clear-bans "everything"',
  parameters: tuple({
    name: "room",
    acceptor: union(
      MatrixRoomReferencePresentationSchema,
      StringPresentationType
    ),
    description:
      'A room reference or room ID, or the literal string "everything" ' +
      "to process all protected rooms at once.",
  }),
  async executor(
    draupnir: Draupnir,
    _info,
    _keywords,
    _rest,
    roomOrAll: MatrixRoomReference | string
  ): Promise<ActionResult<void>> {
    ensureListenerRegistered(draupnir);

    // 1. Determine which rooms to process.
    let targetRooms: MatrixRoomID[];

    if (typeof roomOrAll === "string") {
      if (roomOrAll.toLowerCase() !== "everything") {
        return ActionError.Result(
          `Unknown argument "${roomOrAll}". ` +
            'Provide a room reference or the literal string "everything".'
        );
      }
      targetRooms = draupnir.protectedRoomsSet.allProtectedRooms;
    } else {
      const resolvedResult = await draupnir.clientPlatform
        .toRoomResolver()
        .resolveRoom(roomOrAll);
      if (isError(resolvedResult)) {
        return resolvedResult;
      }
      targetRooms = [resolvedResult.ok];
    }

    // 2. Inspect each room: collect ban snapshots and note permission problems.
    const actionable: RoomBanInfo[] = [];
    const noPermission: MatrixRoomID[] = [];

    for (const room of targetRooms) {
      const result = await inspectRoom(draupnir, room);
      if (isError(result)) {
        log.error(
          `Failed to inspect ${room.toRoomIDOrAlias()}: ` + result.error.message
        );
        noPermission.push(room); // treat inspection failures same as no permission
        continue;
      }
      if (result.ok === null) {
        noPermission.push(room);
        continue;
      }
      if (result.ok.bannedUserIDs.length > 0) {
        actionable.push(result.ok);
      }
      // Rooms with 0 bans are silently omitted — nothing to do.
    }

    const totalBans = actionable.reduce(
      (n, r) => n + r.bannedUserIDs.length,
      0
    );

    // 3. If nothing to do, report inline and return.
    if (actionable.length === 0) {
      const msg =
        noPermission.length > 0
          ? `No bans to remove. ` +
            `⚠️ ${noPermission.length} room(s) were skipped due to ` +
            `insufficient power level or unavailable data.`
          : "No bans found in the specified room(s).";

      void Task(
        sendMatrixEventsFromDeadDocument(
          draupnir.clientPlatform.toRoomMessageSender(),
          draupnir.managementRoomID,
          <root>{msg}</root>,
          {}
        )
      );
      return Ok(undefined);
    }

    // 4. Build annotation context from the snapshot (point-in-time).
    const annotationContext: ClearBansAnnotationContext = {
      rooms: actionable.map((r) => ({
        roomID: r.room.toRoomIDOrAlias(),
        userIDs: r.bannedUserIDs,
      })),
    };

    const reactionMap = new Map<string, string>([
      ["✅ OK", "confirm"],
      ["❌ Cancel", "cancel"],
    ]);

    // 5. Send the preview message with reaction buttons.
    const sendResult = await sendMatrixEventsFromDeadDocument(
      draupnir.clientPlatform.toRoomMessageSender(),
      draupnir.managementRoomID,
      <root>
        🔍 Clear bans preview — {totalBans} ban
        {totalBans !== 1 ? "s" : ""} across {actionable.length} room
        {actionable.length !== 1 ? "s" : ""}:
        <ul>
          {actionable.map((r) => (
            <li>
              {renderRoomPill(
                r.alias !== undefined
                  ? MatrixRoomReference.fromAlias(r.alias)
                  : MatrixRoomReference.fromRoomID(r.room.toRoomIDOrAlias(), [])
              )}{" "}
              — {r.bannedUserIDs.length} ban
              {r.bannedUserIDs.length !== 1 ? "s" : ""}
            </li>
          ))}
        </ul>
        {noPermission.length > 0 ? (
          <fragment>
            ⚠️ {noPermission.length} room
            {noPermission.length !== 1 ? "s" : ""} skipped — insufficient power
            level or unavailable data.{" "}
          </fragment>
        ) : (
          <fragment></fragment>
        )}
      </root>,
      {
        additionalContent: draupnir.reactionHandler.createAnnotation(
          CLEAR_BANS_PROMPT_LISTENER,
          reactionMap,
          annotationContext
        ),
      }
    );

    if (isError(sendResult)) {
      return sendResult;
    }

    const promptEventID = sendResult.ok[0] as StringEventID | undefined;
    if (promptEventID !== undefined) {
      await draupnir.reactionHandler.addReactionsToEvent(
        draupnir.managementRoomID,
        promptEventID,
        reactionMap
      );
    }

    return Ok(undefined);
  },
});

DraupnirInterfaceAdaptor.describeRenderer(DraupnirClearRoomBansCommand, {
  // The executor's visible output IS the preview message sent to the management
  // room. The Ok(undefined) result from the executor needs no further rendering.
  isAlwaysSupposedToUseDefaultRenderer: true,
});
