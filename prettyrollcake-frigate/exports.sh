#!/bin/sh

# Docker preserves the host group ownership of /dev/dri/renderD128. Add that
# numeric group to Frigate's non-root user so it can open the Intel GPU device.
export APP_FRIGATE_RENDER_GID="$(stat -c '%g' /dev/dri/renderD128 2>/dev/null || echo 109)"
