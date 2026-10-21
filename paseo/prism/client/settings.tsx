import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";

import { syntaxThemesRpc } from "../shared/contracts.js";
import { prismSettings } from "../shared/settings.js";
import { useAppAppearance } from "./appearance.js";
import { useSyncBuiltinHiding } from "./hide-builtins.js";
import { setBuiltinHiding } from "./web.js";

export function PrismSettingsScreen() {
  const settings = useSettings(prismSettings);
  useSyncBuiltinHiding();
  const appearance = useAppAppearance();
  const listThemes = useRpc(syntaxThemesRpc);
  const themes = useQuery({ queryKey: ["prism", "syntax-themes"], queryFn: () => listThemes({}), staleTime: Infinity });
  if (settings.status !== "ready") return null;
  const { values, revision } = settings;
  return (
    <SettingsSection title="Built-in panels">
      <SettingsCard>
        <SettingsSwitch
          label="Hide built-in Changes, Files, Diff and the composer chip"
          hint="Web and desktop only. Hides the built-in tabs and chip that Prism replaces. Use Command Center or the composer pill to open Prism."
          value={values.hideBuiltinPanels}
          onValueChange={(hideBuiltinPanels) => {
            setBuiltinHiding(hideBuiltinPanels);
            void settings.save({ ...values, hideBuiltinPanels }, revision);
          }}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsSelect
          label="Code theme"
          hint="Syntax colors in diffs. Auto picks the bundled theme that matches your Paseo theme, such as Catppuccin or Tokyo Night."
          value={values.syntaxTheme}
          options={[
            { label: "Auto (match Paseo theme)", value: "auto" },
            ...(themes.data?.themes ?? []).map((theme) => ({ label: theme.name, value: theme.name })),
          ]}
          onValueChange={(syntaxTheme) => void settings.save({ ...values, syntaxTheme }, revision)}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsRow
          label="Detected appearance"
          hint={`Code font: ${appearance.monoFontFamily || "Paseo default"}, ${appearance.codeFontSize}px. UI scale: ${appearance.uiScale.toFixed(2)}. Read from Paseo's settings on web and desktop; native uses Paseo's defaults.`}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
