# Remote Bitcoin: export the same APP_BITCOIN_* variables as the Bitcoin Node app.
# The address and ports point at this app's relay (fixed IP and ports), which
# forwards each connection to the bitcoind on another host set in the web UI.
# The network and RPC credentials come from data/settings.json.
export APP_REMOTE_BITCOIN_IP="10.21.114.21"

EXPORTS_REMOTE_BITCOIN_DATA_ROOT="${EXPORTS_APP_DATA_DIR:-${EXPORTS_APP_DIR}/data}"
EXPORTS_REMOTE_BITCOIN_SETTINGS="${EXPORTS_REMOTE_BITCOIN_DATA_ROOT}/settings.json"

# Defaults (used until the settings are saved in the web UI)
remote_bitcoin_network="mainnet"
remote_bitcoin_rpc_user="notconfigured"
remote_bitcoin_rpc_pass="notconfigured"

remote_bitcoin_read() {
	local value
	value="$(jq -r --arg k "$1" '.[$k] // empty | tostring' "${EXPORTS_REMOTE_BITCOIN_SETTINGS}" 2>/dev/null)" || return 0
	if [[ -n "${value}" ]]; then
		printf '%s' "${value}"
	fi
}

if [[ -f "${EXPORTS_REMOTE_BITCOIN_SETTINGS}" ]]; then
	v="$(remote_bitcoin_read network)" && [[ -n "${v}" ]] && remote_bitcoin_network="${v}"
	v="$(remote_bitcoin_read rpcUser)" && [[ -n "${v}" ]] && remote_bitcoin_rpc_user="${v}"
	v="$(remote_bitcoin_read rpcPass)" && [[ -n "${v}" ]] && remote_bitcoin_rpc_pass="${v}"
	unset v
else
	echo "Warning (${EXPORTS_APP_ID}): Remote Bitcoin is not configured yet. Open the Remote Bitcoin app to set it up." >&2
fi

case "${remote_bitcoin_network}" in
	mainnet|testnet|testnet4|signet|regtest) ;;
	*)
		echo "Warning (${EXPORTS_APP_ID}): Invalid network '${remote_bitcoin_network}'. Using 'mainnet'." >&2
		remote_bitcoin_network="mainnet";;
esac

# Relay ports are fixed; the remote ports are set in the web UI
export APP_BITCOIN_NODE_IP="${APP_REMOTE_BITCOIN_IP}"
export APP_BITCOIN_NETWORK="${remote_bitcoin_network}"
export APP_BITCOIN_RPC_PORT="8332"
export APP_BITCOIN_RPC_USER="${remote_bitcoin_rpc_user}"
export APP_BITCOIN_RPC_PASS="${remote_bitcoin_rpc_pass}"
export APP_BITCOIN_P2P_PORT="8333"
export APP_BITCOIN_ZMQ_RAWBLOCK_PORT="28332"
export APP_BITCOIN_ZMQ_RAWTX_PORT="28333"
export APP_BITCOIN_ZMQ_HASHBLOCK_PORT="28334"
export APP_BITCOIN_ZMQ_SEQUENCE_PORT="28335"
export APP_BITCOIN_ZMQ_HASHTX_PORT="28336"

# Stand-in for the bitcoind data directory. It holds only an RPC cookie file,
# because some apps (Electrs) authenticate by reading <datadir>/.cookie
# instead of taking a user name and password.
export APP_BITCOIN_DATA_DIR="${EXPORTS_REMOTE_BITCOIN_DATA_ROOT}/bitcoin"
{
	if [[ -f "${EXPORTS_REMOTE_BITCOIN_SETTINGS}" ]]; then
		case "${remote_bitcoin_network}" in
			mainnet) remote_bitcoin_cookie_dir="${APP_BITCOIN_DATA_DIR}";;
			testnet) remote_bitcoin_cookie_dir="${APP_BITCOIN_DATA_DIR}/testnet3";;
			*) remote_bitcoin_cookie_dir="${APP_BITCOIN_DATA_DIR}/${remote_bitcoin_network}";;
		esac
		remote_bitcoin_cookie="${remote_bitcoin_cookie_dir}/.cookie"
		remote_bitcoin_cookie_value="${remote_bitcoin_rpc_user}:${remote_bitcoin_rpc_pass}"
		if [[ ! -f "${remote_bitcoin_cookie}" ]] || [[ "$(cat "${remote_bitcoin_cookie}")" != "${remote_bitcoin_cookie_value}" ]]; then
			mkdir -p "${remote_bitcoin_cookie_dir}"
			(umask 077 && printf '%s' "${remote_bitcoin_cookie_value}" > "${remote_bitcoin_cookie}.tmp")
			# Apps that read the cookie (Electrs) run as uid 1000
			chown 1000:1000 "${APP_BITCOIN_DATA_DIR}" "${remote_bitcoin_cookie_dir}" "${remote_bitcoin_cookie}.tmp" 2>/dev/null || true
			mv -f "${remote_bitcoin_cookie}.tmp" "${remote_bitcoin_cookie}"
		fi
	fi
} || echo "Warning (${EXPORTS_APP_ID}): Could not write the RPC cookie file for Electrs." >&2
unset remote_bitcoin_cookie_dir remote_bitcoin_cookie remote_bitcoin_cookie_value

# Not available for a remote node; keep the same names as the Bitcoin Node app
export APP_BITCOIN_IPC_ENABLED="false"
export APP_BITCOIN_IPC_SOCKET_RELATIVE_PATH="node.sock"
export APP_BITCOIN_RPC_HIDDEN_SERVICE="notyetset.onion"
export APP_BITCOIN_P2P_HIDDEN_SERVICE="notyetset.onion"

export APP_BITCOIN_NETWORK_ELECTRS="${APP_BITCOIN_NETWORK}"
if [[ "${APP_BITCOIN_NETWORK_ELECTRS}" = "mainnet" ]]; then
	APP_BITCOIN_NETWORK_ELECTRS="bitcoin"
fi

unset -f remote_bitcoin_read
unset remote_bitcoin_network remote_bitcoin_rpc_user remote_bitcoin_rpc_pass \
	EXPORTS_REMOTE_BITCOIN_DATA_ROOT EXPORTS_REMOTE_BITCOIN_SETTINGS
