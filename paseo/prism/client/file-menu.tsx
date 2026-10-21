import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text } from "react-native";

import type { FileActionId, FileMenuItem } from "./file-actions.js";

/** The long-press menu for a file row on touch layouts, where there is no right-click. */
export function FileMenuSheet({
  theme,
  title,
  items,
  onSelect,
  onClose,
}: {
  theme: PluginTheme;
  title: string;
  items: readonly FileMenuItem[];
  onSelect: (id: FileActionId) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              onSelect(item.id);
            }}
            style={{ paddingVertical: 12 }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 16 }}>{item.label}</Text>
          </Pressable>
        ))}
      </Modal.Content>
    </Modal>
  );
}
