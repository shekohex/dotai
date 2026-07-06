# Human project moves do not stop runs

Pi Conductor will not stop, pause, or roll back active runs because a human moved the GitHub Project card. Project status remains visible product state, while conductor run lifecycle is controlled by conductor commands and PR merge/recovery outcomes. Conductor may still write project status at its own lifecycle milestones such as claim, PR association, blocked, or done.
