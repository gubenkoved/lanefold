#!/bin/sh
# Lanefold's askpass wrapper (GIT_ASKPASS / SSH_ASKPASS): runs the Node helper with the prompt.
ELECTRON_RUN_AS_NODE=1 exec "$LANEFOLD_NODE" "$LANEFOLD_ASKPASS_MAIN" "$@"
