// SPDX-FileCopyrightText: 2025 Your Name <your@email.com>
//
// SPDX-License-Identifier: AFL-3.0

import {
  AbstractProtection,
  ActionResult,
  EDStatic,
  Logger,
  MembershipChange,
  MembershipChangeType,
  Ok,
  OwnLifetime,
  PolicyRuleType,
  ProtectedRoomsSet,
  Protection,
  ProtectionDescription,
  Recommendation,
  RoomEvent,
  RoomKicker,
  RoomMembershipRevision,
  Task,
  UserConsequences,
  allocateProtection,
  describeProtection,
  isError,
} from "matrix-protection-suite";
import { Draupnir } from "../Draupnir";
import { DraupnirProtection } from "./Protection";
import {
  MatrixRoomReference,
  StringEventID,
  StringRoomID,
  StringUserID,
  isStringRoomAlias,
  userLocalpart,
} from "@the-draupnir-project/matrix-basic-types";
import { Type } from "@sinclair/typebox";
import {
  DeadDocumentJSX,
  DocumentNode,
} from "@the-draupnir-project/interface-manager";
import {
  renderMentionPill,
  renderRoomPill,
  sendMatrixEventsFromDeadDocument,
} from "@the-draupnir-project/mps-interface-adaptor";
import { resolveRoomReferenceSafe } from "matrix-protection-suite-for-matrix-bot-sdk";

const log = new Logger("JoinAlertProtection");

// ─── Reaction listener name ───────────────────────────────────────────────────

/**
 * A unique listener name for this protection's reaction prompts.
 * Must not collide with any other protection's listener names.
 */
const JOIN_ALERT_PROMPT_LISTENER = "ge.applied-langua.ge.draupnir.join_alert";

// ─── Context stored inside the Matrix event annotation ───────────────────────

interface JoinAlertContext {
  userID: StringUserID;
  roomID: StringRoomID;
}

// ─── Action kind ─────────────────────────────────────────────────────────────

/**
 * Whether the protection is currently configured to kick or ban.
 * Determined by `settings.kickInsteadOfBan` at the time of the action.
 */
type ActionKind = "ban" | "kick";

// ─── Protection config schema ─────────────────────────────────────────────────

const JoinAlertProtectionSettings = Type.Object(
  {
    /**
     * Room ID (or alias) of the policy list to write ban rules into when a
     * moderator clicks the action button (or when an auto-ban pattern fires).
     * Leave empty to auto-select the first editable policy room Draupnir
     * knows about. Has no effect when `kickInsteadOfBan` is `true`.
     */
    policyRoom: Type.String({
      default: "",
      description:
        "Room ID or alias of the policy list to write ban rules into for " +
        "cross-room propagation. Leave empty to auto-select the first editable " +
        "policy room. Unused when kickInsteadOfBan is true.",
    }),

    /**
     * Maximum allowed length of the MXID **local part** (the portion before
     * the colon, e.g. `alice` in `@alice:server`). Users whose local part
     * exceeds this length are auto-actioned. Set to `0` to disable.
     */
    maxMxidLocalpartLength: Type.Integer({
      default: 0,
      description:
        "Auto-action users whose MXID local part exceeds this length. " +
        "0 = disabled.",
    }),

    /**
     * Maximum allowed length of the display name. Users whose display name
     * exceeds this length are auto-actioned. Set to `0` to disable.
     */
    maxDisplayNameLength: Type.Integer({
      default: 0,
      description:
        "Auto-action users whose display name exceeds this length. " +
        "0 = disabled.",
    }),

    /**
     * List of ECMAScript regex patterns (strings). Each pattern is tested
     * against both the joining user's MXID and their display name. If any
     * pattern matches, the configured action (ban or kick) is executed
     * automatically — no management room prompt is shown, only a notification.
     *
     * Examples:
     *   "spam.*bot"          — MXID or display name contains "spam" then "bot"
     *   "^@[0-9]{8,}:"      — MXID local part is 8+ digits
     *   "(?i)casino|viagra"  — case-insensitive keyword match
     */
    autoActionPatterns: Type.Array(Type.String(), {
      default: [],
      description:
        "ECMAScript regex patterns tested against MXID and display name. " +
        "A match triggers an automatic ban (or kick) without showing prompt buttons.",
    }),

    /**
     * When `true`, all actions — both automatic (pattern match) and manual
     * (reaction button) — become kicks instead of bans. Kicks do not write
     * policy list entries and do not propagate across rooms, because a kicked
     * user can simply rejoin; use bans if you need persistent exclusion.
     */
    kickInsteadOfBan: Type.Boolean({
      default: false,
      description:
        "When true, all actions (automatic and manual) kick the user instead " +
        "of banning them. Kicks also propagate to other rooms.",
    }),

    whitelistedUsers: Type.Array(Type.String(), {
      default: [],
      description:
        "Full MXIDs exempt from join alerts and auto-actions. " +
        "Managed via !white add / !white del.",
    }),
  },
  { title: "JoinAlertProtectionSettings" }
);

