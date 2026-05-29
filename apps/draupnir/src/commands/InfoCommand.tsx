// SPDX-FileCopyrightText: 2025 Your Name <your@email.com>
//
// SPDX-License-Identifier: AFL-3.0

import { Ok } from "matrix-protection-suite";
import {
  DeadDocumentJSX,
  describeCommand,
} from "@the-draupnir-project/interface-manager";
import { DraupnirInterfaceAdaptor } from "./DraupnirCommandPrerequisites";

export const DraupnirInfoCommand = describeCommand({
  summary: "Display a summary of available commands for this bot.",
  parameters: [],
  async executor() {
    return Ok(undefined);
  },
});

DraupnirInterfaceAdaptor.describeRenderer(DraupnirInfoCommand, {
  JSXRenderer() {
    return Ok(
      <root>
        <details>
          <summary>
            <b>🛡️ Draupnir — Command Reference</b>
          </summary>
          <br />
          <b>Quick Actions</b>
          <br />
          <code>!ban &lt;user&gt;</code> — Add to policy list with reason{" "}
          <code>---</code> (also triggers redactions). Localpart auto-expands to{" "}
          <code>@user:matrix.org</code>.
          <br />
          <code>!uban &lt;user&gt;</code> — Remove all policy rules and unban
          from all rooms. No confirmation prompt.
          <br />
          <code>!kick &lt;user&gt;</code> — Kick from every protected room the
          user is currently in.
          <br />
          <code>!red &lt;user&gt;</code> — Redact all recent messages without
          banning.
          <br />
          <br />
          <b>Auto-Action Patterns</b>
          <br />
          <code>!auto</code> — List all configured auto-action regex patterns.
          <br />
          <code>!auto add pattern</code> — Add a regex tested against MXID and
          display name on every join. Case-insensitive. Plain strings do
          substring matching.
          <br />
          <code>!auto del pattern</code> — Remove an existing pattern (must
          match exactly).
          <br />
          <br />
          <b>Whitelist</b>
          <br />
          <code>!white</code> — List all whitelisted users.
          <br />
          <code>!white add &lt;user&gt;</code> — Exempt a user from join alerts
          and auto-actions. They will still produce a brief notification when
          joining. Bare localparts expand to <code>@user:matrix.org</code>.
          <br />
          <code>!white del &lt;user&gt;</code> — Remove a user from the
          whitelist. Bare localparts expand to <code>@user:matrix.org</code>{" "}
          only.
          <br />
          <br />
          <b>Length Limits</b>
          <br />
          <code>!limit local &lt;n&gt;</code> — Auto-act on users whose MXID
          local part exceeds <code>n</code> characters. <code>0</code> =
          disabled.
          <br />
          <code>!limit display &lt;n&gt;</code> — Auto-act on users whose
          display name exceeds <code>n</code> characters. <code>0</code> =
          disabled.
          <br />
          <br />
          <b>Rooms</b>
          <br />
          <code>!rooms</code> — List all protected rooms.
          <br />
          <code>!rooms clear-bans &lt;room&gt;</code> — Preview room-level bans
          in a room and remove them after confirmation.
          <br />
          <code>!rooms clear-bans everything</code> — Same for all protected
          rooms at once.
          <br />
          <br />
          <b>Rules &amp; Protections</b>
          <br />
          <code>!rules</code> — List all active policy rules.
          <br />
          <code>!protections</code> — List all protections and their
          enabled/disabled state.
          <br />
          <code>!protections show &lt;name&gt;</code> — Show current config for
          a protection.
          <br />
          <br />
          <b>Protection Configuration</b>
          <br />
          <code>
            !protections config set JoinAlertProtection kickInsteadOfBan
            true|false
          </code>{" "}
          — Switch between kicking (temporary) and banning (permanent + policy
          list) for all actions.
          <br />
          <br />
          <b>How it works</b>
          <br />
          When a user joins, an alert is posted here with Ban / Ignore buttons —
          unless a policy rule already exists for them, in which case{" "}
          <code>BanSync</code> handles the ban silently.
          <br />
          Manual client bans are automatically added to the policy list and
          propagated to all rooms.
          <br />
          Banning with reason <code>---</code> also triggers automatic message
          redactions across all rooms.
        </details>
      </root>
    );
  },
});
