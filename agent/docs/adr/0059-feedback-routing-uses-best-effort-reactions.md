# Feedback routing uses best-effort reactions

When Conductor routes reactable GitHub feedback into a Pi session, it updates the feedback item with GitHub reactions as progress markers. Before delivery it adds `EYES` to show the item was seen. After successful delivery to Herdr, it adds `THUMBS_UP` as the handled marker and best-effort removes `EYES`.

GitHub's reactions API does not support a checkmark reaction, so `THUMBS_UP` is the closest supported handled marker. Reaction failures are recorded as run events and never fail reconciliation, feedback routing, or Herdr delivery.

Only feedback with a GitHub Reactable node id is eligible for reactions. Checks and synthetic feedback such as merge conflicts skip reaction updates.
