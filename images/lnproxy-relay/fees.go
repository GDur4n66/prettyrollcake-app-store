package relay

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// FeeSettings are the fee parameters that can be changed while the relay runs.
type FeeSettings struct {
	// The relay's own fee: base + amount * ppm / 1e6.
	RoutingFeeBaseMsat uint64 `json:"routing_fee_base_msat"`
	RoutingFeePPM      uint64 `json:"routing_fee_ppm"`
	// The routing budget passed to lnd as fee_limit_msat:
	// estimate + alpha + estimate * beta / 1e6.
	RoutingBudgetAlpha uint64 `json:"routing_budget_alpha_msat"`
	RoutingBudgetBeta  uint64 `json:"routing_budget_beta_ppm"`
	// The smallest budget a client may ask for with routing_msat.
	MinFeeBudgetMsat uint64 `json:"min_fee_budget_msat"`
}

// Upper limits keep the arithmetic far from overflow and catch typos
// (e.g. a value in msat entered where sat was meant).
const (
	MaxFeeMsat = 100_000_000 // 100,000 sat
	MaxFeePPM  = 1_000_000   // 100 %
	MaxBetaPPM = 100_000_000 // 10,000 %
)

func (f FeeSettings) Validate() error {
	var errs error
	check := func(name string, value, max uint64) {
		if value > max {
			errs = errors.Join(errs, fmt.Errorf("%s must be at most %d", name, max))
		}
	}
	check("routing_fee_base_msat", f.RoutingFeeBaseMsat, MaxFeeMsat)
	check("routing_fee_ppm", f.RoutingFeePPM, MaxFeePPM)
	check("routing_budget_alpha_msat", f.RoutingBudgetAlpha, MaxFeeMsat)
	check("routing_budget_beta_ppm", f.RoutingBudgetBeta, MaxBetaPPM)
	check("min_fee_budget_msat", f.MinFeeBudgetMsat, MaxFeeMsat)
	return errs
}

// Fees returns the fee settings in effect.
func (relay *Relay) Fees() FeeSettings {
	relay.feeMu.RLock()
	defer relay.feeMu.RUnlock()
	return FeeSettings{
		RoutingFeeBaseMsat: relay.RoutingFeeBaseMsat,
		RoutingFeePPM:      relay.RoutingFeePPM,
		RoutingBudgetAlpha: relay.RoutingBudgetAlpha,
		RoutingBudgetBeta:  relay.RoutingBudgetBeta,
		MinFeeBudgetMsat:   relay.MinFeeBudgetMsat,
	}
}

// SetFees changes the fees for invoices wrapped from now on. Invoices already
// wrapped keep the budget they were created with.
func (relay *Relay) SetFees(f FeeSettings) error {
	if err := f.Validate(); err != nil {
		return err
	}
	relay.feeMu.Lock()
	defer relay.feeMu.Unlock()
	relay.RoutingFeeBaseMsat = f.RoutingFeeBaseMsat
	relay.RoutingFeePPM = f.RoutingFeePPM
	relay.RoutingBudgetAlpha = f.RoutingBudgetAlpha
	relay.RoutingBudgetBeta = f.RoutingBudgetBeta
	relay.MinFeeBudgetMsat = f.MinFeeBudgetMsat
	return nil
}

const feeSettingsKey = "fees"

// SavedFees returns the fees saved from the status page, if any.
func (s *EventStore) SavedFees() (FeeSettings, bool, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, feeSettingsKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return FeeSettings{}, false, nil
	} else if err != nil {
		return FeeSettings{}, false, err
	}
	var f FeeSettings
	if err := json.Unmarshal([]byte(value), &f); err != nil {
		return FeeSettings{}, false, fmt.Errorf("saved fees: %w", err)
	}
	return f, true, nil
}

func (s *EventStore) SaveFees(f FeeSettings, now time.Time) error {
	value, err := json.Marshal(f)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		feeSettingsKey, string(value), now.Unix())
	return err
}

func (s *EventStore) ClearFees() error {
	_, err := s.db.Exec(`DELETE FROM settings WHERE key = ?`, feeSettingsKey)
	return err
}
