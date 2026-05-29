// SPDX-FileCopyrightText: 2025 Your Name <your@email.com>
//
// SPDX-License-Identifier: AFL-3.0

/**
 * Shortcut commands for common moderator actions.
 *
 * Every executor here delegates directly to the corresponding original command
 * executor. No action logic is duplicated; this file only contains:
 *   - MXID expansion (localpart → @localpart:matrix.org)
 *   - Context construction (mirrors the registered translation factories)
 *   - Argument pre-filling (policy room, reason, no-confirm flag)
 *
 * Commands:
 *   !auto add "pattern"   — add regex to JoinAlertProtection.autoActionPatterns
 *   !auto del "pattern"   — remove regex from autoActionPatterns
 *   !auto                 — show all autoActionPatterns
 *   !limit local <n>      — set JoinAlertProtection.maxMxidLocalpartLength
 *   !limit display <n>    — set JoinAlertProtection.maxDisplayNameLength
 *   !ban <user>           — ban from default policy list, reason "---"
 *   !uban <user>          — unban from all lists/rooms, no confirm prompt
 *   !kick <user>          — kick from every protected room the user is in
 *   !red <user>           — redact all recent messages in all protected rooms
 */

import {
  ActionError,
  ActionResult,
  Ok,
  PolicyRuleType,
  findProtection,
  isError,
} from "matrix-protection-suite";
import { Draupnir } from "../Draupnir";
import {
  MatrixUserID,
  StringUserID,
} from "@the-draupnir-project/matrix-basic-types";
import {
  BasicInvocationInformation,
  DeadDocumentJSX,
  ParsedKeywords,
  StringPresentationType,
  describeCommand,
  tuple,
} from "@the-draupnir-project/interface-manager";
import { DraupnirInterfaceAdaptor } from "./DraupnirCommandPrerequisites";
import {
  DraupnirProtectionsConfigAddCommand,
  DraupnirProtectionsConfigRemoveCommand,
  DraupnirProtectionsConfigSetCommand,
  SettingChangeSummary,
  renderSettingChangeSummary,
} from "./ProtectionsCommands";
import { DraupnirBanCommand, DraupnirBanCommandContext } from "./Ban";
import { DraupnirKickCommand, DraupnirKickCommandContext } from "./KickCommand";
import {
  DraupnirUnbanCommand,
  DraupnirUnbanCommandContext,
} from "./unban/Unban";
import { DraupnirRedactCommand } from "./RedactCommand";

// ── Keyword stub ─────────────────────────────────────────────────────────────

/**
 * Minimal {@link ParsedKeywords} implementation that returns pre-set values
 * without requiring a full `KeywordParametersDescription`.
 *
 * Used to inject (or suppress) specific keyword flags when calling an original
 * command executor programmatically.
 */
class DirectKeywords implements ParsedKeywords {
  public constructor(private readonly values: Record<string, unknown> = {}) {}

  public getKeywordValue<T>(keyword: string, defaultValue?: T): T | undefined {
    return keyword in this.values ? (this.values[keyword] as T) : defaultValue;
  }
}

const EMPTY_KEYWORDS = new DirectKeywords();
const NO_CONFIRM_KEYWORDS = new DirectKeywords({ "no-confirm": true });

// ── MXID expansion ───────────────────────────────────────────────────────────

const DEFAULT_SERVER = "matrix.org";

/**
 * Returns a full `StringUserID` from `input`.
 * - `"alice"`            → `"@alice:matrix.org"`
 * - `"@alice:other.org"` → `"@alice:other.org"` (verbatim)
 */
function expandUserID(input: string): StringUserID {
  if (input.startsWith("@") && input.includes(":")) {
    return input as StringUserID;
  }
  const localpart = input.startsWith("@") ? input.slice(1) : input;
  return `@${localpart}:${DEFAULT_SERVER}` as StringUserID;
}

// ── Context factories ────────────────────────────────────────────────────────
// Each factory is a direct copy of the translation registered in the original
// command's source file, so the behaviour is identical.

