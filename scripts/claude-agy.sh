#!/usr/bin/env bash
set -euo pipefail
config="${XDG_CONFIG_HOME:-$HOME/.config}/agy-local-proxy/client.env"
if [[ ! -f "$config" ]]; then
  printf 'Missing local proxy config: %s\n' "$config" >&2
  exit 1
fi
source "$config"
unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
export ANTHROPIC_BASE_URL ANTHROPIC_API_KEY
export ANTHROPIC_MODEL="${AGY_MODEL:-gemini-3.8-flash-low}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_MODEL"
export CLAUDE_CODE_SUBAGENT_MODEL="$ANTHROPIC_MODEL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_PROMPT_CACHING=1
export MAX_THINKING_TOKENS=0
exec claude --bare --tools default --model "$ANTHROPIC_MODEL" --permission-mode default "$@"
