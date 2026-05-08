# transition workflow

Purpose:

- internal verify-work happy-path completion transition after UAT and security are clear

Core flow:

1. Reconfirm zero unresolved UAT items.
2. Confirm security gate clear.
3. Invoke existing helper: `node "$GSD_TOOLS_PATH" phase complete "<phase>"`.
4. Report phase transition outcome and next recommended command.
