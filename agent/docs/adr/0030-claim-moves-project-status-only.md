# Claim moves project status only

When Pi Conductor claims eligible work, it will move the mapped GitHub Project status to `in_progress` and create local run state. It will not add a claim comment by default, keeping GitHub comment noise low while the project card and local conductor state carry lifecycle status.
