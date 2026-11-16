package main

import (
	_ "embed"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/lnproxy/lnproxy-relay"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

//go:embed status.html
var statusHTML string

var statusTemplate = template.Must(template.New("status").Funcs(template.FuncMap{
	"sat":     func(msat uint64) string { return decimal(msat, 3) },
	"percent": func(ppm uint64) string { return decimal(ppm, 4) },
}).Parse(statusHTML))

// decimal formats n / 10^places with thousands separators and no trailing zeros.
func decimal(n uint64, places int) string {
	scale := uint64(1)
	for i := 0; i < places; i++ {
		scale *= 10
	}
	whole := strconv.FormatUint(n/scale, 10)
	var out []byte
	for i := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, whole[i])
	}
	if frac := n % scale; frac != 0 {
		out = append(out, '.')
		out = append(out, strings.TrimRight(fmt.Sprintf("%0*d", places, frac), "0")...)
	}
	return string(out)
}

type statusPage struct {
	Version       string
	Network       string
	TestNetwork   bool
	PublicURLs    []string
	AdminTokenSet bool
	relay.RelayParameters
}

func newStatusPage(r *relay.Relay, network string, publicURLs string) statusPage {
	page := statusPage{
		Version:         version,
		Network:         strings.TrimSpace(network),
		AdminTokenSet:   r.AdminToken != "",
		RelayParameters: r.RelayParameters,
	}
	switch strings.ToLower(page.Network) {
	case "regtest", "testnet", "testnet4", "signet", "simnet":
		page.TestNetwork = true
	}
	for _, u := range strings.Split(publicURLs, ",") {
		u = strings.TrimSpace(u)
		// Umbrel's placeholders "notyetset.onion" and "not-enabled.onion" are skipped.
		if u != "" && !strings.Contains(u, "notyetset") && !strings.Contains(u, "not-enabled") {
			page.PublicURLs = append(page.PublicURLs, strings.TrimRight(u, "/"))
		}
	}
	return page
}

func statusHandler(page statusPage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:")
		if err := statusTemplate.Execute(w, page); err != nil {
			log.Println("status page error:", err)
		}
	}
}
