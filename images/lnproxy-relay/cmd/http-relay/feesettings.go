package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"mime"
	"net/http"
	"sync"
	"time"

	"github.com/lnproxy/lnproxy-relay"
)

// feeSettingsAPI serves /fees: GET shows the fees in effect, POST with the
// admin token changes them (saved in the database) or puts the startup values
// (flags, environment, built-in defaults) back.
//
// The admin token travels in the JSON body rather than a header so that it
// works the same behind Umbrel's app gateway. A cross-site page cannot send
// application/json without a CORS preflight, which this handler never grants.
type feeSettingsAPI struct {
	relay    *relay.Relay
	store    *relay.EventStore
	defaults relay.FeeSettings

	mu    sync.Mutex
	saved bool
}

type feeSettingsResponse struct {
	Fees          relay.FeeSettings `json:"fees"`
	Defaults      relay.FeeSettings `json:"defaults"`
	Saved         bool              `json:"saved"`
	AdminTokenSet bool              `json:"admin_token_set"`
}

// All five values are required so that a partial request cannot zero the rest.
type feeSettingsInput struct {
	RoutingFeeBaseMsat *uint64 `json:"routing_fee_base_msat"`
	RoutingFeePPM      *uint64 `json:"routing_fee_ppm"`
	RoutingBudgetAlpha *uint64 `json:"routing_budget_alpha_msat"`
	RoutingBudgetBeta  *uint64 `json:"routing_budget_beta_ppm"`
	MinFeeBudgetMsat   *uint64 `json:"min_fee_budget_msat"`
}

type feeSettingsRequest struct {
	AdminToken string            `json:"admin_token"`
	Fees       *feeSettingsInput `json:"fees"`
	Reset      bool              `json:"reset"`
}

func (in feeSettingsInput) settings() (relay.FeeSettings, error) {
	if in.RoutingFeeBaseMsat == nil || in.RoutingFeePPM == nil || in.RoutingBudgetAlpha == nil ||
		in.RoutingBudgetBeta == nil || in.MinFeeBudgetMsat == nil {
		return relay.FeeSettings{}, errors.New("all five fee values are required")
	}
	return relay.FeeSettings{
		RoutingFeeBaseMsat: *in.RoutingFeeBaseMsat,
		RoutingFeePPM:      *in.RoutingFeePPM,
		RoutingBudgetAlpha: *in.RoutingBudgetAlpha,
		RoutingBudgetBeta:  *in.RoutingBudgetBeta,
		MinFeeBudgetMsat:   *in.MinFeeBudgetMsat,
	}, nil
}

// current is also used by the status page.
func (api *feeSettingsAPI) current() (relay.FeeSettings, bool) {
	api.mu.Lock()
	defer api.mu.Unlock()
	return api.relay.Fees(), api.saved
}

func (api *feeSettingsAPI) response() feeSettingsResponse {
	fees, saved := api.current()
	return feeSettingsResponse{Fees: fees, Defaults: api.defaults, Saved: saved, AdminTokenSet: api.relay.AdminToken != ""}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (api *feeSettingsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		writeJSON(w, http.StatusOK, api.response())
	case http.MethodPost:
		api.post(w, r)
	default:
		w.Header().Set("Allow", "GET, HEAD, POST")
		writeJSON(w, http.StatusMethodNotAllowed, makeJsonError("method not allowed"))
	}
}

func (api *feeSettingsAPI) post(w http.ResponseWriter, r *http.Request) {
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, makeJsonError("content type must be application/json"))
		return
	}
	var req feeSettingsRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, makeJsonError("bad request"))
		return
	}
	if api.relay.AdminToken == "" {
		writeJSON(w, http.StatusForbidden, makeJsonError("admin token is not set (LNPROXY_ADMIN_TOKEN)"))
		return
	}
	if subtle.ConstantTimeCompare([]byte(req.AdminToken), []byte(api.relay.AdminToken)) != 1 {
		log.Println("fee settings: wrong admin token from", r.RemoteAddr)
		writeJSON(w, http.StatusUnauthorized, makeJsonError("wrong admin token"))
		return
	}

	var fees relay.FeeSettings
	switch {
	case req.Reset && req.Fees == nil:
		fees = api.defaults
	case !req.Reset && req.Fees != nil:
		var err error
		if fees, err = req.Fees.settings(); err == nil {
			err = fees.Validate()
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, makeJsonError(err.Error()))
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, makeJsonError("send either fees or reset"))
		return
	}

	api.mu.Lock()
	var err error
	if req.Reset {
		err = api.store.ClearFees()
	} else {
		err = api.store.SaveFees(fees, time.Now())
	}
	if err == nil {
		err = api.relay.SetFees(fees)
	}
	if err == nil {
		api.saved = !req.Reset
	}
	api.mu.Unlock()
	if err != nil {
		log.Println("fee settings: unable to save:", err)
		writeJSON(w, http.StatusInternalServerError, makeJsonError("unable to save"))
		return
	}
	logFees("fee configuration changed from the status page", fees, req.Reset)
	writeJSON(w, http.StatusOK, api.response())
}

func logFees(prefix string, f relay.FeeSettings, reset bool) {
	suffix := ""
	if reset {
		suffix = " (startup values)"
	}
	log.Printf("%s: base_msat=%d ppm=%d budget_alpha_msat=%d budget_beta_ppm=%d min_budget_msat=%d%s",
		prefix, f.RoutingFeeBaseMsat, f.RoutingFeePPM, f.RoutingBudgetAlpha, f.RoutingBudgetBeta, f.MinFeeBudgetMsat, suffix)
}

// newFeeSettingsAPI takes the relay after flags and environment are applied,
// remembers those values for reset, and then applies fees saved earlier.
func newFeeSettingsAPI(r *relay.Relay, store *relay.EventStore) (*feeSettingsAPI, error) {
	api := &feeSettingsAPI{relay: r, store: store, defaults: r.Fees()}
	saved, ok, err := store.SavedFees()
	if err != nil {
		return nil, err
	}
	if ok {
		if err := r.SetFees(saved); err != nil {
			log.Println("ignoring saved fees:", err)
		} else {
			api.saved = true
		}
	}
	return api, nil
}