type JoinAlertProtectionSettings = EDStatic<typeof JoinAlertProtectionSettings>;

// ─── Compiled auto-action pattern ────────────────────────────────────────────

interface CompiledPattern {
  source: string; // original string from settings, for reporting
  regex: RegExp;
}

// ─── Capability types ─────────────────────────────────────────────────────────

export type JoinAlertProtectionCapabilities = {
  userConsequences: UserConsequences;
};

export type JoinAlertProtectionDescription = ProtectionDescription<
  Draupnir,
  typeof JoinAlertProtectionSettings,
  JoinAlertProtectionCapabilities
>;

// ─── Protection class ─────────────────────────────────────────────────────────

/**
 * Protection that alerts the management room whenever a new user joins any
 * protected room, with quick-reaction buttons to **Ban** (or **Kick**) and
 * **Ignore** the joiner.
 *
 * ### Auto-action on pattern match
 * If the joining user's MXID or display name matches any regex in
 * `autoActionPatterns`, the configured action is executed immediately without
 * showing prompt buttons. A notification-only message is sent to the
 * management room indicating which pattern fired.
 *
 * ### Ban vs kick
 * When `kickInsteadOfBan` is `false` (default), the action is a permanent ban
 * that also writes a policy list entry, enabling `MemberBanSynchronisation`
 * to propagate the ban to all other protected rooms.
 *
 * When `kickInsteadOfBan` is `true`, the action is a kick from the joined room
 * only. No policy list entry is written and no cross-room propagation occurs
 * (the user can rejoin unless banned elsewhere).
 *
 */
