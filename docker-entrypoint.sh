#!/bin/sh
# Set up Claude Code credentials for Agent SDK (if ANTHROPIC_API_KEY is set)
if [ -n "$ANTHROPIC_API_KEY" ]; then
  mkdir -p ~/.claude
  cat > ~/.claude/.credentials.json <<EOF
{"claudeAiOauth":{"accessToken":"$ANTHROPIC_API_KEY","expiresAt":"2099-01-01T00:00:00.000Z"}}
EOF
fi

exec node server.js
