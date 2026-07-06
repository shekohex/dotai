# PR watcher routes all actionable feedback

Pi Conductor's v1 PR watcher will route all new GitHub feedback comments back to the owning Pi session, including review bodies, inline review comments, PR comments, issue comments, and mentions. Failed checks and requested-change decisions are also routed. V1 does not try to classify comment actionability, but it ignores comments authored by conductor/Pi and comments carrying conductor markers to avoid loops.
