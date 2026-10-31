# Remote Bitcoin: export the same APP_BITCOIN_* variables as the Bitcoin Node app,
# but pointing at a bitcoind on another host. Values come from data/settings.json,
# which the app's web UI writes.

EXPORTS_REMOTE_BITCOIN_DATA_ROOT="${EXPORTS_APP_DATA_DIR:-${EXPORTS_APP_DIR}/data}"
EXPORTS_REMOTE_BITCOIN_SETTINGS="${EXPORTS_REMOTE_BITCOIN_DATA_ROOT}/settings.json"

# Defaults (used until the settings are saved in the web UI)
remote_bitcoin_host="remote-bitcoin-not-configured.invalid"
remote_bitcoin_network="mainnet"
remote_bitcoin_rpc_port="8332"
remote_bitcoin_rpc_user="notconfigured"
remote_bitcoin_rpc_pass="notconfigured"
remote_bitcoin_p2p_port="8333"
remote_bitcoin_zmq_rawblock_port="28332"
remote_bitcoin_zmq_rawtx_port="28333"
remote_bitcoin_zmq_hashblock_port="28334"
remote_bitcoin_zmq_sequence_port="28335"
remote_bitcoin_zmq_hashtx_port="28336"

remote_bitcoin_read() {
	local value
	value="$(jq -r --arg k "$1" '.[$k] // empty | tostring' "${EXPORTS_REMOTE_BITCOIN_SETTINGS}" 2>/dev/null)" || return 0
	if [[ -n "${value}" ]]; then
		printf '%s' "${value}"
	fi
}

if [[ -f "${EXPORTS_REMOTE_BITCOIN_SETTINGS}" ]]; then
	v="$(remote_bitcoin_read host)" && [[ -n "${v}" ]] && remote_bitcoin_host="${v}"
	v="$(remote_bitcoin_read network)" && [[ -n "${v}" ]] && remote_bitcoin_network="${v}"
	v="$(remote_bitcoin_read rpcPort)" && [[ -n "${v}" ]] && remote_bitcoin_rpc_port="${v}"
	v="$(remote_bitcoin_read rpcUser)" && [[ -n "${v}" ]] && remote_bitcoin_rpc_user="${v}"
	v="$(remote_bitcoin_read rpcPass)" && [[ -n "${v}" ]] && remote_bitcoin_rpc_pass="${v}"
	v="$(remote_bitcoin_read p2pPort)" && [[ -n "${v}" ]] && remote_bitcoin_p2p_port="${v}"
	v="$(remote_bitcoin_read zmqRawBlockPort)" && [[ -n "${v}" ]] && remote_bitcoin_zmq_rawblock_port="${v}"
	v="$(remote_bitcoin_read zmqRawTxPort)" && [[ -n "${v}" ]] && remote_bitcoin_zmq_rawtx_port="${v}"
	v="$(remote_bitcoin_read zmqHashBlockPort)" && [[ -n "${v}" ]] && remote_bitcoin_zmq_hashblock_port="${v}"
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

export APP_BITCOIN_NODE_IP="${remote_bitcoin_host}"
export APP_BITCOIN_NETWORK="${remote_bitcoin_network}"
export APP_BITCOIN_RPC_PORT="${remote_bitcoin_rpc_port}"
export APP_BITCOIN_RPC_USER="${remote_bitcoin_rpc_user}"
export APP_BITCOIN_RPC_PASS="${remote_bitcoin_rpc_pass}"
export APP_BITCOIN_P2P_PORT="${remote_bitcoin_p2p_port}"
export APP_BITCOIN_ZMQ_RAWBLOCK_PORT="${remote_bitcoin_zmq_rawblock_port}"
export APP_BITCOIN_ZMQ_RAWTX_PORT="${remote_bitcoin_zmq_rawtx_port}"
export APP_BITCOIN_ZMQ_HASHBLOCK_PORT="${remote_bitcoin_zmq_hashblock_port}"
export APP_BITCOIN_ZMQ_SEQUENCE_PORT="${remote_bitcoin_zmq_sequence_port}"
export APP_BITCOIN_ZMQ_HASHTX_PORT="${remote_bitcoin_zmq_hashtx_port}"

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
unset remote_bitcoin_host remote_bitcoin_network remote_bitcoin_rpc_port remote_bitcoin_rpc_user \
	remote_bitcoin_rpc_pass remote_bitcoin_p2p_port remote_bitcoin_zmq_rawblock_port \
	remote_bitcoin_zmq_rawtx_port remote_bitcoin_zmq_hashblock_port remote_bitcoin_zmq_sequence_port \
	remote_bitcoin_zmq_hashtx_port EXPORTS_REMOTE_BITCOIN_DATA_ROOT EXPORTS_REMOTE_BITCOIN_SETTINGS
