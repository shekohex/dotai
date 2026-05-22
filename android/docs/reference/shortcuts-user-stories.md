# Shortcuts User Stories

## References

- `docs/reference/shortcuts-01-overview.png`
- `docs/reference/shortcuts-02-terminal-keys.png`
- `docs/reference/shortcuts-03-application-keys.png`
- `docs/reference/shortcuts-04-add-command-start.png`
- `docs/reference/shortcuts-05-add-command-filled.png`
- `docs/reference/shortcuts-06-add-command-key.png`
- `docs/reference/shortcuts-07-action-start.png`
- `docs/reference/shortcuts-08-action-select.png`
- `docs/reference/shortcuts-09-action-key.png`
- `docs/reference/shortcuts-10-search.png`

## Extracted Features

- Shortcuts page shows usage guidance: long-press `Ctrl` opens shortcuts bar, tap `Ctrl` closes it.
- Shortcuts page includes live toolbar preview with base toolbar buttons and optional expanded shortcuts panel.
- Panel tabs can be active or inactive.
- Active panel tabs can be hidden with minus button.
- Inactive panel tabs can be shown with plus button.
- Panel tabs can be reordered with drag handle.
- Panel tab row opens configuration for that tab.
- Default panel tabs include `Favorites`, `Tmux`, `Ctrl`, `Pi`.
- Tab rows show icon, title, shortcut count, active/inactive state, and drag affordance where reorderable.
- Settings include `Hide Title on Tabs` toggle.
- Settings include `Show Uploads Panel` toggle.
- Shortcuts page supports reset to defaults.
- Per-tab detail page has active shortcuts section.
- Per-tab detail page has inactive shortcuts section when disabled shortcuts exist.
- Shortcut row shows terminal sequence or command as primary text.
- Shortcut row shows hint/action label as secondary text.
- Active shortcut rows can be disabled with minus button.
- Inactive shortcut rows can be enabled with plus button.
- Inactive custom shortcut rows can be deleted with trash button.
- Shortcut rows can be reordered with drag handle.
- Tapping shortcut row edits it.
- Per-tab detail page supports add shortcut.
- Per-tab detail page supports reset that tab to defaults.
- Empty active state shows `No active shortcuts`.
- New shortcut editor shows preview field at top.
- New shortcut editor supports modifier toggles: `Ctrl`, `Opt`, `Shift`.
- New shortcut editor supports special keys: `Esc`, `Tab`, `Enter`, `Backspace`, arrows, `Home`, `End`, `PgUp`, `PgDn`.
- New shortcut editor supports custom key/text/command entry.
- New shortcut editor supports optional hint label.
- Save button disabled until shortcut has valid sequence/text.
- Tmux tab has settings for prefix key: `Ctrl+B`, `Ctrl+A`, `Ctrl+Space`.
- Tmux tab shows effective prefix preview, e.g. `^ b`.
- Tmux tab has `Start window from 1` toggle.
- Tmux default shortcuts include `new win`, `next`, `prev`, `detach`, `windows`, `zoom`, `kill`, `last`.
- Pi default shortcuts should be derived from local Pi coding agent commands in `../agent`, including `/gsd:new-project`, `/gsd:new-milestone`, `/gsd:plan-phase`, `/gsd:execute-phase`, `/gsd:validate-phase`, `/gsd:secure-phase`, `/gsd:verify-work`, `/gsd:complete-milestone`, `/gsd:milestone-summary`, `/gsd:progress`, `/gsd:debug`, `/plannotator-review`, `/plannotator-annotate`, `/plannotator-archive`, and `/plannotator-last`.
- Keyboard page includes hardware keyboard section with `Auto-hide Toolbar` toggle.
- Keyboard page includes application-level shortcuts: show shortcuts, switch session, open switcher, new connection, close session, paste.
- Keyboard page displays shortcut chords as keycaps.
- Keyboard page includes `Option as Meta` toggle.
- Application actions are separate from terminal-send shortcuts.

## User Stories

1. As terminal user, I want long-pressing `Ctrl` to open shortcuts panel, so I can reach frequent commands without leaving terminal.

2. As terminal user, I want tapping `Ctrl` to close shortcuts panel, so panel does not block terminal when done.

