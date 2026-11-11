# btcd: fixed addresses inside the Umbrel network
export APP_BTCD_IP="10.21.114.30"
export APP_BTCD_TOR_PROXY_IP="10.21.114.31"
export APP_BTCD_RPC_PORT="8334"
export APP_BTCD_P2P_PORT="8333"

# The onion address appears after the tor container has run once
btcd_p2p_hidden_service_file="${EXPORTS_TOR_DATA_DIR}/app-${EXPORTS_APP_ID}-p2p/hostname"
export APP_BTCD_P2P_HIDDEN_SERVICE="$(cat "${btcd_p2p_hidden_service_file}" 2>/dev/null || echo "notyetset.onion")"
unset btcd_p2p_hidden_service_file
