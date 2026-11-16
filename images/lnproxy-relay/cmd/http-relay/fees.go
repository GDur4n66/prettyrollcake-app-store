package main

import (
	"flag"
	"fmt"
	"strconv"

	"github.com/lnproxy/lnproxy-relay"
)

type feeConfig struct {
	routingFeeBaseMsat uint64
	routingFeePPM      uint64
	routingBudgetAlpha uint64
	routingBudgetBeta  uint64
	minFeeBudgetMsat   uint64
}

type feeSetting struct {
	flagName string
	envName  string
	help     string
	value    *uint64
}

func (config *feeConfig) settings() []feeSetting {
	return []feeSetting{
		{"routing-fee-base-msat", "LNPROXY_ROUTING_FEE_BASE_MSAT", "relay's fixed fee in msat", &config.routingFeeBaseMsat},
		{"routing-fee-ppm", "LNPROXY_ROUTING_FEE_PPM", "relay's proportional fee in parts per million", &config.routingFeePPM},
		{"routing-budget-alpha", "LNPROXY_ROUTING_BUDGET_ALPHA", "fixed addition to estimated routing fee budget in msat", &config.routingBudgetAlpha},
		{"routing-budget-beta", "LNPROXY_ROUTING_BUDGET_BETA", "additional estimated routing fee multiplier in parts per million", &config.routingBudgetBeta},
		{"min-fee-budget-msat", "LNPROXY_MIN_FEE_BUDGET_MSAT", "minimum routing budget in msat when routing_msat is supplied", &config.minFeeBudgetMsat},
	}
}

func registerFeeFlags(flags *flag.FlagSet) *feeConfig {
	defaults := relay.NewRelay(nil)
	config := &feeConfig{
		routingFeeBaseMsat: defaults.RoutingFeeBaseMsat,
		routingFeePPM:      defaults.RoutingFeePPM,
		routingBudgetAlpha: defaults.RoutingBudgetAlpha,
		routingBudgetBeta:  defaults.RoutingBudgetBeta,
		minFeeBudgetMsat:   defaults.MinFeeBudgetMsat,
	}
	for _, setting := range config.settings() {
		flags.Uint64Var(setting.value, setting.flagName, *setting.value, setting.help+" (env: "+setting.envName+")")
	}
	return config
}

// A nonempty environment variable overrides its CLI flag, including explicit 0.
func (config *feeConfig) applyEnvironment(getenv func(string) string) error {
	for _, setting := range config.settings() {
		value := getenv(setting.envName)
		if value == "" {
			continue
		}
		parsed, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return fmt.Errorf("%s must be a nonnegative decimal uint64: %w", setting.envName, err)
		}
		*setting.value = parsed
	}
	return nil
}

func (config *feeConfig) apply(target *relay.Relay) {
	target.RoutingFeeBaseMsat = config.routingFeeBaseMsat
	target.RoutingFeePPM = config.routingFeePPM
	target.RoutingBudgetAlpha = config.routingBudgetAlpha
	target.RoutingBudgetBeta = config.routingBudgetBeta
	target.MinFeeBudgetMsat = config.minFeeBudgetMsat
}
