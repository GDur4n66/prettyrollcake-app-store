package main

import (
	"fmt"
	"strconv"
)

// parseExpiryBuffer reads LNPROXY_EXPIRY_BUFFER (seconds). An empty value keeps the flag's value.
// The buffer must be at least the payment timeout: the relay needs that long to pay the
// original invoice after the wrapped one is paid.
func parseExpiryBuffer(env string, flagValue, paymentTimeout, maxExpiry uint64) (uint64, error) {
	v := flagValue
	if env != "" {
		n, err := strconv.ParseUint(env, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("LNPROXY_EXPIRY_BUFFER must be a nonnegative integer (seconds)")
		}
		v = n
	}
	if v < paymentTimeout {
		return 0, fmt.Errorf("expiry buffer must be at least the payment timeout (%d seconds)", paymentTimeout)
	}
	if v >= maxExpiry {
		return 0, fmt.Errorf("expiry buffer must be less than %d seconds", maxExpiry)
	}
	return v, nil
}
