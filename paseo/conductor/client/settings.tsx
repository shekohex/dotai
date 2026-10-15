/** Conductor's own settings page: check-ins for quiet agents and blocker escalation. */
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";

import { conductorSettings } from "../shared/settings.js";

const MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const ESCALATE_MINUTES = [2, 5, 10, 15, 20, 30, 60];

export function ConductorSettingsScreen() {
  const settings = useSettings(conductorSettings);
  if (settings.status !== "ready") return null;
  const { values, revision } = settings;
  const save = (patch: Partial<typeof values>) =>
    void settings.save({ ...values, ...patch }, revision);
  return (
    <SettingsSection
      title="Progress check-ins and blockers"
      info="When an agent's working ticket goes quiet, the plugin sends it a short note asking for a progress update. At most three per quiet spell; any update starts over."
    >
      <SettingsCard>
        <SettingsSwitch
          label="Check in on quiet agents"
          hint={
            values.checkIns
              ? "Agents get a short reminder they don't show in the chat"
              : "No reminders"
          }
          value={values.checkIns}
          onValueChange={(checkIns) => save({ checkIns })}
        />
        <SettingsSelect
          label="After"
          hint="Minutes without a progress update, and between reminders"
          value={String(values.checkInMinutes)}
          options={MINUTES.map((minutes) => ({
            label: `${minutes} minutes`,
            value: String(minutes),
          }))}
          onValueChange={(value) => save({ checkInMinutes: Number(value) })}
          disabled={!values.checkIns}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsSwitch
          label="Tell the conductor about blockers"
          hint={
            values.escalate
              ? "When a ticket stays blocked or stuck, the conductor decides: answer, unblock, reassign, or leave it for you. Not for questions waiting on you."
              : "Blockers wait for you"
          }
          value={values.escalate}
          onValueChange={(escalate) => save({ escalate })}
        />
        <SettingsSelect
          label="After"
          hint="Minutes blocked; repeats every 30 minutes, three times at most"
          value={String(values.escalateMinutes)}
          options={ESCALATE_MINUTES.map((minutes) => ({
            label: `${minutes} minutes`,
            value: String(minutes),
          }))}
          onValueChange={(value) => save({ escalateMinutes: Number(value) })}
          disabled={!values.escalate}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
