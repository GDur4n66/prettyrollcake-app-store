package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/lnproxy/lnproxy-relay"
)

func eventsAPIHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Accept, Last-Event-ID, Authorization")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		http.Error(w, "streaming unavailable", http.StatusInternalServerError)
		return
	}
	initial, events, cancel, err := lnproxy_relay.SubscribeEvents(requestToken(r), r.Header.Get("Last-Event-ID"))
	if errors.Is(err, relay.ErrTokenMissing) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	} else if errors.Is(err, relay.ErrTokenInvalid) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	} else if err != nil {
		log.Println("events subscription error:", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer cancel()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	// Replace the server's absolute 20-second deadline with a per-write
	// deadline so idle streams stay open and slow clients eventually leave.
	write := func(frame string) error {
		if err := controller.SetWriteDeadline(time.Now().Add(20 * time.Second)); err != nil {
			return err
		}
		if _, err := fmt.Fprint(w, frame); err != nil {
			return err
		}
		return controller.Flush()
	}
	writeEvent := func(event relay.InvoiceEvent) error {
		data, err := json.Marshal(event)
		if err != nil {
			return err
		}
		return write(fmt.Sprintf("id: %s\nevent: invoice_state\ndata: %s\n\n", event.ID, data))
	}
	if err := write(": connected\n\n"); err != nil {
		return
	}
	for _, event := range initial {
		if err := writeEvent(event); err != nil {
			return
		}
	}
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := writeEvent(event); err != nil {
				return
			}
		case <-heartbeat.C:
			if err := write(": heartbeat\n\n"); err != nil {
				return
			}
		}
	}
}

// requestToken reads "Authorization: Bearer <token>" (servers) or
// "?token=<token>" (browser EventSource, which cannot set headers).
func requestToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); auth != "" {
		scheme, token, ok := strings.Cut(auth, " ")
		if ok && strings.EqualFold(scheme, "Bearer") {
			return strings.TrimSpace(token)
		}
		return ""
	}
	return r.URL.Query().Get("token")
}