3. As terminal user, I want tapping a shortcut to send it and hide shortcuts panel, so I can continue working in terminal immediately.

4. As terminal user, I want visible preview of toolbar and expanded panel inside settings, so I understand how configuration affects terminal UI before returning.

5. As terminal user, I want enable/disable built-in shortcut tabs, so toolbar contains only tools I use.

6. As terminal user, I want reorder panel tabs, so most used tabs appear first.

7. As terminal user, I want reset all shortcuts to defaults, so I can recover from bad customization.

8. As terminal user, I want hide tab titles and show icons only, so shortcut panel uses less horizontal space.

9. As terminal user, I want show or hide uploads panel, so upload entry point matches my workflow.

10. As terminal user, I want open a tab configuration page, so I can manage shortcuts inside one logical group.

11. As terminal user, I want active and inactive shortcut sections, so I can disable shortcuts without deleting them.

12. As terminal user, I want enable disabled shortcuts with plus, so I can restore them quickly.

13. As terminal user, I want disable active shortcuts with minus, so I can simplify panel without losing defaults.

14. As terminal user, I want delete inactive custom shortcuts, so stale personal shortcuts can be removed.

15. As terminal user, I want reorder shortcuts inside a tab, so common commands are easiest to tap.

16. As terminal user, I want tap shortcut row to edit it, so correction path is discoverable.

17. As terminal user, I want add command shortcuts, so commands like `/gsd:progress` or `/plannotator-review` can be sent to terminal with one tap.

18. As terminal user, I want add key-sequence shortcuts, so sequences like `Ctrl+B, C` or `Shift+Tab` work reliably.

19. As terminal user, I want shortcut preview while editing, so I can confirm exact label/sequence before saving.

20. As terminal user, I want choose modifiers and special keys visually, so shortcut creation works without hardware keyboard.

21. As terminal user, I want enter custom text/command manually, so app supports tools beyond built-in presets.

22. As terminal user, I want optional hint text, so compact buttons can still communicate intent.

23. As terminal user, I want invalid shortcut save disabled, so empty broken shortcuts cannot be created.

24. As tmux user, I want configure tmux prefix, so built-in tmux shortcuts match my `.tmux.conf`.

25. As tmux user, I want `Start window from 1` setting, so tmux window buttons match my numbering preference.

26. As tmux user, I want built-in tmux actions, so common window/session operations are available immediately.

27. As Pi user, I want built-in Pi coding agent commands from `../agent`, so GSD and Plannotator workflows are one tap away.

28. As Pi user, I want Pi shortcuts refreshed from local command inventory during development, so shortcut defaults match bundled agent commands.

29. As terminal user, I want only `Favorites`, `Tmux`, `Ctrl`, and `Pi` default tabs, so shortcuts stay focused and not agent-specific noise.

30. As hardware keyboard user, I want application shortcuts listed in keyboard settings, so I can learn global navigation chords.

31. As hardware keyboard user, I want app shortcuts to trigger app actions like switch session or new connection, so keyboard use is efficient.

32. As hardware keyboard user, I want terminal key input and app shortcuts separated, so commands do not accidentally go to wrong target.

33. As hardware keyboard user, I want `Option as Meta`, so terminal apps can receive expected Alt/Meta sequences.

34. As hardware keyboard user, I want auto-hide toolbar, so physical keyboard sessions have more terminal space.

35. As terminal user, I want paste shortcut to handle text or image, so clipboard workflow is consistent.

36. As terminal user, I want shortcuts engine to send bytes/key events to active terminal, so custom shortcuts behave same as physical keys.

37. As app user, I want shortcuts engine to run app actions separately from terminal sends, so shortcuts can open switcher, close session, or create connection.

## Implementation Implications

- Replace flat `TerminalShortcut(label, sequence)` storage with grouped shortcut model.
- Model shortcut target as terminal text, terminal key sequence, or app action.
- Persist active/inactive state per tab and per shortcut.
- Persist order per tab and shortcut.
- Keep defaults versioned so reset and future migrations are safe.
- Add shortcut execution layer that accepts shortcut target and dispatches to terminal or app action.
- Add hardware keyboard action registry separate from terminal input path.
- Preserve current toolbar custom shortcuts through migration into `Favorites`.
