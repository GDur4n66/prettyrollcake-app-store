# Remote Electrum: export the same APP_ELECTRS_* variables as the Electrs app.
# They point at this app's relay, which forwards each connection to the
# Electrum server set in the web UI (data/settings.json).
export APP_REMOTE_ELECTRUM_IP="10.21.114.20"
export APP_REMOTE_ELECTRUM_RELAY_PORT="50001"

export APP_ELECTRS_IP="${APP_REMOTE_ELECTRUM_IP}"
export APP_ELECTRS_NODE_IP="${APP_REMOTE_ELECTRUM_IP}"
export APP_ELECTRS_NODE_PORT="${APP_REMOTE_ELECTRUM_RELAY_PORT}"
export APP_ELECTRS_RPC_HIDDEN_SERVICE="notyetset.onion"
