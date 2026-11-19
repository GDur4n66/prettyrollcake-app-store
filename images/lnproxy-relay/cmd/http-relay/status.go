package main

import (
	"embed"
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

// The page's scripts. qrcode.js is qrcode-generator 1.4.4 (MIT, Kazuhiko Arase).
//
//go:embed static/qrcode.js static/tool.js static/fees.js
var staticFiles embed.FS

// The status page talks to /spec and /events on this relay and, for a
// Lightning Address, fetches the recipient's LNURL-pay endpoint over HTTPS
// directly from the browser. Nothing else is loaded.
const statusCSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; " +
	"connect-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

func staticHandler() http.Handler {
	files := http.FileServer(http.FS(staticFiles))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/static/" || strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		files.ServeHTTP(w, r)
	})
}

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
	// Filled for each request: fees can change while the relay runs.
	Fees      relay.FeeSettings
	FeesSaved bool
	fees      func() (relay.FeeSettings, bool)
}

func newStatusPage(r *relay.Relay, network string, publicURLs string) statusPage {
	page := statusPage{
		Version:         version,
		Network:         strings.TrimSpace(network),
		AdminTokenSet:   r.AdminToken != "",
		RelayParameters: r.RelayParameters,
		fees:            func() (relay.FeeSettings, bool) { return r.Fees(), false },
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
		w.Header().Set("Content-Security-Policy", statusCSP)
		w.Header().Set("Referrer-Policy", "no-referrer")
		data := page
		data.Fees, data.FeesSaved = page.fees()
		if err := statusTemplate.Execute(w, data); err != nil {
			log.Println("status page error:", err)
		}
	}
}