export class JoinAlertProtection
  extends AbstractProtection<JoinAlertProtectionDescription>
  implements DraupnirProtection<JoinAlertProtectionDescription>
{
  private readonly userConsequences: UserConsequences;
  private readonly roomKicker: RoomKicker;

  /** Compiled regexes built once from settings at construction time. */
  private readonly compiledPatterns: CompiledPattern[];

  private readonly joinAlertPromptListener = (
    key: string,
    item: string,
    context: JoinAlertContext,
    _reactionMap: Map<string, string>,
    annotatedEvent: RoomEvent
  ) => {
    void Task(this.onReaction(key, item, context, annotatedEvent));
  };

  public constructor(
    description: JoinAlertProtectionDescription,
    lifetime: OwnLifetime<Protection<JoinAlertProtectionDescription>>,
    capabilities: JoinAlertProtectionCapabilities,
    protectedRoomsSet: ProtectedRoomsSet,
    private readonly draupnir: Draupnir,
    public readonly settings: JoinAlertProtectionSettings
  ) {
    super(description, lifetime, capabilities, protectedRoomsSet, {});
    this.userConsequences = capabilities.userConsequences;
    this.roomKicker = draupnir.clientPlatform.toRoomKicker();

    this.compiledPatterns = this.compilePatterns(settings.autoActionPatterns);

    this.draupnir.reactionHandler.on(
      JOIN_ALERT_PROMPT_LISTENER,
      this.joinAlertPromptListener
    );
  }

  public handleProtectionDisable(): void {
    this.draupnir.reactionHandler.off(
      JOIN_ALERT_PROMPT_LISTENER,
      this.joinAlertPromptListener
    );
  }

  // ── Pattern compilation ──────────────────────────────────────────────────

  private compilePatterns(rawPatterns: string[]): CompiledPattern[] {
    const compiled: CompiledPattern[] = [];
    for (const source of rawPatterns) {
      try {
        compiled.push({ source, regex: new RegExp(source, "i") });
      } catch (e) {
        log.error(
          `JoinAlertProtection: invalid regex pattern "${source}" in ` +
            `autoActionPatterns — skipping. Error: ${String(e)}`
        );
      }
    }
    return compiled;
  }

  /**
   * Returns a human-readable reason string if the joining user should be
   * auto-actioned, or `undefined` if they pass all checks.
   *
   * Checks are evaluated in order:
   * 1. MXID local part length (if `maxMxidLocalpartLength > 0`)
   * 2. Display name length (if `maxDisplayNameLength > 0`)
   * 3. Regex patterns (first match wins)
   */
  private autoActionReason(
    userID: StringUserID,
    displayname: string
  ): DocumentNode | undefined {
    const localpart = userLocalpart(userID);

    if (
      this.settings.maxMxidLocalpartLength > 0 &&
      localpart.length > this.settings.maxMxidLocalpartLength
    ) {
      return (
        <fragment>
          Local part too long: <code>{localpart.length}</code> chars (max{" "}
          <code>{this.settings.maxMxidLocalpartLength}</code>)
        </fragment>
      );
    }

    if (
      this.settings.maxDisplayNameLength > 0 &&
      displayname !== userID && // ignore fallback — no display name set
      displayname.length > this.settings.maxDisplayNameLength
    ) {
      return (
        <fragment>
          Display name too long: <code>{displayname.length}</code> chars (max{" "}
          <code>{this.settings.maxDisplayNameLength}</code>)
        </fragment>
      );
    }

    for (const p of this.compiledPatterns) {
      if (p.regex.test(userID) || p.regex.test(displayname)) {
        return (
          <fragment>
            Matched pattern: <code>{p.source}</code>
          </fragment>
        );
      }
    }

    return undefined;
  }

  // ── Event handler ────────────────────────────────────────────────────────

  public async handleMembershipChange(
    revision: RoomMembershipRevision,
    changes: MembershipChange[]
  ): Promise<ActionResult<void>> {
    for (const change of changes) {
      if (
        change.membershipChangeType !== MembershipChangeType.Joined &&
        change.membershipChangeType !== MembershipChangeType.Rejoined
      ) {
        continue;
      }
      void Task(this.handleJoin(change));
    }
    return Ok(undefined);
  }

  // ── Join handling ────────────────────────────────────────────────────────

  private isUserAlreadyBanned(userID: StringUserID): boolean {
    return this.protectedRoomsSet.watchedPolicyRooms.currentRevision
      .allRulesMatchingEntity(userID, {})
      .some(
        (rule) =>
          rule.recommendation === Recommendation.Ban ||
          rule.recommendation === Recommendation.Takedown
      );
  }

  private isUserWhitelisted(userID: StringUserID): boolean {
    return this.settings.whitelistedUsers.includes(userID);
  }

  private async sendWhitelistNotification(
    change: MembershipChange
  ): Promise<void> {
    const displayname = change.content.displayname ?? change.userID;
    const roomRef = this.roomReferenceForDisplay(change.roomID);
    const sendResult = await sendMatrixEventsFromDeadDocument(
      this.draupnir.clientPlatform.toRoomMessageSender(),
      this.draupnir.managementRoomID,
      <root>
        ✅ Whitelisted user joined {renderRoomPill(roomRef)}:{" "}
        {renderMentionPill(change.userID, displayname)} (
        <code>{userLocalpart(change.userID)}</code>, display name{" "}
        <code>{displayname}</code>)
      </root>,
      {}
    );
    if (isError(sendResult)) {
      log.error(
        `Failed to send whitelist notification for ${change.userID}`,
        sendResult.error
      );
    }
  }

  private async handleJoin(change: MembershipChange): Promise<void> {
    const { roomID, userID } = change;
    const displayname = change.content.displayname ?? userID;
    const actionKind: ActionKind = this.settings.kickInsteadOfBan
      ? "kick"
      : "ban";

    // Already covered by a ban policy — MemberBanSynchronisation handles it.
    if (this.isUserAlreadyBanned(userID)) {
      return;
    }

    // Auto-actions always fire regardless of prior vetting status — a user
    // might be a member of other rooms and only later change their display
    // name to something matching a pattern.
    const autoReason = this.autoActionReason(userID, displayname);
    if (autoReason !== undefined) {
      await this.executeAction({ userID, roomID }, actionKind);
      await this.sendAutoActionNotification(change, autoReason, actionKind);
      return;
    }

    // If the user is already a current member of another protected room,
    // they've been vetted on a previous join — no notification needed.
    if (this.isUserInOtherProtectedRoom(userID, roomID)) {
      return;
    }

    // First time we're seeing this user across our protected rooms.
    if (this.isUserWhitelisted(userID)) {
      await this.sendWhitelistNotification(change);
      return;
    }
    await this.sendJoinAlert(change, actionKind);
  }

  /**
   * Returns true if `userID` is currently joined in any protected room other
   * than `excludeRoomID` (typically the room that triggered the current join
   * event, which we ignore because it's by definition where they just joined).
   */
  private isUserInOtherProtectedRoom(
    userID: StringUserID,
    excludeRoomID: StringRoomID
  ): boolean {
    for (const room of this.protectedRoomsSet.allProtectedRooms) {
      const otherRoomID = room.toRoomIDOrAlias();
      if (otherRoomID === excludeRoomID) continue;
      const revision =
        this.protectedRoomsSet.setRoomMembership.getRevision(otherRoomID);
      const member = revision?.membershipForUser(userID);
      if (member?.content.membership === "join") {
        return true;
      }
    }
    return false;
  }

  // ── Room display helper ───────────────────────────────────────────────────

  /**
   * Returns a `MatrixRoomReference` for display. Uses the canonical alias
   * (`#name:server`) when available, falling back to the raw room ID.
   */
  private roomReferenceForDisplay(roomID: StringRoomID): MatrixRoomReference {
    const revision = this.protectedRoomsSet.setRoomState.getRevision(roomID);
    if (revision !== undefined) {
      const aliasEvent = revision.getStateEvent("m.room.canonical_alias", "");
      const alias = (aliasEvent?.content as { alias?: string } | undefined)
        ?.alias;
      if (alias !== undefined && isStringRoomAlias(alias)) {
        return MatrixRoomReference.fromAlias(alias);
      }
    }
    return MatrixRoomReference.fromRoomID(roomID, []);
  }

  // ── Alert messages ───────────────────────────────────────────────────────

  /**
   * Sends the normal join alert with Ban/Kick and Ignore reaction buttons.
   */
  private async sendJoinAlert(
    change: MembershipChange,
    actionKind: ActionKind
  ): Promise<void> {
    const displayname = change.content.displayname ?? change.userID;
    const roomRef = this.roomReferenceForDisplay(change.roomID);
    const reactionMap = this.makeReactionMap(actionKind);

    const sendResult = await sendMatrixEventsFromDeadDocument(
      this.draupnir.clientPlatform.toRoomMessageSender(),
      this.draupnir.managementRoomID,
      <root>
        🔔 New user joined {renderRoomPill(roomRef)}:{" "}
        {renderMentionPill(change.userID, displayname)} (
        <code>{userLocalpart(change.userID)}</code>, display name{" "}
        <code>{displayname}</code>)
      </root>,
      {
        additionalContent: this.draupnir.reactionHandler.createAnnotation(
          JOIN_ALERT_PROMPT_LISTENER,
          reactionMap,
          {
            userID: change.userID,
            roomID: change.roomID,
          } satisfies JoinAlertContext
        ),
      }
    );

    if (isError(sendResult)) {
      log.error(
        `Failed to send join alert for ${change.userID} in ${change.roomID}`,
        sendResult.error
      );
      return;
    }

    const promptEventID = sendResult.ok[0] as StringEventID | undefined;
    if (promptEventID === undefined) {
      log.error(`sendMatrixEventsFromDeadDocument returned no event IDs`);
      return;
    }

    await this.draupnir.reactionHandler.addReactionsToEvent(
      this.draupnir.managementRoomID,
      promptEventID,
      reactionMap
    );
  }

  /**
   * Sends a notification-only message (no reaction buttons) after an automatic
   * ban or kick triggered by a matching pattern.
   */
  private async sendAutoActionNotification(
    change: MembershipChange,
    reason: DocumentNode,
    actionKind: ActionKind
  ): Promise<void> {
    const displayname = change.content.displayname ?? change.userID;
    const actionLabel = actionKind === "kick" ? "kicked" : "banned";
    const emoji = actionKind === "kick" ? "👢" : "🔨";

    const sendResult = await sendMatrixEventsFromDeadDocument(
      this.draupnir.clientPlatform.toRoomMessageSender(),
      this.draupnir.managementRoomID,
      <root>
        {emoji} Auto-{actionLabel} <code>{userLocalpart(change.userID)}</code>,
        display name <code>{displayname}</code> — {reason}
      </root>,
      {}
    );

    if (isError(sendResult)) {
      log.error(
        `Failed to send auto-action notification for ${change.userID}`,
        sendResult.error
      );
    }
  }

  // ── Reaction map ─────────────────────────────────────────────────────────

  /**
   * Builds the reaction map for the join alert prompt. The action button label
   * reflects the currently configured action kind so moderators always see
   * which action will be taken.
   */
  private makeReactionMap(actionKind: ActionKind): Map<string, string> {
    const actionLabel = actionKind === "kick" ? "👢 Kick" : "🚫 Ban";
    return new Map<string, string>([
      ["✅ Ignore", "ignore"],
      [actionLabel, "action"],
    ]);
  }

  // ── Reaction handler ─────────────────────────────────────────────────────

  private async onReaction(
    _key: string,
    item: string,
    context: JoinAlertContext,
    annotatedEvent: RoomEvent
  ): Promise<void> {
    if (item === "action") {
      const actionKind: ActionKind = this.settings.kickInsteadOfBan
        ? "kick"
        : "ban";
      await this.executeAction(context, actionKind);
    }
    // Redact the reaction buttons for both "action" and "ignore" so the
    // prompt cannot be acted on a second time.
    const completeResult = await this.draupnir.reactionHandler.completePrompt(
      annotatedEvent.room_id,
      annotatedEvent.event_id
    );
    if (isError(completeResult)) {
      log.error(
        `Failed to clean up join alert prompt ${annotatedEvent.event_id}`,
        completeResult.error
      );
    }
  }

  // ── Action execution ─────────────────────────────────────────────────────

  /**
   * Executes the configured action against a user.
   *
   * **Ban** (`actionKind === "ban"`):
   * 1. Issues a room-level ban via `UserConsequences` (immediate effect).
   * 2. Writes a `m.ban` policy rule to the configured policy list so that
   *    `MemberBanSynchronisation` can propagate the ban to all other
   *    protected rooms automatically.
   *
   * **Kick** (`actionKind === "kick"`):
   * 1. Kicks the user from the joined room only.
   * 2. Does **not** write a policy rule — kicks are not persistent and do
   *    not propagate.
   */
  private async executeAction(
    context: JoinAlertContext,
    actionKind: ActionKind
  ): Promise<void> {
    if (actionKind === "kick") {
      // Kick from every protected room the user has currently joined, not
      // just the room that triggered the alert — they may have joined several
      // rooms in quick succession (e.g. via a space cascade).
      for (const room of this.protectedRoomsSet.allProtectedRooms) {
        const revision = this.protectedRoomsSet.setRoomMembership.getRevision(
          room.toRoomIDOrAlias()
        );
        const membership = revision?.membershipForUser(context.userID);
        if (membership?.content.membership !== "join") {
          continue; // not currently in this room
        }
        const kickResult = await this.roomKicker.kickUser(
          room,
          context.userID,
          undefined
        );
        if (isError(kickResult)) {
          log.error(
            `Failed to kick ${context.userID} from ${room.toRoomIDOrAlias()}`,
            kickResult.error
          );
        }
      }
      return;
    }

    // Ban path: room-level ban first, then policy list entry.
    const banResult = await this.userConsequences.consequenceForUserInRoom(
      context.roomID,
      context.userID,
      "---"
    );
    if (isError(banResult)) {
      log.error(
        `Failed to ban ${context.userID} from ${context.roomID}`,
        banResult.error
      );
      // Continue — still attempt the policy list entry for propagation.
    }

    // Policy list entry for cross-room propagation.
    const editor = await this.resolvePolicyRoomEditor();
    if (editor === undefined) {
      return; // error already logged
    }

    // Skip if a rule already exists for this user.
    if (this.isUserAlreadyBanned(context.userID)) {
      log.info(
        `${context.userID} already covered by a policy rule; skipping duplicate.`
      );
      return;
    }

    const policyResult = await editor.banEntity(
      PolicyRuleType.User,
      context.userID,
      "---"
    );
    if (isError(policyResult)) {
      log.error(
        `Failed to add ban rule for ${context.userID} to policy list`,
        policyResult.error
      );
    }
  }

  // ── Policy room resolution ───────────────────────────────────────────────

  /**
   * Resolves a `PolicyRoomEditor` for writing ban rules.
   *
   * Prefers `settings.policyRoom` if set; otherwise uses the first editable
   * policy room Draupnir knows about.
   */
  private async resolvePolicyRoomEditor() {
    // Prefer the explicitly configured room.
    if (this.settings.policyRoom !== "") {
      // fromString accepts a plain string (room ID, alias, or permalink) and
      // returns Result<MatrixRoomReference>, unlike fromRoomIDOrAlias which
      // requires an already-typed StringRoomID | StringRoomAlias.
      const ref = MatrixRoomReference.fromString(this.settings.policyRoom);
      if (isError(ref)) {
        log.error(
          `Configured policyRoom "${this.settings.policyRoom}" is not a valid ` +
            `room ID, alias, or permalink`,
          ref.error
        );
        return undefined;
      }
      const resolved = await resolveRoomReferenceSafe(
        this.draupnir.client,
        ref.ok
      );
      if (isError(resolved)) {
        log.error(
          `Could not resolve configured policyRoom "${this.settings.policyRoom}"`,
          resolved.error
        );
        return undefined;
      }
      const editorResult =
        await this.draupnir.policyRoomManager.getPolicyRoomEditor(resolved.ok);
      if (isError(editorResult)) {
        log.error(
          `Could not get a policy room editor for "${this.settings.policyRoom}"`,
          editorResult.error
        );
        return undefined;
      }
      return editorResult.ok;
    }

    // Fall back to the first editable policy room.
    const editableRooms =
      this.draupnir.policyRoomManager.getEditablePolicyRoomIDs(
        this.draupnir.clientUserID,
        PolicyRuleType.User
      );
    const firstRoom = editableRooms[0];
    if (firstRoom === undefined) {
      log.error(
        `No editable policy room available. Watch at least one policy list or ` +
          `set the policyRoom protection setting.`
      );
      return undefined;
    }

    const editorResult =
      await this.draupnir.policyRoomManager.getPolicyRoomEditor(firstRoom);
    if (isError(editorResult)) {
      log.error(
        `Could not get a policy room editor for ${firstRoom.toRoomIDOrAlias()}`,
        editorResult.error
      );
      return undefined;
    }
    return editorResult.ok;
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

describeProtection<
  JoinAlertProtectionCapabilities,
  Draupnir,
  typeof JoinAlertProtectionSettings
>({
  name: "JoinAlertProtection",
  description:
    "Alerts the management room when a new user joins a protected room, with " +
    "quick-reaction buttons to Ban/Kick or Ignore the joiner. Supports automatic " +
    "banning/kicking based on regex patterns matched against MXID and display name.",
  capabilityInterfaces: {
    userConsequences: "UserConsequences",
  },
  defaultCapabilities: {
    userConsequences: "StandardUserConsequences",
  },
  configSchema: JoinAlertProtectionSettings,
  factory: async (
    description,
    lifetime,
    protectedRoomsSet,
    draupnir,
    capabilities,
    settings
  ) =>
    allocateProtection(
      lifetime,
      new JoinAlertProtection(
        description,
        lifetime,
        capabilities,
        protectedRoomsSet,
        draupnir,
        settings
      )
    ),
});
