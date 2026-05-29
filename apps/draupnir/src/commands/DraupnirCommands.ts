// SPDX-FileCopyrightText: 2024 Gnuxie <Gnuxie@protonmail.com>
// SPDX-FileCopyrightText: 2025 Your Name <your@email.com>
//
// SPDX-License-Identifier: Apache-2.0
//
// SPDX-FileAttributionText: <text>
// This modified file incorporates work from Draupnir
// https://github.com/the-draupnir-project/Draupnir
// </text>

import { StandardCommandTable } from "@the-draupnir-project/interface-manager";
import { DraupnirResolveAliasCommand } from "./ResolveAlias";
import {
  DraupnirAliasAddCommand,
  DraupnirAliasMoveCommand,
  DraupnirAliasRemoveCommand,
} from "./AliasCommands";
import { DraupnirBanCommand } from "./Ban";
import { DraupnirListCreateCommand } from "./CreateBanListCommand";
import { SynapseAdminDeactivateCommand } from "./server-admin/DeactivateCommand";
import { DraupnirHelpCommand } from "./Help";
import { DraupnirInfoCommand } from "./InfoCommand";
import { SynapseAdminHijackRoomCommand } from "./server-admin/HijackRoomCommand";
import { DraupnirImportCommand } from "./ImportCommand";
import { DraupnirKickCommand } from "./KickCommand";
import {
  DraupnirListProtectionsCommand,
  DraupnirProtectionsCapabilityResetCommand,
  DraupnirProtectionsConfigAddCommand,
  DraupnirProtectionsConfigRemoveCommand,
  DraupnirProtectionsConfigResetCommand,
  DraupnirProtectionsConfigSetCommand,
  DraupnirProtectionsDisableCommand,
  DraupnirProtectionsEnableCommand,
} from "./ProtectionsCommands";
import { DraupnirRedactCommand } from "./RedactCommand";
import {
  DraupnirListProtectedRoomsCommand,
  DraupnirRoomsAddCommand,
  DraupnirRoomsRemoveCommand,
} from "./Rooms";
import {
  DraupnirListRulesCommand,
  DraupnirRulesMatchingCommand,
  DraupnirRulesMatchingMembersCommand,
} from "./Rules";
import { DraupnirDisplaynameCommand } from "./SetDisplayNameCommand";
import { DraupnirSetPowerLevelCommand } from "./SetPowerLevelCommand";
import { SynapseAdminShutdownRoomCommand } from "./server-admin/ShutdownRoomCommand";
import { DraupnirStatusCommand } from "./StatusCommand";
import { DraupnirUnbanCommand } from "./unban/Unban";
import {
  DraupnirUnwatchPolicyRoomCommand,
  DraupnirWatchPolicyRoomCommand,
} from "./WatchUnwatchCommand";
import { DraupnirTopLevelCommands } from "./DraupnirCommandTable";
import { DraupnirSafeModeCommand } from "./SafeModeCommand";
import { DraupnirProtectionsShowCommand } from "./ProtectionsShowCommand";
import { DraupnirProtectionsCapabilityCommand } from "./ProtectionsCapabilitiesCommand";
import { JoinWaveCommandTable } from "../protections/JoinWaveShortCircuit";
import { DraupnirTakedownCommand } from "./server-admin/Takedown";
import { SynapseAdminSuspendUserCommand } from "./server-admin/SuspendCommand";
import { SynpaseAdminUnrestrictUserCommand } from "./server-admin/UnrestrictCommand";
import { DraupnirPolicyRemoveCommand } from "./unban/PolicyRemove";
import { DraupnirClearRoomBansCommand } from "./ClearRoomBans";
import {
  ShortcutAutoAddCommand,
  ShortcutAutoDelCommand,
  ShortcutAutoListCommand,
  ShortcutBanCommand,
  ShortcutKickCommand,
  ShortcutLimitDisplayCommand,
  ShortcutLimitLocalCommand,
  ShortcutRedCommand,
  ShortcutUnbanCommand,
  ShortcutWhiteListCommand,
  ShortcutWhiteAddCommand,
  ShortcutWhiteDelCommand,
} from "./ShortcutCommands";

// TODO: These commands should all be moved to subdirectories tbh and this
// should be split like an index file for each subdirectory.
export const SynapseAdminCommands = new StandardCommandTable("synapse admin")
  .internCommand(SynapseAdminDeactivateCommand, ["deactivate"])
  .internCommand(SynapseAdminHijackRoomCommand, ["hijack", "room"])
  .internCommand(SynapseAdminShutdownRoomCommand, ["shutdown", "room"])
  .internCommand(SynapseAdminSuspendUserCommand, ["suspend"])
  .internCommand(SynpaseAdminUnrestrictUserCommand, ["unrestrict"]);