function makeProtectionsConfigCtx(draupnir: Draupnir) {
  return {
    protectionContext: draupnir,
    protectionsManager: draupnir.protectedRoomsSet.protections,
    protectedRoomsSet: draupnir.protectedRoomsSet,
  };
}

function makeBanCtx(draupnir: Draupnir): DraupnirBanCommandContext {
  return {
    policyRoomManager: draupnir.policyRoomManager,
    watchedPolicyRooms: draupnir.protectedRoomsSet.watchedPolicyRooms,
    defaultReasons: draupnir.config.commands.ban.defaultReasons,
    roomResolver: draupnir.clientPlatform.toRoomResolver(),
    clientUserID: draupnir.clientUserID,
  };
}

function makeKickCtx(draupnir: Draupnir): DraupnirKickCommandContext {
  return {
    roomKicker: draupnir.clientPlatform.toRoomKicker(),
    roomResolver: draupnir.clientPlatform.toRoomResolver(),
    setMembership: draupnir.protectedRoomsSet.setRoomMembership,
    taskQueue: draupnir.taskQueue,
    noop: draupnir.config.noop,
  };
}

function makeUnbanCtx(draupnir: Draupnir): DraupnirUnbanCommandContext {
  return {
    policyRoomManager: draupnir.policyRoomManager,
    watchedPolicyRooms: draupnir.protectedRoomsSet.watchedPolicyRooms,
    roomResolver: draupnir.clientPlatform.toRoomResolver(),
    clientUserID: draupnir.clientUserID,
    setRoomMembership: draupnir.protectedRoomsSet.setRoomMembership,
    setMembership: draupnir.protectedRoomsSet.setMembership,
    setPoliciesMatchingMembership:
      draupnir.protectedRoomsSet.setPoliciesMatchingMembership.currentRevision,
    managementRoomOutput: draupnir.managementRoomOutput,
    noop: draupnir.config.noop,
    roomUnbanner: draupnir.clientPlatform.toRoomUnbanner(),
    unlistedUserRedactionQueue: draupnir.unlistedUserRedactionQueue,
    roomInviter: draupnir.clientPlatform.toRoomInviter(),
  };
}

// ── Policy room resolver ─────────────────────────────────────────────────────

async function resolveFirstPolicyRoom(draupnir: Draupnir) {
  const editableRooms = draupnir.policyRoomManager.getEditablePolicyRoomIDs(
    draupnir.clientUserID,
    PolicyRuleType.User
  );
  const firstRoom = editableRooms[0];
  if (firstRoom === undefined) {
    return ActionError.Result(
      "No editable policy room available. Watch a policy list first with !watch <room>."
    );
  }
  return Ok(firstRoom); // MatrixRoomID, which satisfies MatrixRoomReference
}

// ── Shared renderer for config-change commands ───────────────────────────────

/** Identical to the renderer used by the DraupnirProtectionsConfig* commands. */
function configChangeRenderer(result: ActionResult<SettingChangeSummary>) {
  if (isError(result)) return Ok(undefined);
  return Ok(<root>{renderSettingChangeSummary(result.ok)}</root>);
}

// ── !auto add ────────────────────────────────────────────────────────────────

