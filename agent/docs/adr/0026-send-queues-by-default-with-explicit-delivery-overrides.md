# Send uses Pi delivery modes

`pi conductor send <run> <message>` will deliver to Pi using the same delivery modes as the subagent SDK: steering uses Enter and follow-up uses Alt+Enter. Manual sends default to steering, while `--follow-up` uses Pi's queued follow-up mode. Automated CI and review follow-ups use follow-up delivery by default. Pi owns in-session message queueing and turn timing; conductor should persist delivery attempts and failures, not duplicate Pi's queue for normal live sessions.
