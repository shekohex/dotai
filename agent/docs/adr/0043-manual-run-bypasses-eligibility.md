# Manual run bypasses eligibility

`pi conductor run` is an explicit operator dispatch and will bypass automated eligibility rules such as open issue state, dispatch label, and assignment to the authenticated `gh` user. It still requires the repository/project to be managed by conductor configuration.