export const ShortcutAutoAddCommand = describeCommand({
  summary:
    "Add a regex pattern to JoinAlertProtection.autoActionPatterns. " +
    'Patterns are case-insensitive. Usage: !auto add "pattern"',
  parameters: tuple({
    name: "pattern",
    acceptor: StringPresentationType,
    description: "ECMAScript regex. Plain strings do a substring match.",
  }),
  async executor(
    draupnir: Draupnir,
    info,
    _keywords,
    rest,
    pattern: string
  ): Promise<ActionResult<SettingChangeSummary>> {
    try {
      new RegExp(pattern);
    } catch (e) {
      return ActionError.Result(
        `"${pattern}" is not a valid regex: ${String(e)}`
      );
    }
    return DraupnirProtectionsConfigAddCommand.executor(
      makeProtectionsConfigCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest,
      "JoinAlertProtection",
      "autoActionPatterns",
      pattern
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutAutoAddCommand, {
  JSXRenderer: configChangeRenderer,
});

// ── !auto del ────────────────────────────────────────────────────────────────

export const ShortcutAutoDelCommand = describeCommand({
  summary:
    "Remove a regex pattern from JoinAlertProtection.autoActionPatterns. " +
    'Usage: !auto del "pattern"',
  parameters: tuple({
    name: "pattern",
    acceptor: StringPresentationType,
    description: "The exact pattern string to remove.",
  }),
  async executor(
    draupnir: Draupnir,
    info,
    _keywords,
    rest,
    pattern: string
  ): Promise<ActionResult<SettingChangeSummary>> {
    return DraupnirProtectionsConfigRemoveCommand.executor(
      makeProtectionsConfigCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest,
      "JoinAlertProtection",
      "autoActionPatterns",
      pattern
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutAutoDelCommand, {
  JSXRenderer: configChangeRenderer,
});

// ── !auto ────────────────────────────────────────────────────────────────────
// No original command to delegate to — minimal read-only custom implementation.

export const ShortcutAutoListCommand = describeCommand({
  summary:
    "List all current autoActionPatterns in JoinAlertProtection. Usage: !auto",
  parameters: [],
  async executor(draupnir: Draupnir): Promise<ActionResult<string[]>> {
    const desc = findProtection("JoinAlertProtection");
    if (desc === undefined) {
      return ActionError.Result(
        "JoinAlertProtection is not registered. " +
          "Enable it first with !protections enable JoinAlertProtection"
      );
    }
    const settingsResult =
      await draupnir.protectedRoomsSet.protections.getProtectionSettings(desc);
    if (isError(settingsResult)) return settingsResult;
    const patterns =
      (settingsResult.ok as { autoActionPatterns?: string[] })
        .autoActionPatterns ?? [];
    return Ok(patterns);
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutAutoListCommand, {
  JSXRenderer(result) {
    if (isError(result)) return Ok(undefined);
    const patterns = result.ok;
    if (patterns.length === 0) {
      return Ok(<root>No auto-action patterns are currently configured.</root>);
    }
    return Ok(
      <root>
        Auto-action patterns (<code>{patterns.length}</code> total):
        <ul>
          {patterns.map((p) => (
            <li>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      </root>
    );
  },
});

// ─── !white ───────────────────────────────────────────────────────────────────

export const ShortcutWhiteListCommand = describeCommand({
  summary: "List all whitelisted users in JoinAlertProtection. Usage: !white",
  parameters: [],
  async executor(draupnir: Draupnir): Promise<ActionResult<string[]>> {
    const desc = findProtection("JoinAlertProtection");
    if (desc === undefined) {
      return ActionError.Result(
        "JoinAlertProtection is not registered. " +
          "Enable it first with !protections enable JoinAlertProtection"
      );
    }
    const settingsResult =
      await draupnir.protectedRoomsSet.protections.getProtectionSettings(desc);
    if (isError(settingsResult)) return settingsResult;
    return Ok(
      (settingsResult.ok as { whitelistedUsers?: string[] }).whitelistedUsers ??
        []
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutWhiteListCommand, {
  JSXRenderer(result) {
    if (isError(result)) return Ok(undefined);
    const users = result.ok;
    if (users.length === 0) {
      return Ok(<root>No users are currently whitelisted.</root>);
    }
    return Ok(
      <root>
        Whitelisted users (<code>{users.length}</code> total):
        <ul>
          {users.map((u) => (
            <li>
              <code>{u}</code>
            </li>
          ))}
        </ul>
      </root>
    );
  },
});

// ─── !white add ───────────────────────────────────────────────────────────────

export const ShortcutWhiteAddCommand = describeCommand({
  summary:
    "Add a user to the JoinAlertProtection whitelist. " +
    "Bare localparts expand to @localpart:matrix.org. " +
    "Usage: !white add <localpart|@user:server>",
  parameters: tuple({
    name: "user",
    acceptor: StringPresentationType,
    description:
      "MXID or bare localpart. Localparts are expanded to @localpart:matrix.org.",
  }),
  async executor(
    draupnir: Draupnir,
    info,
    _keywords,
    rest,
    user: string
  ): Promise<ActionResult<SettingChangeSummary>> {
    return DraupnirProtectionsConfigAddCommand.executor(
      makeProtectionsConfigCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest,
      "JoinAlertProtection",
      "whitelistedUsers",
      expandUserID(user)
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutWhiteAddCommand, {
  JSXRenderer: configChangeRenderer,
});

// ─── !white del ───────────────────────────────────────────────────────────────

export const ShortcutWhiteDelCommand = describeCommand({
  summary:
    "Remove a user from the JoinAlertProtection whitelist. " +
    "Bare localparts expand to @localpart:matrix.org only — " +
    "@localpart:other.server is unaffected. " +
    "Usage: !white del <localpart|@user:server>",
  parameters: tuple({
    name: "user",
    acceptor: StringPresentationType,
    description:
      "MXID or bare localpart. Localparts are expanded to @localpart:matrix.org.",
  }),
  async executor(
    draupnir: Draupnir,
    info,
    _keywords,
    rest,
    user: string
  ): Promise<ActionResult<SettingChangeSummary>> {
    return DraupnirProtectionsConfigRemoveCommand.executor(
      makeProtectionsConfigCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest,
      "JoinAlertProtection",
      "whitelistedUsers",
      expandUserID(user)
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutWhiteDelCommand, {
  JSXRenderer: configChangeRenderer,
});

// ── !limit local ─────────────────────────────────────────────────────────────

export const ShortcutLimitLocalCommand = describeCommand({
  summary:
    "Set JoinAlertProtection.maxMxidLocalpartLength. 0 = disabled. " +
    "Usage: !limit local <n>",
  parameters: tuple({
    name: "max length",
    acceptor: StringPresentationType,
    description: "Non-negative integer. 0 disables the check.",
  }),
  async executor(
    draupnir: Draupnir,
    info,
    _keywords,
    rest,
    value: string
  ): Promise<ActionResult<SettingChangeSummary>> {
    if (isNaN(parseInt(value, 10)) || parseInt(value, 10) < 0) {
      return ActionError.Result(
        `"${value}" is not a valid non-negative integer.`
      );
    }
    return DraupnirProtectionsConfigSetCommand.executor(
      makeProtectionsConfigCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest,
      "JoinAlertProtection",
      "maxMxidLocalpartLength",
      parseInt(value, 10) // was: value
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutLimitLocalCommand, {
  JSXRenderer: configChangeRenderer,
});

// ── !limit display ───────────────────────────────────────────────────────────

export const ShortcutLimitDisplayCommand = describeCommand({
  summary:
    "Set JoinAlertProtection.maxDisplayNameLength. 0 = disabled. " +
    "Usage: !limit display <n>",
  parameters: tuple({
    name: "max length",
    acceptor: StringPresentationType,
    description: "Non-negative integer. 0 disables the check.",
  }),
  async executor(
    draupnir: Draupnir,
    info,
    _keywords,
    rest,
    value: string
  ): Promise<ActionResult<SettingChangeSummary>> {
    if (isNaN(parseInt(value, 10)) || parseInt(value, 10) < 0) {
      return ActionError.Result(
        `"${value}" is not a valid non-negative integer.`
      );
    }
    return DraupnirProtectionsConfigSetCommand.executor(
      makeProtectionsConfigCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest,
      "JoinAlertProtection",
      "maxDisplayNameLength",
      parseInt(value, 10) // was: value
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutLimitDisplayCommand, {
  JSXRenderer: configChangeRenderer,
});

// ── !ban ─────────────────────────────────────────────────────────────────────

export const ShortcutBanCommand = describeCommand({
  summary:
    'Ban from the default policy list with reason "---". ' +
    "Localparts expand to @localpart:matrix.org. " +
    "Usage: !ban <localpart|@user:server>",
  parameters: tuple({
    name: "user",
    acceptor: StringPresentationType,
    description: "MXID or bare localpart.",
  }),
  async executor(draupnir: Draupnir, info, _keywords, _rest, user: string) {
    const policyRoomResult = await resolveFirstPolicyRoom(draupnir);
    if (isError(policyRoomResult)) return policyRoomResult;
    return DraupnirBanCommand.executor(
      makeBanCtx(draupnir),
      info as BasicInvocationInformation,
      EMPTY_KEYWORDS,
      ["---"], // reason pre-filled
      new MatrixUserID(expandUserID(user)),
      policyRoomResult.ok // MatrixRoomID satisfies MatrixRoomReference
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutBanCommand, {
  isAlwaysSupposedToUseDefaultRenderer: true,
});

// ── !uban ───────────────────────────────────────────────────────────────────

export const ShortcutUnbanCommand = describeCommand({
  summary:
    "Remove all policy rules for a user and unban from all protected rooms, " +
    "without a confirmation prompt. " +
    "Localparts expand to @localpart:matrix.org. " +
    "Usage: !uban <localpart|@user:server>",
  parameters: tuple({
    name: "user",
    acceptor: StringPresentationType,
    description: "MXID or bare localpart.",
  }),
  async executor(draupnir: Draupnir, info, _keywords, rest, user: string) {
    return DraupnirUnbanCommand.executor(
      makeUnbanCtx(draupnir),
      info,
      NO_CONFIRM_KEYWORDS, // bypasses the preview/confirm step
      rest,
      new MatrixUserID(expandUserID(user))
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutUnbanCommand, {
  isAlwaysSupposedToUseDefaultRenderer: true,
});

// ── !kick ────────────────────────────────────────────────────────────────────

export const ShortcutKickCommand = describeCommand({
  summary:
    "Kick a user from every protected room they are currently joined in. " +
    "Localparts expand to @localpart:matrix.org. " +
    "Usage: !kick <localpart|@user:server>",
  parameters: tuple({
    name: "user",
    acceptor: StringPresentationType,
    description: "MXID or bare localpart.",
  }),
  async executor(draupnir: Draupnir, info, _keywords, rest, user: string) {
    // EMPTY_KEYWORDS → no --room scope → original executor kicks from all
    // protected rooms, which is exactly the behaviour wanted here.
    return DraupnirKickCommand.executor(
      makeKickCtx(draupnir),
      info,
      EMPTY_KEYWORDS,
      rest as string[],
      new MatrixUserID(expandUserID(user))
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutKickCommand, {
  isAlwaysSupposedToUseDefaultRenderer: true,
});

// ── !red ─────────────────────────────────────────────────────────────────────

export const ShortcutRedCommand = describeCommand({
  summary:
    "Redact all recent messages from a user across all protected rooms. " +
    "Localparts expand to @localpart:matrix.org. " +
    "Usage: !red <localpart|@user:server>",
  parameters: tuple({
    name: "user",
    acceptor: StringPresentationType,
    description: "MXID or bare localpart.",
  }),
  async executor(draupnir: Draupnir, info, _keywords, rest, user: string) {
    // DraupnirRedactCommand uses Draupnir directly as its context.
    // EMPTY_KEYWORDS → no --room / --limit scoping → all protected rooms.
    return DraupnirRedactCommand.executor(
      draupnir,
      info,
      EMPTY_KEYWORDS,
      rest as string[],
      new MatrixUserID(expandUserID(user))
    );
  },
});

DraupnirInterfaceAdaptor.describeRenderer(ShortcutRedCommand, {
  isAlwaysSupposedToUseDefaultRenderer: true,
});