const DraupnirCommands = new StandardCommandTable("draupnir")
  .internCommand(DraupnirAliasAddCommand, ["alias", "add"])
  .internCommand(DraupnirAliasMoveCommand, ["alias", "move"])
  .internCommand(DraupnirAliasRemoveCommand, ["alias", "remove"])
  .internCommand(DraupnirBanCommand, ["bans"])
  // ── Shortcut: !ban <localpart|@user:server> ──────────────────────────────
  // Replaces the verbose DraupnirBanCommand. Expands bare localparts to
  // @localpart:matrix.org and uses "---" as the ban reason automatically.
  // The full DraupnirBanCommand remains available in Ban.tsx if ever needed.
  .internCommand(ShortcutBanCommand, ["ban"])
  .internCommand(DraupnirListCreateCommand, ["list", "create"])
  .internCommand(DraupnirHelpCommand, ["help"])
  .internCommand(DraupnirInfoCommand, ["info"])
  .internCommand(DraupnirImportCommand, ["import"])
  .internCommand(DraupnirKickCommand, ["kicks"])
  // ── Shortcut: !kick <localpart|@user:server> ─────────────────────────────
  // Replaces DraupnirKickCommand. Kicks from every protected room the user
  // is currently joined in (not just a single room).
  .internCommand(ShortcutKickCommand, ["kick"])
  .internCommand(DraupnirPolicyRemoveCommand, ["policy", "remove"])
  .internCommand(DraupnirListProtectionsCommand, ["protections"])
  .internCommand(DraupnirProtectionsCapabilityCommand, [
    "protections",
    "capability",
  ])
  .internCommand(DraupnirProtectionsCapabilityResetCommand, [
    "protections",
    "capability",
    "reset",
  ])
  .internCommand(DraupnirProtectionsEnableCommand, ["protections", "enable"])
  .internCommand(DraupnirProtectionsDisableCommand, ["protections", "disable"])
  .internCommand(DraupnirProtectionsConfigAddCommand, [
    "protections",
    "config",
    "add",
  ])
  .internCommand(DraupnirProtectionsConfigRemoveCommand, [
    "protections",
    "config",
    "remove",
  ])
  .internCommand(DraupnirProtectionsConfigSetCommand, [
    "protections",
    "config",
    "set",
  ])
  .internCommand(DraupnirProtectionsConfigResetCommand, [
    "protections",
    "config",
    "reset",
  ])
  .internCommand(DraupnirProtectionsShowCommand, ["protections", "show"])
  // ── Shortcut: !red <localpart|@user:server> ──────────────────────────────
  // Short alias for !redact that also expands bare localparts. The original
  // !redact command is kept below for backward compatibility (it additionally
  // supports event references and --limit / --room keywords).
  .internCommand(ShortcutRedCommand, ["red"])
  .internCommand(DraupnirRedactCommand, ["redact"])
  .internCommand(DraupnirResolveAliasCommand, ["resolve"])
  .internCommand(DraupnirListProtectedRoomsCommand, ["rooms"])
  .internCommand(DraupnirRoomsAddCommand, ["rooms", "add"])
  .internCommand(DraupnirRoomsRemoveCommand, ["rooms", "remove"])
  .internCommand(DraupnirClearRoomBansCommand, ["rooms", "clear-bans"])
  .internCommand(DraupnirListRulesCommand, ["rules"])
  .internCommand(DraupnirRulesMatchingCommand, ["rules", "matching"])
  .internCommand(DraupnirRulesMatchingMembersCommand, [
    "rules",
    "matching",
    "members",
  ])
  .internCommand(DraupnirSafeModeCommand, ["safe", "mode"])
  .internCommand(DraupnirDisplaynameCommand, ["displayname"])
  .internCommand(DraupnirSetPowerLevelCommand, ["powerlevel"])
  .internCommand(DraupnirStatusCommand, ["status"])
  .internCommand(DraupnirTakedownCommand, ["takedown"])
  .internCommand(DraupnirUnbanCommand, ["unban"])
  // ── Shortcut: !uban <localpart|@user:server> ─────────────────────────────
  // Replaces DraupnirUnbanCommand. Skips the confirmation preview and always
  // runs with --no-confirm semantics.
  .internCommand(ShortcutUnbanCommand, ["uban"])
  .internCommand(DraupnirWatchPolicyRoomCommand, ["watch"])
  .internCommand(DraupnirUnwatchPolicyRoomCommand, ["unwatch"])
  // ── Shortcut: !auto add|del|list ─────────────────────────────────────────
  .internCommand(ShortcutAutoListCommand, ["auto"])
  .internCommand(ShortcutAutoAddCommand, ["auto", "add"])
  .internCommand(ShortcutAutoDelCommand, ["auto", "del"])
  // ── Shortcut: !white add|del|list ────────────────────────────────────────
  .internCommand(ShortcutWhiteListCommand, ["white"])
  .internCommand(ShortcutWhiteAddCommand, ["white", "add"])
  .internCommand(ShortcutWhiteDelCommand, ["white", "del"])
  // ── Shortcut: !limit local|display ───────────────────────────────────────
  .internCommand(ShortcutLimitLocalCommand, ["limit", "local"])
  .internCommand(ShortcutLimitDisplayCommand, ["limit", "display"]);

DraupnirCommands.importTable(SynapseAdminCommands, []);
DraupnirTopLevelCommands.importTable(DraupnirCommands, ["draupnir"]);
DraupnirTopLevelCommands.importTable(JoinWaveCommandTable, [
  "draupnir",
  "joinwave",
]);
